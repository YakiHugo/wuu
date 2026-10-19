// Shipping main/preload/renderer/Go. An authored loopback provider is the only
// configured model; this never calls a paid service or reads a real profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, webContents, nativeImage } = require('electron');
const desktop = path.resolve(__dirname, '..');
const output = process.env.WUU_CAPSULE_OUTPUT || path.join(desktop, 'out/e2e/context-chat-capsule');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wuu-capsule-'));
const home = path.join(fixture, 'wuu-home'), userHome = path.join(fixture, 'user-home'), project = path.join(fixture, 'project');
for (const directory of [output, home, userHome, project]) fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(fixture, 'profile'));
process.env.WUU_HOME = home; process.env.HOME = userHome; process.env.USERPROFILE = userHome;
process.env.WUU_ENABLE_BROWSER = '1'; process.env.WUU_SAFE_MODE = '1'; process.env.WUU_DESKTOP_DISABLE_DEV_CACHE_CLEANUP = '1';
process.env.WUU_DESKTOP_CORE ||= path.join(desktop, 'build/bin/wuu-core');
delete process.env.ELECTRON_RENDERER_URL;
for (const name of Object.keys(process.env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/.test(name)) delete process.env[name];
const requests = [], checks = [], errors = [], screenshots = [];
let diagnostics;
let main, phase = 'startup';
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/page')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Capsule fixture</title><h1>Visible capsule fixture</h1><p>Visible page reference.</p><input id="page-input" aria-label="Page field"><input type="password" value="secret-password"><textarea>secret-draft</textarea><p hidden>secret-hidden</p><p id="api-token">secret-token</p><p style="display:none">secret-display</p>');
  }
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); }
  let raw = '';
  req.on('data', chunk => raw += chunk); req.on('end', () => {
    const body = JSON.parse(raw); requests.push(body);
    if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'title', choices: [{ index: 0, message: { role: 'assistant', content: 'Capsule page conversation' }, finish_reason: 'stop' }] })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'The page context was received.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (target, fn, value) => target.executeJavaScript(`(${fn})(${JSON.stringify(value)})`, true);
async function until(fn, label = phase) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(30); } throw new Error(`Timed out: ${label}`); }
async function shot(name) {
  // BrowserWindow.capturePage omits WebContentsView children. Capture the real
  // X11 compositor so the fixture website and privileged capsule are visible.
  const bounds = main.getBounds();
  const capture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${bounds.width}x${bounds.height}`,
    '-i', `${process.env.DISPLAY}+${bounds.x},${bounds.y}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { timeout: 12000, maxBuffer: 24 * 1024 * 1024 });
  assert.equal(capture.status, 0, String(capture.stderr || capture.error));
  assert.ok(!nativeImage.createFromBuffer(capture.stdout).isEmpty());
  fs.writeFileSync(path.join(output, `${name}.png`), capture.stdout); screenshots.push(`${name}.png`);
}
const capsuleView = () => main.contentView.children.find(view => view.webContents && !view.webContents.isDestroyed()
  && view.webContents.getURL().endsWith('/chrome-overlay.html?surface=capsule'));
function movePointer(x, y) {
  const moved = spawnSync('xdotool', ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))], { encoding: 'utf8', timeout: 5000 });
  assert.equal(moved.status, 0, moved.stderr || String(moved.error));
}
async function hoverCapsule() {
  const view = await until(() => { const value = capsuleView(); return value?.getVisible() ? value : null; }, 'Native capsule completes its paint handshake');
  const target = view.webContents;
  await until(() => evaluate(target, () => {
    const ball = document.querySelector('.context-chat-capsule-ball'), bounds = ball?.getBoundingClientRect();
    return Boolean(ball && bounds.width > 0 && bounds.height > 0);
  }), 'Native capsule ball is rendered');
  const origin = main.getContentBounds(), bounds = view.getBounds();
  movePointer(origin.x + bounds.x - 30, origin.y + bounds.y + 24);
  await until(() => evaluate(target, () => !document.querySelector('[data-context-capsule]')?.matches(':hover')), 'Pointer leaves capsule before hover');
  const point = await evaluate(target, () => { const rect = document.querySelector('.context-chat-capsule-ball').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  const zoom = target.getZoomFactor(), current = view.getBounds();
  movePointer(origin.x + current.x + point.x * zoom, origin.y + current.y + point.y * zoom);
  // DOM nodes are not serializable IPC results. Return a boolean explicitly.
  await until(() => evaluate(target, () => Boolean(document.querySelector('.context-chat-capsule input'))), 'Hover expands the native capsule input');
  return target;
}
function report(passed) { fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed, phase, checks, errors, screenshots, diagnostics,
  boundary: 'Shipping Electron main/preload/renderer and Go core; disposable profile and local synthetic HTTP model provider. Real X11 pointer input exercises the isolated capsule surface. Screenshots capture the composed native window; they are cloud evidence, not Mac acceptance.', requests: requests.length }, null, 2));
  fs.writeFileSync(path.join(output, 'provider-requests.json'), JSON.stringify(requests, null, 2)); }
const timeout = setTimeout(() => fail(new Error('Capsule acceptance timed out')), 150000);
app.on('browser-window-created', (_event, window) => { main ||= window; });
module.exports = (async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const engines = Object.fromEntries(['codex', 'claude', 'cursor', 'devin', 'dsh', 'grok', 'hermes', 'pi', 'opencode', 'antigravity'].map(id => [id, { enabled: false }]));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ default_provider: 'fixture', engines, providers: { fixture: { type: 'openai-compatible', base_url: `http://127.0.0.1:${port}/v1`, api_key: 'synthetic-not-a-credential', model: 'fixture' } } }));
  const stamp = '2026-01-01T00:00:00Z';
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [{ id: 'repo', name: 'Capsule fixture', path: project, created_at: stamp, updated_at: stamp }], active_context: { kind: 'project', project_id: 'repo', cwd: project } }));
  fs.writeFileSync(path.join(home, 'desktop-settings.json'), JSON.stringify({ onboarding_version: 100, language: 'en-US', theme: 'light' }));
  assert.equal(app.isReady(), false);
  await import(pathToFileURL(path.join(desktop, 'out/main/index.js')).href);
  void run(port).catch(fail);
})().catch(fail);
async function run(port) {
  await until(() => main); main.setSize(1280, 900); main.show(); main.focus();
  await until(() => evaluate(main.webContents, () => Boolean(document.querySelector('[data-context-capsule]'))));
  await shot('01-internal-ball'); checks.push('Internal Wuu view has compact capsule without opening a new conversation.');
  phase = 'hidden-page context boundary';
  const plugin = await evaluate(main.webContents, url => window.wuu.webWorkspace.open({ id: 'capsule-plugin-fixture', url }), `http://127.0.0.1:${port}/page`);
  assert.equal(typeof plugin.activeTabId, 'string', 'Non-tabbed plugin pages expose their stable browser target.');
  const hiddenRead = await evaluate(main.webContents, async id => {
    try { await window.wuu.readPageContext('capsule-plugin-fixture', id); return true; } catch { return false; }
  }, plugin.activeTabId);
  assert.equal(hiddenRead, false, 'Hidden pages cannot be included by the capsule.');
  await evaluate(main.webContents, () => window.wuu.webWorkspace.close('capsule-plugin-fixture'));
  checks.push('Plugin website snapshots expose a stable page ID and hidden page context is denied.');
  phase = 'native website and capsule readiness';
  const state = await evaluate(main.webContents, url => window.wuu.webWorkspace.createTab('ribbon-browser', url), `http://127.0.0.1:${port}/page?token=secret-url#secret-fragment`);
  const tabId = state.activeTabId;
  await until(() => evaluate(main.webContents, id => Boolean(document.querySelector(`[data-ribbon-id="${id}"]`)), tabId));
  await evaluate(main.webContents, id => document.querySelector(`[data-ribbon-id="${id}"]`).click(), tabId);
  const page = await until(() => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(`http://127.0.0.1:${port}/page`)));
  await until(() => evaluate(page, () => Boolean(document.querySelector('#page-input'))));
  await until(() => main.contentView.children.some(view => view.webContents === page && view.getVisible()), 'Fixture page has visible native ownership');
  await evaluate(page, () => document.querySelector('#page-input').focus()); page.focus();
  await until(() => page.isFocused(), 'Fixture page owns keyboard focus before hover');
  const focusedBefore = page.isFocused();
  const native = await hoverCapsule();
  assert.equal(page.isFocused(), focusedBefore, 'hover must not steal keyboard focus');
  await shot('02-native-hover');
  await evaluate(native, () => document.querySelector('input').focus()); native.focus();
  await native.insertText('Explain this page');
  native.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); native.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(() => evaluate(native, () => !document.querySelector('input')));
  await hoverCapsule();
  assert.equal(await evaluate(native, () => document.querySelector('input').value), 'Explain this page');
  checks.push('Native hover preserves page focus; Escape collapses without discarding a draft.');
  const context = await evaluate(main.webContents, id => window.wuu.readPageContext('ribbon-browser', id), tabId);
  assert.match(context.text, /Visible page reference/); assert.ok(!JSON.stringify(context).includes('secret-'));
  assert.ok(context.pageId.endsWith(tabId)); assert.ok(!context.url.includes('?') && !context.url.includes('#'));
  await shot('03-native-draft');
  phase = 'send normal chat';
  await evaluate(native, () => document.querySelector('form').requestSubmit());
  const thread = await until(() => evaluate(main.webContents, async () => (await window.wuu.listThreads()).threads.find(thread => !thread.ephemeral)));
  await until(() => requests.some(body => body.tools?.length && JSON.stringify(body.messages).includes('Explain this page')));
  await until(() => evaluate(main.webContents, async id => (await window.wuu.resumeThread(id)).thread.turns.some(turn => turn.status === 'completed'), thread.id));
  assert.equal(await evaluate(main.webContents, () => document.querySelector('.web-workspace-stage')?.hidden), false);
  const request = requests.find(body => body.tools?.length && JSON.stringify(body.messages).includes('Explain this page'));
  assert.ok(JSON.stringify(request.messages).includes(context.pageId));
  assert.ok(!JSON.stringify(request.messages).includes('secret-'));
  checks.push('Send uses production startThread/startTurn and exact bounded page reference; the normal Chat session persists while the source website remains visible.');
  await until(() => evaluate(native, () => Boolean(document.querySelector('.context-chat-capsule-status button'))));
  await shot('04-chat-created');
  await evaluate(native, () => document.querySelector('input').focus()); await native.insertText('Continue this same page');
  await evaluate(native, () => document.querySelector('form').requestSubmit());
  await until(() => evaluate(main.webContents, async id => (await window.wuu.resumeThread(id)).thread.turns.filter(turn => turn.status === 'completed').length >= 2, thread.id));
  assert.equal((await evaluate(main.webContents, async () => (await window.wuu.listThreads()).threads)).length, 1);
  checks.push('Second send reuses the ordinary conversation, without creating a parallel chat backend.');
  await evaluate(native, () => document.querySelector('.context-chat-capsule-status button').click());
  await until(() => evaluate(main.webContents, () => document.querySelector('.web-workspace-stage')?.hidden));
  await shot('05-open-chat'); checks.push('Open chat navigates explicitly to the conversation.');
  phase = 'complete'; report(true); clearTimeout(timeout); server.close(); app.quit();
}
async function fail(error) {
  errors.push(error.stack || String(error)); console.error(error);
  if (main && !main.isDestroyed()) {
    diagnostics = { ownerVisible: main.isVisible(), ownerFocused: main.isFocused(), views: main.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed())
      .map(view => ({ url: view.webContents.getURL(), visible: view.getVisible(), focused: view.webContents.isFocused(), bounds: view.getBounds() })) };
    try { diagnostics.capsule = await evaluate(capsuleView().webContents, () => ({ html: document.querySelector('#root')?.innerHTML.slice(0, 4000), focused: document.hasFocus(), active: document.activeElement?.outerHTML.slice(0, 300) })); } catch {}
    try { await shot('failure'); } catch (captureError) { errors.push(`Failure screenshot: ${captureError}`); }
  }
  report(false); clearTimeout(timeout); server.close(); app.exit(1);
}
