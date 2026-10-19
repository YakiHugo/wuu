// Failure contracts: pruning must not remove runtime entrypoints, native PTY,
// updater dependencies, lazy renderer chunks, or workers. Real UI rendering and
// IPC must work from an isolated packaged app, without a development server.
// Usage (Node 22+): node scripts/packaged-runtime-smoke.cjs /path/to/wuu.app [evidence-directory]
// Release-configured apps must initialize the updater. Ad-hoc apps must report
// unsupported; their dependency loading is checked, not update availability.
// Add --artifact-only to verify the archive without launching the application.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const asar = require("@electron/asar");

function verifyResources(resources) {
  const archive = path.join(resources, "app.asar");
  const entries = asar.listPackage(archive).map(file => file.replace(/^[/\\]/, "").replaceAll("\\", "/"));
  const has = file => entries.includes(file);
  assert.ok(!entries.some(file => /\.(?:[cm]?js|css)\.map$/i.test(file)), "JavaScript/CSS sourcemaps must not ship");
  const manifest = JSON.parse(asar.extractFile(archive, "package.json"));
  assert.ok(manifest.main && has(manifest.main.replace(/^\.\//, "")), "Missing packaged main entrypoint");
  for (const file of ["out/preload/index.cjs", "out/renderer/index.html", "node_modules/node-pty/package.json", "node_modules/electron-updater/package.json"]) {
    assert.ok(has(file), `Missing packaged runtime file: ${file}`);
  }
  for (const name of ["monaco-editor", "pdfjs-dist", "mermaid", "pele"]) {
    assert.ok(!entries.some(file => file === `node_modules/${name}` || file.startsWith(`node_modules/${name}/`)), `Renderer-only raw package remains: ${name}`);
    assert.ok(!fs.existsSync(path.join(resources, "app.asar.unpacked/node_modules", name)), `Unpacked renderer-only raw package remains: ${name}`);
  }
  const notice = asar.extractFile(archive, "out/renderer/THIRD-PARTY-LICENSES.txt").toString("utf8");
  for (const name of ["monaco-editor", "pdfjs-dist", "pele", "blobatar"]) {
    assert.ok(notice.includes(`${name}@`), `Missing bundled renderer license section: ${name}`);
  }
  const workers = {};
  for (const name of ["editor.worker", "ts.worker", "pdf.worker"]) {
    const files = entries.filter(file => file.startsWith("out/renderer/assets/") && path.basename(file).startsWith(name) && /\.(?:m?js)$/.test(file));
    assert.ok(files.length, `Missing bundled ${name}`);
    for (const file of files) assert.ok(asar.extractFile(archive, file).length > 0, `Empty worker: ${file}`);
    workers[name] = files;
  }
  const bindings = entries.filter(file => /node_modules\/node-pty\/.*\.node$/.test(file));
  assert.ok(bindings.length, "Missing packaged native PTY binding");
  for (const file of bindings) {
    assert.ok(asar.statFile(archive, file).unpacked, `Native binding must be unpacked: ${file}`);
    assert.ok(fs.statSync(path.join(`${archive}.unpacked`, file)).size > 0, `Missing unpacked native binding: ${file}`);
  }
  const core = path.join(resources, "bin", fs.existsSync(path.join(resources, "bin/wuu-core.exe")) ? "wuu-core.exe" : "wuu-core");
  assert.ok(fs.statSync(core).size > 0, "Missing packaged core binary");
  return { version: manifest.version, archiveSHA256: createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), workers, entryCount: entries.length };
}

function verifyArtifact(app) {
  return verifyResources(path.join(app, "Contents/Resources"));
}

function makePDF() {
  const content = "BT /F1 20 Tf 20 100 Td (Packaged PDF smoke) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--artifact-only");
  assert.ok(args[0], "Pass the packaged .app path explicitly");
  const app = fs.realpathSync(path.resolve(args[0]));
  const output = path.resolve(args[1] || "packaged-smoke-evidence");
  fs.mkdirSync(output, { recursive: true });
  const result = { artifact: verifyArtifact(app), checks: {}, passed: false };
  fs.writeFileSync(path.join(output, "artifact.json"), JSON.stringify(result.artifact, null, 2));
  if (process.argv.includes("--artifact-only")) { console.log("PASS: packaged artifact inventory"); return; }
  assert.equal(process.platform, "darwin", "Runtime smoke requires macOS and a graphical login session");
  const updaterConfigured = fs.existsSync(path.join(app, "Contents/Resources/app-update.yml"));
  result.updaterConfigured = updaterConfigured;
  assert.equal(typeof WebSocket, "function", "Use Node 22+ for the CDP WebSocket client");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wuu-packaged-smoke-"));
  const home = path.join(scratch, "home");
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "smoke.ts"), 'const packagedSmoke: number = "intentional type error";\nconsole.log(packagedSmoke);\n');
  fs.writeFileSync(path.join(workspace, "smoke.pdf"), makePDF());
  fs.writeFileSync(path.join(workspace, "smoke.md"), '# Packaged renderer\n\n```mermaid\nflowchart LR\n A[Packaged] --> B[Rendered]\n```\n');
  // Copy the signed package without rebuilding it; launch away from the checkout.
  const copy = path.join(scratch, "wuu.app");
  execFileSync("ditto", [app, copy]);
  const executable = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", path.join(copy, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  // Do not inherit development entrypoints, module search paths, or credentials.
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, USER: process.env.USER || "smoke", TMPDIR: scratch, SHELL: "/bin/sh", LANG: "en_US.UTF-8", WUU_HOME: path.join(home, ".wuu"), CODEX_HOME: path.join(home, ".codex"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache") };
  const child = spawn(path.join(copy, "Contents/MacOS", executable), [`--user-data-dir=${path.join(home, "profile")}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", data => { log += data; });
  child.stderr.on("data", data => { log += data; });
  let launchError;
  child.on("error", error => { launchError = error; });
  let socket;
  let captureScreenshot;
  const protocolEvents = [];
  try {
    async function until(read, label, timeout = 45000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        assert.equal(child.exitCode, null, `Packaged application exited: ${log}`);
        const value = await read();
        if (value) return value;
        await delay(100);
      }
      throw new Error(`Timed out: ${label}`);
    }
    const page = await until(async () => {
      try {
        const pages = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(response => response.json());
        return pages.find(page => page.type === "page" && page.url.startsWith("file:") && page.url.includes("app.asar/out/renderer/index.html"));
      } catch { return null; }
    }, "packaged renderer debugging target");
    assert.ok(decodeURIComponent(page.url).includes(copy), "Renderer must come from the isolated package");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await Promise.race([once(socket, "open"), delay(10000).then(() => { throw new Error("CDP socket did not open"); })]);
    let nextID = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const response = JSON.parse(data);
      if (!response.id) { if (/exceptionThrown|loadingFailed|targetCreated/.test(response.method)) protocolEvents.push(response); return; }
      const callback = pending.get(response.id);
      if (callback) { pending.delete(response.id); response.error ? callback.reject(new Error(JSON.stringify(response.error))) : callback.resolve(response.result); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextID;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (fn, arg) => {
      const response = await send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})`, awaitPromise: true, returnByValue: true });
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Target.setDiscoverTargets", { discover: true });
    const screenshot = captureScreenshot = async name => fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await until(() => evaluate(() => Boolean(window.wuu)), "real packaged preload");
    result.checks.core = await evaluate(async workspace => {
      await window.wuu.initialize();
      await window.wuu.completeOnboarding();
      const selected = await window.wuu.selectNoProject(false, workspace);
      if (selected.active_context?.cwd !== workspace) throw new Error("Fixture workspace was not selected");
      return { build: await window.wuu.getBuildInfo(), updater: await window.wuu.getDesktopUpdateState() };
    }, workspace);
    assert.equal(result.checks.core.build.desktop.version, result.artifact.version);
    assert.ok(result.checks.core.build.core.version, "Packaged core must answer build-info");
    if (updaterConfigured) {
      assert.ok(["idle", "checking", "available"].includes(result.checks.core.updater.kind),
        `Release-configured macOS updater must initialize: ${JSON.stringify(result.checks.core.updater)}`);
      result.checks.updater = "Release-configured controller initialized; no explicit update check or download requested";
    } else {
      assert.equal(result.checks.core.updater.kind, "unsupported", "Ad-hoc package without app-update.yml must disable updates");
      result.checks.updater = "Dependency loaded by packaged main; controller disabled because app-update.yml is absent; update availability not verified";
    }
    await send("Page.reload");
    await until(() => evaluate(() => Boolean(document.querySelector(".workspace-panel-add"))), "application workspace UI after onboarding");
    result.checks.terminal = await evaluate(async workspace => {
      let terminal;
      let text = "";
      let resolveOutput;
      const output = new Promise(resolve => { resolveOutput = resolve; });
      const unsubscribe = window.wuu.onTerminalEvent(event => {
        if (event.type === "data" && event.id === terminal?.id) {
          text += event.text;
          if (text.includes("PACKAGED_PTY_OK")) resolveOutput(text);
        }
      });
      try {
        terminal = await window.wuu.startTerminalSession({ cwd: workspace, cols: 80, rows: 24 });
        // Split the marker so terminal echo alone cannot satisfy the assertion.
        await window.wuu.writeTerminalSession(terminal.id, "printf 'PACKAGED_%s_OK\\n' PTY\n");
        return await Promise.race([output, new Promise((_, reject) => setTimeout(() => reject(new Error("Native PTY produced no marker")), 10000))]);
      } finally { unsubscribe(); if (terminal) await window.wuu.stopTerminalSession(terminal.id); }
    }, workspace);
    async function openFile(name) {
      await evaluate(() => {
        if (document.querySelector(".workspace-right-panel")?.getAttribute("aria-hidden") !== "false") {
          [...document.querySelectorAll(".side-panel-toggle-button")].find(button => /right sidebar|右侧栏/i.test(button.getAttribute("aria-label") || ""))?.click();
        }
      });
      await until(() => evaluate(() => Boolean(document.querySelector(".workspace-panel-add"))), "Files panel add button");
      await evaluate(() => document.querySelector(".workspace-panel-add").click());
      await until(() => evaluate(() => Boolean(document.querySelector('[data-wuu-tool="files"]'))), "Files menu");
      await evaluate(() => document.querySelector('[data-wuu-tool="files"]').click());
      await until(() => evaluate(name => Boolean(document.querySelector("file-tree-container")?.shadowRoot?.querySelector(`[data-item-path="${name}"]`)), name), `${name} in fixture tree`);
      await evaluate(name => document.querySelector("file-tree-container").shadowRoot.querySelector(`[data-item-path="${name}"]`).click(), name);
    }
    async function worker(name) {
      const targets = (await send("Target.getTargets")).targetInfos;
      for (const target of targets.filter(target => target.type === "worker")) {
        if (target.url.includes(name) && decodeURIComponent(target.url).includes(copy)) return target;
        // PDF.js wraps file: imports in blob: module workers (opaque origin).
        if (target.url.startsWith("blob:")) {
          const wrapper = await evaluate(async url => {
            try { return await (await fetch(url)).text(); } catch { return ""; }
          }, target.url);
          if (wrapper.includes(name) && decodeURIComponent(wrapper).includes(copy)) return { ...target, wrapper };
        }
      }
      return null;
    }
    await openFile("smoke.ts");
    await until(() => evaluate(() => Boolean(document.querySelector(".monaco-editor .view-lines")?.textContent.includes("packagedSmoke"))), "real Monaco editor text");
    result.checks.typescriptWorker = await until(() => worker("ts.worker"), "packaged TypeScript worker");
    // Read-only previews suppress inline validation decorations. F8 still opens
    // Monaco's real problem navigator, proving a semantic worker response.
    await evaluate(() => document.querySelector(".monaco-editor textarea").focus());
    await until(async () => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "F8", code: "F8", windowsVirtualKeyCode: 119 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "F8", code: "F8", windowsVirtualKeyCode: 119 });
      return evaluate(() => /not assignable to type/.test(document.querySelector(".monaco-editor .message")?.textContent || ""));
    }, "TypeScript worker semantic diagnostic");
    await screenshot("monaco-typescript");
    await openFile("smoke.pdf");
    await until(() => evaluate(() => {
      const root = document.querySelector("[data-workspace-pdf-preview]")?.shadowRoot;
      const canvas = root?.querySelector("canvas");
      return Boolean(canvas?.width && canvas?.height && root.querySelector(".textLayer")?.textContent.includes("Packaged PDF smoke"));
    }), "PDF page canvas and extracted text");
    result.checks.pdfWorker = await until(() => worker("pdf.worker"), "real packaged PDF worker (no fake-worker fallback)");
    await screenshot("pdf");
    await openFile("smoke.md");
    await until(() => evaluate(() => Boolean(document.querySelector('.rich-mermaid[data-mermaid-state="rendered"] svg') || document.querySelector(".rich-mermaid-diagram svg"))), "Mermaid SVG diagram");
    result.checks.mermaid = await evaluate(() => document.querySelector(".rich-mermaid-diagram")?.textContent);
    assert.match(result.checks.mermaid, /Packaged/);
    assert.match(result.checks.mermaid, /Rendered/);
    await screenshot("mermaid");
    result.passed = true;
    console.log(`PASS: isolated packaged core, PTY, Monaco/TS, PDF worker and Mermaid; evidence: ${output}`);
    console.log(`Updater: ${result.checks.updater}`);
  } catch (error) {
    result.error = error.stack;
    try { await captureScreenshot?.("failure"); } catch { /* Preserve the original failure if Chromium is gone. */ }
    throw error;
  } finally {
    socket?.close();
    child.kill("SIGTERM");
    if (child.exitCode === null && !launchError) await Promise.race([once(child, "exit"), delay(5000).then(() => child.kill("SIGKILL"))]);
    fs.writeFileSync(path.join(output, "app.log"), log);
    fs.writeFileSync(path.join(output, "protocol-events.json"), JSON.stringify(protocolEvents, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifyArtifact, verifyResources };
