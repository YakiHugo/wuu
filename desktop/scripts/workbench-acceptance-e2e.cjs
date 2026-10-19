// Shipping Electron/main/preload/Go acceptance with a disposable profile.
// Build with npm run build:core and electron-vite build, then run under Xvfb:
//   electron --no-sandbox scripts/workbench-acceptance-e2e.cjs
// The companion workflow records the entire X11 display, including the real
// Electron window and native pointer. PNGs and layout data accompany every
// meaningful click. No CSS substitutes, paid inference or live credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, ipcMain } = require('electron');
const { validateCorpus } = require('./conversation-corpus.cjs');

const desktop = path.resolve(__dirname, '..');
const output = path.resolve(process.env.WUU_WORKBENCH_OUTPUT || path.join(desktop, 'out/e2e/workbench-acceptance'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wuu-workbench-acceptance-'));
const home = path.join(fixture, 'wuu-home');
const project = path.join(fixture, 'acceptance-project');
for (const dir of [output, home, project]) fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(fixture, 'profile'));
process.env.HOME = path.join(fixture, 'user-home');
process.env.USERPROFILE = process.env.HOME;
process.env.CODEX_HOME = path.join(process.env.HOME, '.codex');
process.env.GROK_HOME = path.join(process.env.HOME, '.grok');
process.env.XDG_CONFIG_HOME = path.join(fixture, 'xdg-config');
process.env.XDG_DATA_HOME = path.join(fixture, 'xdg-data');
fs.mkdirSync(process.env.HOME);
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/.test(name)) delete process.env[name];
}
process.env.WUU_HOME = home;
process.env.WUU_DESKTOP_CORE = path.resolve(process.env.WUU_DESKTOP_CORE || path.join(desktop, 'build/bin/wuu-core'));
process.env.WUU_SAFE_MODE = '1';
process.env.WUU_ENABLE_BROWSER = '0';
process.env.WUU_DESKTOP_DISABLE_DEV_CACHE_CLEANUP = '1';
delete process.env.ELECTRON_RENDERER_URL;

const source = path.join(__dirname, 'fixtures/conversation-corpus/corpus.json');
const corpusBytes = fs.readFileSync(source);
const corpus = validateCorpus(JSON.parse(corpusBytes));
const sample = corpus.samples[0];
const longSample = [...corpus.samples].sort((a, b) => b.steps.at(-1).text.length - a.steps.at(-1).text.length)[0];
const sessions = [
  { id: 'acceptance-reading', title: 'Layout acceptance: long reading', turns: 16, text: longSample.steps.at(-1).text },
  { id: 'acceptance-second', title: 'Layout acceptance: second conversation', turns: 2, text: sample.steps.at(-1).text },
  { id: 'acceptance-empty', title: 'Layout acceptance: empty conversation', turns: 0, text: '' },
];
const stamp = '2026-01-01T00:00:00Z';
fs.writeFileSync(path.join(project, 'README.md'), '# Acceptance project\n\nSynthetic file preview.\n');
fs.writeFileSync(path.join(project, 'example.ts'), 'export const greeting = "Hello, Wuu";\n');
const skillDir = path.join(project, '.agents/skills/acceptance-skill');
const pluginDir = path.join(home, 'plugins/acceptance-plugin');
fs.mkdirSync(skillDir, { recursive: true }); fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: acceptance-skill\ndescription: Synthetic acceptance preview\n---\n# Acceptance preview\n\nThis is a read-only synthetic skill preview.\n');
// A manifest-only package exercises inventory and details without loading code.
fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ schema_version: 1, id: 'acceptance-plugin', name: 'Acceptance Plugin', description: 'Synthetic manifest-only acceptance package' }));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  default_provider: 'fixture',
  providers: { fixture: { type: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', api_key: 'synthetic-not-a-credential', model: 'fixture' } },
  engines: Object.fromEntries(['codex', 'claude', 'cursor', 'devin', 'dsh', 'grok', 'hermes', 'pi', 'opencode', 'antigravity'].map(id => [id, { enabled: false }])),
}));
fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
  projects: [{ id: 'acceptance-project', name: 'Acceptance project', path: project, created_at: stamp, updated_at: stamp }],
  active_context: { kind: 'project', project_id: 'acceptance-project', cwd: project },
}));
fs.writeFileSync(path.join(home, 'desktop-settings.json'), JSON.stringify({
  onboarding_version: 100, language: 'en-US', theme: 'light', message_flow_font_size: 15,
}));

const report = {
  status: 'running', startedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8' }).stdout.trim(),
  versions: { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform },
  fixture: { corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'), noInference: true, isolatedHome: true, safeMode: true },
  checks: [], screenshots: [], actions: [], errors: [],
  exclusions: ['Native macOS traffic lights (Linux capture)', 'Live provider/account authentication',
    'Third-party plugin replacement/unload and dynamic plugin settings (safe-mode fixture)', 'Native browser PiP (browser integration disabled)'],
};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
const rpc = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
  // Guard the real bridge rather than replacing its result. An accidental Enter
  // in the composer must fail acceptance before an inference request can start.
  if (['wuu:turn-start', 'wuu:turn-queue', 'wuu:turn-steer'].includes(channel)) {
    report.errors.push({ kind: 'inference-guard', channel });
    throw new Error(`Acceptance must never invoke inference: ${channel}`);
  }
  const entry = { channel, completed: false, ...(channel === 'wuu:browser-pip-host-layout' ? { payload: args[1] } : {}) };
  rpc.push(entry);
  try { const value = await handler(...args); entry.completed = true; return value; }
  catch (error) { entry.error = String(error); throw error; }
});
let win;
app.on('browser-window-created', (_event, window) => {
  win ||= window;
  window.webContents.on('console-message', event => {
    if (event.level === 'error' && !/Autofill/.test(event.message)) report.errors.push({ kind: 'console', message: event.message });
  });
  window.webContents.on('render-process-gone', (_event, details) => report.errors.push({ kind: 'renderer', ...details }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(fn, arg) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    try { return { value: await (${fn})(${JSON.stringify(arg)}) }; }
    catch (error) { return { error: String(error.stack || error) }; }
  })()`);
  if (result.error) throw new Error(result.error);
  return result.value;
}
async function waitFor(fn, arg, label = String(fn), timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(fn, arg);
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function settle() {
  await evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const animations = document.getAnimations().filter(a => a.playState === 'running'
      && Number.isFinite(a.effect.getComputedTiming().endTime)
      && !(a.effect.target instanceof Element && a.effect.target.closest('[inert]')));
    await Promise.race([Promise.all(animations.map(a => a.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 1000))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
const activePane = '.cached-conversation-pane[data-active="true"]';
const composer = '.conversation-pane .composer textarea';
const scroller = '.conversation-pane > .scroll-region';
const conversations = '[data-wuu-component="conversations-section"]';
const settings = '.sidebar-ribbon button[aria-label="Settings"]';
const plugins = '.sidebar-ribbon button[aria-label="Plugins"]';
const leftToggle = '.section-sidebar-toggle';
const rightToggle = '.shell-right-sidebar-toggle';
function pick(selector, text) { return { selector, text }; }
async function point(target, scroll = true) {
  return evaluate(async ({ selector, text, scroll }) => {
    const nodes = [...document.querySelectorAll(selector)];
    const node = nodes.find(n => (text === undefined || (n.getAttribute('aria-label') || n.textContent || '').trim() === text)
      && n.getBoundingClientRect().width > 0 && !n.closest('[inert]'));
    if (!node) throw new Error(`Missing interactive target: ${selector} / ${text}`);
    if (scroll) node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const r = node.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (r.width < 1 || r.height < 1 || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !node.contains(hit)) {
      throw new Error(`Occluded target ${selector}: ${JSON.stringify({ rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 260) })}`);
    }
    if (node.disabled) throw new Error(`Disabled target: ${selector}`);
    return { x, y, rect: r.toJSON(), name: node.getAttribute('aria-label') || node.textContent?.trim() };
  }, { ...(typeof target === 'string' ? { selector: target } : target), scroll });
}
async function capture(label) {
  await settle();
  const name = `${String(report.screenshots.length + 1).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 90)}.png`;
  const screenshot = await win.webContents.capturePage();
  const png = screenshot.toPNG();
  fs.writeFileSync(path.join(output, name), png);
  report.screenshots.push({ file: name, sha256: createHash('sha256').update(png).digest('hex'), atMs: Date.now() - started, image: screenshot.getSize(), window: win.getBounds(),
    viewport: await evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      uiSize: getComputedStyle(document.documentElement).getPropertyValue('--conversation-message-font-size').trim(),
      activeElement: document.activeElement?.outerHTML.slice(0, 180) })) });
  save();
  // A short viewing hold makes the real-time recording readable; success is
  // always decided by observable state, never by this pacing delay.
  await delay(160);
}
async function click(target, label, evidence = true) {
  const p = await point(target);
  if (evidence) await capture(`before-${label}`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: p.x, y: p.y });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: p.x, y: p.y });
  report.actions.push({ label, atMs: Date.now() - started, point: p });
  await settle();
  if (evidence) await capture(`after-${label}`);
}
async function fill(target, text) {
  await click(target, 'focus-input', false);
  key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
  if (text) await win.webContents.insertText(text); else key('Backspace');
  const selector = typeof target === 'string' ? target : target.selector;
  await waitFor(({ selector, text }) => [...document.querySelectorAll(selector)].some(n => n === document.activeElement && n.value === text), { selector, text });
}
async function test(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - start, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Date.now() - start, error: String(error.stack || error) });
    console.error(`FAIL ${name}: ${error.stack || error}`);
    try { await capture(`failure-${name}`); } catch (captureError) { report.errors.push({ kind: 'capture', message: String(captureError) }); }
  }
  save();
}
async function goConversations() {
  key('Escape');
  await click(conversations, 'conversations');
  await waitFor(() => !document.querySelector('.settings-workbench-layer') && !document.querySelector('.catalog-section-pane:not([hidden])'));
}
async function goSettings(pageLabel) {
  await click(settings, 'settings');
  await waitFor(() => document.querySelector('.settings-embedded'));
  if (pageLabel) await click(pick('.settings-nav-item', pageLabel), `settings-${pageLabel}`);
}
async function dockSidebar() {
  if (await evaluate(() => document.querySelector('.app-shell').classList.contains('sidebar-collapsed'))) {
    await click(leftToggle, 'dock-left-sidebar');
  }
  await waitFor(() => !document.querySelector('.app-shell').classList.contains('sidebar-collapsed'));
}
async function selectThread(id) {
  await goConversations();
  await dockSidebar();
  const title = sessions.find(s => s.id === id).title;
  const exists = await evaluate(title => [...document.querySelectorAll('.thread-row-main')].some(n => (n.getAttribute('aria-label') || n.textContent).includes(title)), title);
  if (!exists) {
    const collapsed = await evaluate(() => document.querySelector('.project-row[aria-expanded="false"]') !== null);
    if (collapsed) await click('.project-row[aria-expanded="false"]', 'expand-project');
  }
  const target = await evaluate(title => [...document.querySelectorAll('.thread-row-main')].find(n => (n.getAttribute('aria-label') || n.textContent).includes(title))?.getAttribute('aria-label'), title);
  assert.ok(target, `Thread ${id} appears in the real sidebar`);
  await click(pick('.thread-row-main', target), `open-${id}`);
  await waitFor(({ id, title }) => id === 'acceptance-empty'
    ? !!document.querySelector('.empty-scroll-region') && [...document.querySelectorAll('.thread-row.active')].some(n => n.textContent.includes(title))
    : document.querySelector('.cached-conversation-pane[data-active="true"]')?.dataset.threadId === id, { id, title });
}
async function geometry(label) {
  const g = await evaluate(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
    const shell = document.querySelector('.app-shell');
    const surface = getComputedStyle(shell, '::before');
    const ribbon = rect('.sidebar-ribbon');
    const settings = !!document.querySelector('.settings-embedded');
    const context = rect(settings ? '.settings-sidebar' : '.sidebar > .sidebar-content');
    const main = rect(settings ? '.settings-main' : '.conversation-pane');
    const chrome = rect('.workbench-window-chrome');
    const controls = ['.section-sidebar-toggle', '.shell-right-sidebar-toggle'].map(selector => {
      const node = document.querySelector(selector), r = node.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { selector, rect: r.toJSON(), visible: getComputedStyle(node).visibility === 'visible', hit: node.contains(document.elementFromPoint(x, y)) };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth - innerWidth,
      settings, collapsed: shell.classList.contains('sidebar-collapsed'), ribbon, context, main, chrome, controls,
      surface: { content: surface.content, radius: surface.borderTopLeftRadius, top: parseFloat(surface.top), left: parseFloat(surface.left),
        right: parseFloat(surface.right), bottom: parseFloat(surface.bottom) } };
  });
  assert.ok(g.ribbon && g.context && g.main && g.chrome, `${label}: all workbench regions render`);
  assert.ok(g.overflow <= 1, `${label}: page overflows horizontally by ${g.overflow}px`);
  assert.ok(g.surface.content !== 'none' && parseFloat(g.surface.radius) > 0, `${label}: shared rounded workbench surface exists`);
  assert.ok(Math.abs(g.surface.left - g.ribbon.right) <= 2, `${label}: shared surface begins after the ribbon`);
  assert.ok(Math.abs(g.surface.top - g.chrome.bottom) <= 2, `${label}: shared surface begins below native window chrome`);
  assert.ok(Math.abs(g.context.y - g.main.y) <= 2, `${label}: contextual sidebar and main content share their top edge`);
  assert.ok(g.main.right <= g.viewport.width + 1 && g.main.bottom <= g.viewport.height + 1, `${label}: main panel fits the window`);
  assert.ok(g.controls.filter(c => !g.settings || c.selector === '.section-sidebar-toggle').every(c => c.visible && c.hit), `${label}: native caption/chrome or an overlay blocks a sidebar toggle`);
  return g;
}
async function appearance(theme, size, width) {
  win.setContentSize(width, 900);
  await goSettings('Appearance');
  await click(`[data-testid="settings-theme-${theme}"]`, `theme-${theme}`, false);
  await fill('[data-testid="settings-message-flow-font-size-input"]', String(size));
  key('Enter');
  await waitFor(({ theme, size }) => document.documentElement.dataset.theme === theme
    && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--conversation-message-font-size')) === size, { theme, size });
  await settle();
}
const started = Date.now();
const watchdog = setTimeout(() => { report.status = 'timed-out'; save(); app.exit(1); }, 480000);
async function run() {
  for (const file of [process.env.WUU_DESKTOP_CORE, path.join(desktop, 'out/main/index.js'), path.join(desktop, 'out/preload/index.cjs'), path.join(desktop, 'out/renderer/index.html')]) {
    assert.ok(fs.existsSync(file), `Build required: ${file}`);
  }
  report.buildSha256 = Object.fromEntries(['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(path.join(desktop, file))).digest('hex')]));
  const boot = spawnSync(process.env.WUU_DESKTOP_CORE, ['app-server', '--safe-mode', '--workdir', project], {
    env: process.env, input: '{"jsonrpc":"2.0","id":1,"method":"thread/start","params":{}}\n', encoding: 'utf8', timeout: 30000,
  });
  assert.equal(boot.status, 0, boot.stderr || String(boot.error));
  const seed = spawnSync('python3', ['-c', `
import json, sqlite3, sys
from pathlib import Path
home=Path(sys.argv[1]); project=sys.argv[2]
db=sqlite3.connect(home/'sessions/sessions.sqlite3')
db.execute('DELETE FROM session_messages'); db.execute('DELETE FROM sessions')
for s in json.loads(sys.argv[3]):
    db.execute('INSERT INTO sessions (id,created_at,updated_at,title,cwd,workspace_id,provider,model,entries) VALUES (?,?,?,?,?,?,?,?,?)', (s['id'],'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',s['title'],project,'acceptance-project','fixture','fixture',s['turns']*2))
    for turn in range(s['turns']):
        for role,text in [('user','Synthetic acceptance question '+str(turn+1)),('assistant',s['text'])]:
            seq=turn*2+(1 if role=='user' else 2)
            db.execute('INSERT INTO session_messages (session_id,seq,role,content,at,phase) VALUES (?,?,?,?,?,?)', (s['id'],seq,role,text,'2026-01-01T00:00:00Z',''))
db.commit()
`, home, project, JSON.stringify(sessions)], { encoding: 'utf8', timeout: 30000 });
  assert.equal(seed.status, 0, seed.stderr || String(seed.error));
  await import(pathToFileURL(path.join(desktop, 'out/main/index.js')).href);
  const until = Date.now() + 30000;
  while (!win && Date.now() < until) await delay(40);
  assert.ok(win, 'Production main created its window');
  win.setPosition(30, 30); win.setContentSize(1280, 900); win.show(); win.focus();
  win.webContents.setBackgroundThrottling(false);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Runtime.enable');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') report.errors.push({ kind: 'exception', detail: params.exceptionDetails });
  });
  await waitFor(() => window.wuu && document.querySelector('.composer textarea') && document.querySelector('.sidebar-ribbon'), undefined, 'shipping app ready', 30000);
  await capture('initial-shipping-window');

  await test('shared workbench and contextual navigation', async () => {
    await selectThread('acceptance-reading');
    const reading = await geometry('conversations');
    await click(plugins, 'plugins');
    await waitFor(() => document.querySelector('.skills-catalog'));
    assert.equal(await evaluate(() => document.querySelectorAll('.sidebar-section-item').length), 2);
    await click(pick('.sidebar-section-item', 'Skills'), 'skills-context');
    await waitFor(() => document.querySelector('.catalog-tab[data-tab="skills"]')?.getAttribute('aria-selected') === 'true');
    await click(pick('.sidebar-section-item', 'Plugins'), 'plugins-context');
    await waitFor(() => document.querySelector('.catalog-tab[data-tab="plugins"]')?.getAttribute('aria-selected') === 'true');
    const catalog = await geometry('catalog');
    await goSettings('Appearance');
    const settings = await geometry('settings');
    await goConversations();
    assert.equal(await evaluate(() => document.querySelector('.cached-conversation-pane[data-active="true"]')?.dataset.threadId), 'acceptance-reading');
    return { reading, catalog, settings };
  });

  await test('production PiP host IPC suspends beneath Settings and catalog', async () => {
    await selectThread('acceptance-reading');
    const expectHost = async (available) => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const entry = rpc.filter(r => r.channel === 'wuu:browser-pip-host-layout' && r.completed).at(-1);
        if (entry && Boolean(entry.payload?.host) === available) return entry.payload;
        await delay(40);
      }
      throw new Error(`Production PiP host IPC did not become ${available ? 'available' : 'hidden'}`);
    };
    const before = await expectHost(true);
    await goSettings('Appearance');
    const inSettings = await expectHost(false);
    await goConversations();
    const restored = await expectHost(true);
    await click(plugins, 'pip-host-catalog');
    const inCatalog = await expectHost(false);
    await goConversations();
    const after = await expectHost(true);
    return { before, inSettings, restored, inCatalog, after, nativePiPWindow: 'not exercised' };
  });

  await test('plugin details, skill preview and catalog empty search', async () => {
    await click(plugins, 'catalog-detail-entry'); await dockSidebar();
    await click(pick('.sidebar-section-item', 'Plugins'), 'plugins-list');
    await waitFor(() => document.querySelector('.catalog-row-open[aria-label*="Acceptance Plugin"]'));
    await click('.catalog-row-open[aria-label*="Acceptance Plugin"]', 'open-synthetic-plugin-details');
    await waitFor(() => document.querySelector('[data-wuu-component="plugin-detail"]'));
    await capture('manifest-only-plugin-details');
    await click('[data-testid="plugin-page-back"]', 'plugin-details-back');
    await click(pick('.sidebar-section-item', 'Skills'), 'skills-preview-list');
    await fill('.catalog-toolbar input', 'acceptance-skill');
    await waitFor(() => document.querySelector('.catalog-row[aria-label="Preview acceptance-skill"]'));
    await click('.catalog-row[aria-label="Preview acceptance-skill"]', 'skill-preview-open');
    await waitFor(() => document.querySelector('.skill-preview-body')?.textContent.includes('read-only synthetic skill preview'));
    await capture('skill-preview-loaded-from-core'); key('Escape');
    await waitFor(() => !document.querySelector('.skill-preview-dialog'));
    await fill('.catalog-toolbar input', 'no-such-skill-acceptance');
    await waitFor(() => document.querySelector('.skills-catalog .settings-group-empty'));
    await capture('catalog-empty-search');
    await fill('.catalog-toolbar input', '');
    await click('.catalog-refresh', 'catalog-refresh');
    await waitFor(() => document.querySelector('.catalog-refresh')?.getAttribute('aria-busy') === 'false');
    await goConversations();
  });

  await test('draft and reading position survive all global sections', async () => {
    await selectThread('acceptance-reading');
    await fill(composer, 'Unsent acceptance draft: keep this exactly.');
    const scrollPoint = await point(scroller, false);
    for (let i = 0; i < 6; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: scrollPoint.x, y: scrollPoint.y, deltaX: 0, deltaY: 300, canScroll: true });
      await delay(60);
    }
    await settle();
    const before = await evaluate(selector => { const s = document.querySelector(selector); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight }; }, scroller);
    assert.ok(before.max > 500 && before.top < before.max - 200, 'Native wheel input leaves the reading tail');
    await capture('reading-anchor-before-navigation');
    await click(plugins, 'draft-to-plugins');
    await goSettings('General');
    await goConversations();
    const after = await evaluate(({ selector, input }) => ({ top: document.querySelector(selector).scrollTop, draft: document.querySelector(input).value }), { selector: scroller, input: composer });
    assert.equal(after.draft, 'Unsent acceptance draft: keep this exactly.');
    assert.ok(Math.abs(after.top - before.top) <= 8, `Reading position moved ${before.top} -> ${after.top}`);
    await selectThread('acceptance-second');
    assert.equal(await evaluate(selector => document.querySelector(selector).value, composer), '');
    await selectThread('acceptance-reading');
    assert.equal(await evaluate(selector => document.querySelector(selector).value, composer), after.draft);
    return { before, after };
  });

  await test('search opens by mouse, selects by Enter, and restores focus', async () => {
    await goConversations(); await dockSidebar();
    await click('.conversation-search-trigger', 'open-search-mouse');
    await waitFor(() => document.querySelector('.conversation-search-dialog input') === document.activeElement);
    await fill('.conversation-search-dialog input', 'second conversation');
    await waitFor(() => document.querySelector('.conversation-search-result-title')?.textContent.includes('second conversation'));
    await capture('search-before-enter'); key('Enter');
    await waitFor(() => !document.querySelector('.conversation-search-dialog')
      && document.querySelector('.cached-conversation-pane[data-active="true"]')?.dataset.threadId === 'acceptance-second');
    await capture('search-after-enter');
    await click(composer, 'focus-composer', false); key('P', ['control']);
    await waitFor(() => document.querySelector('.conversation-search-dialog input') === document.activeElement);
    key('Escape');
    await waitFor(selector => !document.querySelector('.conversation-search-dialog') && document.activeElement === document.querySelector(selector), composer);
    key('P', ['control']); await waitFor(() => document.querySelector('.conversation-search-dialog input') === document.activeElement);
    await fill('.conversation-search-dialog input', 'long reading');
    await waitFor(() => document.querySelector('.conversation-search-result-title')?.textContent.includes('long reading'));
    await click('.conversation-search-result', 'search-mouse-result');
    await waitFor(() => document.querySelector('.cached-conversation-pane[data-active="true"]')?.dataset.threadId === 'acceptance-reading'
      && !document.querySelector('.conversation-search-dialog'));
  });

  await test('settings search, no-results, Escape, and all native pages', async () => {
    await goSettings(); await dockSidebar();
    const labels = await evaluate(() => [...document.querySelectorAll('.settings-nav-item')].map(n => n.textContent.trim()));
    assert.ok(labels.length >= 6, 'Capability-aware settings navigation is populated');
    const pages = [];
    for (const label of labels) {
      await click(pick('.settings-nav-item', label), `settings-page-${label}`);
      pages.push(await evaluate(() => document.querySelector('[data-wuu-component="settings-page"]').dataset.wuuPage));
      assert.ok(await evaluate(() => !!document.querySelector('.settings-titlebar-slot')?.textContent.trim()), 'Settings titlebar has the active page title');
    }
    await fill('.settings-search input', 'Appearance');
    await waitFor(() => document.querySelectorAll('.settings-nav-item').length === 1);
    await click(pick('.settings-nav-item', 'Appearance'), 'filtered-appearance');
    await fill('.settings-search input', 'no-such-setting-acceptance');
    await waitFor(() => document.querySelector('.settings-nav-empty'));
    await capture('settings-search-empty'); key('Escape');
    await waitFor(() => document.querySelector('.settings-search input').value === '' && !document.querySelector('.settings-nav-empty'));
    return { labels, pages };
  });

  await test('runtime edit commits when leaving through ribbon', async () => {
    await goSettings('Built-in agent'); await dockSidebar();
    const field = '[data-testid="settings-advanced"] input';
    await fill(field, '73');
    await click(conversations, 'runtime-blur-save-via-ribbon');
    await waitFor(() => !document.querySelector('.settings-workbench-layer'));
    await goSettings('Built-in agent');
    await waitFor(selector => document.querySelector(selector)?.value === '73', field, 'runtime setting persisted after ribbon navigation');
    assert.ok(rpc.some(r => r.channel === 'wuu:config-advanced-update' && r.completed), 'Real core settings update completed');
    await capture('runtime-persisted');
  });

  await test('provider connect validation and modal cancellation', async () => {
    await goSettings('Model providers'); await dockSidebar();
    await click('[data-testid="settings-provider-custom"]', 'provider-open-custom');
    await waitFor(() => document.querySelector('.model-connect-dialog'));
    assert.ok(await evaluate(() => document.querySelector('[data-testid="settings-provider-connect"]').disabled), 'Empty provider cannot be saved');
    await fill('[data-testid="settings-provider-connect-base-url"]', 'http://127.0.0.1:1/v1');
    assert.ok(await evaluate(() => document.querySelector('[data-testid="settings-provider-connect"]').disabled), 'Missing key/model cannot be saved');
    await capture('provider-incomplete-form');
    await click(pick('.model-connect-dialog button', 'Cancel'), 'provider-cancel');
    await waitFor(() => !document.querySelector('.model-connect-dialog'));
    await click('[data-testid="settings-provider-custom"]', 'provider-reopen');
    await waitFor(() => document.querySelector('.model-connect-dialog'));
    key('Escape'); await waitFor(() => !document.querySelector('.model-connect-dialog'));
    assert.ok(!rpc.some(r => /connection.*update|provider.*connect/.test(r.channel)), 'Cancelled provider never contacts a provider');
  });

  await test('collapsed contextual sidebars hover, dock, focus and keyboard resize', async () => {
    await goConversations(); await dockSidebar();
    const runs = [];
    for (const section of ['conversations', 'settings']) {
      if (section === 'settings') await goSettings('Appearance');
      const before = await point(leftToggle, false);
      await click(leftToggle, `collapse-${section}`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 500 });
      await waitFor(() => document.querySelector('.app-shell').classList.contains('sidebar-collapsed')
        && !document.querySelector('.app-shell').classList.contains('sidebar-drawer-open'));
      const collapsed = await point(leftToggle, false);
      assert.equal(collapsed.x, before.x); assert.equal(collapsed.y, before.y);
      assert.ok(await point(conversations, false), 'Ribbon remains interactive when context is collapsed');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: collapsed.x, y: collapsed.y });
      await waitFor(() => document.querySelector('.app-shell').classList.contains('sidebar-drawer-open'));
      await capture(`${section}-hover-drawer`);
      const hovered = await point(leftToggle, false);
      assert.equal(hovered.x, before.x); assert.equal(hovered.y, before.y);
      const focusTarget = section === 'settings' ? '.settings-search input' : '.conversation-search-trigger';
      await click(focusTarget, 'focus-drawer-content', false);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 500 });
      await settle();
      assert.ok(await evaluate(selector => document.activeElement === document.querySelector(selector) && !document.activeElement.closest('[inert]'), focusTarget), 'Focused drawer contents remain reachable after pointer leaves');
      await click(leftToggle, `dock-${section}`);
      await waitFor(() => !document.querySelector('.app-shell').classList.contains('sidebar-collapsed'));
      const resize = '.app-shell > .sidebar-resizer';
      const width = await evaluate(selector => Number(document.querySelector(selector).getAttribute('aria-valuenow')), resize);
      await evaluate(selector => document.querySelector(selector).focus(), resize);
      key('Right');
      await waitFor(({ selector, width }) => Number(document.querySelector(selector).getAttribute('aria-valuenow')) > width, { selector: resize, width });
      const grown = await evaluate(selector => Number(document.querySelector(selector).getAttribute('aria-valuenow')), resize);
      key('Left');
      await waitFor(({ selector, width }) => Number(document.querySelector(selector).getAttribute('aria-valuenow')) === width, { selector: resize, width });
      await capture(`${section}-keyboard-resized`);
      runs.push({ section, before, collapsed, hovered, width, grown });
    }
    await goConversations(); return runs;
  });

  await test('right preview toggle retains state across settings and restores focus', async () => {
    await selectThread('acceptance-reading'); await dockSidebar();
    if (await evaluate(() => document.querySelector('.app-shell').classList.contains('right-panel-open'))) await click(rightToggle, 'reset-right-panel');
    await click(composer, 'focus-before-preview', false);
    await click(rightToggle, 'open-right-preview');
    await waitFor(() => document.querySelector('.app-shell').classList.contains('right-panel-open'));
    if (await evaluate(() => !!document.querySelector('[data-wuu-tool="files"]'))) {
      await click('[data-wuu-tool="files"]', 'preview-files');
      await waitFor(() => !!document.querySelector('file-tree-container'));
    }
    await capture('right-preview-open');
    const before = await evaluate(() => ({ tabs: [...document.querySelectorAll('.workspace-panel-tabs [role="tab"]')].map(n => n.textContent), text: document.querySelector('.workspace-right-panel')?.innerText.slice(0, 800) }));
    await goSettings('General');
    await goConversations();
    assert.ok(await evaluate(() => document.querySelector('.app-shell').classList.contains('right-panel-open')), 'Settings preserves the open preview');
    const after = await evaluate(() => ({ tabs: [...document.querySelectorAll('.workspace-panel-tabs [role="tab"]')].map(n => n.textContent), text: document.querySelector('.workspace-right-panel')?.innerText.slice(0, 800) }));
    assert.deepEqual(after, before, 'Settings preserves preview content');
    await click(rightToggle, 'close-right-preview');
    await waitFor(() => !document.querySelector('.app-shell').classList.contains('right-panel-open'));
    await click(composer, 'composer-reachable-after-preview', false);
    assert.ok(await evaluate(selector => document.activeElement === document.querySelector(selector), composer));
    await click(rightToggle, 'reopen-right-preview'); await click(rightToggle, 'close-right-preview-again');
    return { before, after };
  });

  for (const theme of ['light', 'dark']) {
    for (const size of [15, 20]) {
      for (const width of [1280, 960, 1440]) {
        await test(`rendered matrix ${theme} ${size}px ${width}px`, async () => {
          await goConversations(); await dockSidebar();
          await appearance(theme, size, width);
          const settings = await geometry(`settings-${theme}-${size}-${width}`);
          await capture(`matrix-settings-${theme}-${size}-${width}`);
          await goConversations();
          const reading = await geometry(`conversation-${theme}-${size}-${width}`);
          await capture(`matrix-conversation-${theme}-${size}-${width}`);
          await click(plugins, 'matrix-plugins', false);
          await click(pick('.sidebar-section-item', 'Skills'), 'matrix-skills', false);
          const skills = await geometry(`skills-${theme}-${size}-${width}`);
          await capture(`matrix-skills-${theme}-${size}-${width}`);
          return { settings, reading, skills };
        });
      }
    }
  }

  await test('125 percent desktop zoom keeps controls reachable', async () => {
    await appearance('light', 20, 1440); await goConversations();
    try {
      win.webContents.setZoomFactor(1.25);
      await settle();
      await capture('desktop-zoom-125-percent');
      const reading = await geometry('desktop-zoom-reading');
      await goSettings('Appearance');
      const settings = await geometry('desktop-zoom-settings');
      return { reading, settings };
    } finally { win.webContents.setZoomFactor(1); await settle(); }
  });

  await test('Linux outer chrome double-click and caption restore', async () => {
    await appearance('light', 15, 1280); await goConversations();
    const chrome = await point('.workbench-window-chrome', false);
    const bounds = win.getContentBounds();
    await capture('before-titlebar-double-click');
    // X11 input reaches the actual OS drag strip, unlike synthetic DOM events.
    const input = spawnSync('xdotool', ['mousemove', String(bounds.x + chrome.x), String(bounds.y + chrome.y), 'click', '--repeat', '2', '--delay', '100', '1'], { encoding: 'utf8' });
    assert.equal(input.status, 0, input.stderr || String(input.error));
    const deadline = Date.now() + 6000;
    while (!win.isMaximized() && Date.now() < deadline) await delay(40);
    assert.ok(win.isMaximized(), 'Double-clicking the outer window chrome maximizes the real OS window');
    await capture('after-titlebar-maximize');
    await click('.linux-window-control[aria-label="Restore"]', 'caption-restore');
    const restoreDeadline = Date.now() + 6000;
    while (win.isMaximized() && Date.now() < restoreDeadline) await delay(40);
    assert.ok(!win.isMaximized(), 'Caption restore returns to normal window geometry');
    win.setPosition(30, 30); win.setContentSize(1280, 900);
  });

  await test('empty conversation and repeated section switching recover', async () => {
    await appearance('light', 15, 1280);
    await selectThread('acceptance-empty');
    await capture('empty-conversation');
    for (let i = 0; i < 3; i++) {
      await click(plugins, 'repeat-plugins', false);
      await goSettings('Appearance');
      await goConversations();
    }
    assert.ok(await evaluate(() => !!document.querySelector('.empty-scroll-region') && [...document.querySelectorAll('.thread-row.active')].some(n => n.textContent.includes('empty conversation'))));
    await click(composer, 'empty-composer-reachable', false);
    assert.ok(await evaluate(selector => document.activeElement === document.querySelector(selector), composer));
    await capture('final-recovered-window');
  });
  await test('no renderer errors or accidental inference', async () => {
    assert.deepEqual(report.errors, []);
    assert.ok(!rpc.some(r => ['wuu:turn-start', 'wuu:turn-queue', 'wuu:turn-steer'].includes(r.channel)));
  });
  report.status = report.checks.some(c => c.status === 'failed') ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
  report.ipc = rpc.map(({ channel, completed, error }) => ({ channel, completed, error }));
  save();
  console.log(`WORKBENCH ${report.status}: ${report.checks.filter(c => c.status === 'passed').length}/${report.checks.length} checks, ${report.screenshots.length} real-window captures`);
}
run().then(async () => {
  clearTimeout(watchdog);
  const code = report.status === 'passed' ? 0 : 1;
  // The real app's quit hook shuts down its Go child; preserve failing status.
  app.on('will-quit', () => { process.exitCode = code; });
  app.quit();
  setTimeout(() => app.exit(code), 1000).unref();
}).catch(async error => {
  clearTimeout(watchdog); report.status = 'failed'; report.fatal = String(error.stack || error);
  console.error(error);
  if (win && !win.isDestroyed()) { try { await capture('fatal'); } catch {} }
  save(); app.exit(1);
});
