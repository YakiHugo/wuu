// Run through wuu-e2e. macOS chrome here is the real renderer component with a
// synthetic platform bridge on Linux, not native AppKit acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

assert.equal(process.platform, 'linux', 'Use the isolated Linux display');
assert.ok(process.env.DISPLAY, 'Xvfb display required');
const desktop = path.resolve(__dirname, '..');
const output = path.resolve(process.env.WUU_RIBBON_CHROME_OUTPUT || path.join(desktop, 'out/e2e/ribbon-chrome'));
const platform = process.env.WUU_RIBBON_CHROME_PLATFORM || 'darwin';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wuu-ribbon-chrome-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(temporary, 'profile'));
const extension = path.join(temporary, 'extension.cjs');
fs.writeFileSync(extension, `module.exports = api => ({ ...api, platform: ${JSON.stringify(platform)}, windowToggleFullScreen: async () => {}, windowMinimize: async () => {}, windowClose: async () => {}, windowToggleMaximize: async () => {}, windowIsMaximized: async () => false });`);
process.env.WUU_RENDERER_E2E_EXTENSION = extension;
const report = { status: 'running', platform, scope: 'Shipping renderer with synthetic backend under Linux/Xvfb', cases: [] };
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
let win;
const evaluate = (fn, argument) => win.webContents.executeJavaScript(`(${fn})(${JSON.stringify(argument)})`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await evaluate(fn)) return; await delay(30); }
  throw new Error('Timed out: ' + label);
}
async function settle() {
  await evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
  });
}
async function point(selector) {
  return evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, selector);
}
function move(p) { win.webContents.sendInputEvent({ type: 'mouseMove', ...p }); }
function clickAt(p) {
  move(p);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
}
async function closeRail() {
  move({ x: win.getContentSize()[0] - 80, y: 120 });
  await evaluate(() => document.activeElement?.blur());
  await until(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded !== 'true', 'rail closes');
  await settle();
}
const read = () => {
  const rail = document.querySelector('.sidebar-ribbon');
  const toggle = document.querySelector('.section-sidebar-toggle');
  const rect = toggle.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const caption = [...document.querySelectorAll('.mac-window-control, .linux-window-controls button')].map(button => {
    const r = button.getBoundingClientRect();
    return { label: button.getAttribute('aria-label'), hit: button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
  });
  return { expanded: rail.dataset.expanded === 'true', toggleHit: toggle.contains(hit), railHit: rail.contains(hit), rect: rect.toJSON(), railRect: rail.getBoundingClientRect().toJSON(), caption, collapsed: document.querySelector('.app-shell').classList.contains('sidebar-collapsed') };
};
async function run() {
  win = new BrowserWindow({ width: 1280, height: 820, frame: false, show: true, webPreferences: {
    preload: path.join(__dirname, 'resize-e2e-preload.cjs'), sandbox: false, contextIsolation: true, nodeIntegration: false,
  } });
  await win.loadFile(path.join(desktop, 'out/renderer/index.html'));
  await until(() => !!document.querySelector('.turn') && !!document.querySelector('.section-sidebar-toggle'), 'conversation ready');
  for (const [theme, size, width] of [['light', 15, 1280], ['dark', 20, 1280], ['light', 20, 600], ['dark', 15, 600]]) {
    win.setContentSize(width, 820);
    await evaluate(({ theme, size }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty('--conversation-message-font-size', size + 'px'); }, { theme, size });
    for (const section of ['conversations', 'settings']) {
      const target = section === 'conversations' ? '[data-wuu-component="conversations-section"]' : '.sidebar-ribbon button[aria-label="Settings"], .sidebar-ribbon button[aria-label="设置"]';
      clickAt(await point(target));
      await until(section === 'settings' ? () => !!document.querySelector('.settings-embedded') : () => !document.querySelector('.settings-embedded'), 'section navigation');
      await settle();
      await closeRail();
      for (const collapsed of [false, true]) {
        if ((await evaluate(read)).collapsed !== collapsed) clickAt(await point('.section-sidebar-toggle'));
        await closeRail();
        const before = await evaluate(read);
        assert.equal(before.collapsed, collapsed);
        assert.equal(before.toggleHit, true, 'Context toggle is reachable with the rail closed');
        move(await point('[data-wuu-component="conversations-section"]'));
        await until(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded === 'true', 'hover opens rail');
        await settle();
        const during = await evaluate(read);
        const label = `${platform}-${theme}-${size}-${width}-${section}-${collapsed ? 'collapsed' : 'docked'}`;
        const result = { label, before, during };
        report.cases.push(result); save();
        fs.writeFileSync(path.join(output, label + '-open.png'), (await win.webContents.capturePage()).toPNG());
        assert.equal(during.caption.length, 3, 'All renderer caption controls are present');
        assert.ok(during.caption.every(control => control.hit), 'Caption controls remain above the expanded rail');
        if (platform === 'darwin') {
          assert.equal(during.toggleHit, false, 'Expanded rail must cover the contextual toggle');
          assert.equal(during.railHit, true, 'The covered toggle position belongs to the rail');
          clickAt(await point('.section-sidebar-toggle'));
          await settle();
          assert.equal((await evaluate(read)).collapsed, collapsed, 'Clicking the covered position cannot toggle the sidebar');
        } else {
          assert.equal(during.toggleHit, true, 'Separate Linux caption-row toggle remains reachable');
        }
        await closeRail();
        const restored = await evaluate(read);
        assert.equal(restored.toggleHit, true, 'Leaving hover restores the contextual toggle');
        clickAt(await point('.section-sidebar-toggle'));
        await closeRail();
        result.afterClick = await evaluate(read);
        assert.equal(result.afterClick.collapsed, !collapsed, 'Restored toggle still changes the sidebar');
        // Keyboard navigation must also raise and release the same overlay.
        await evaluate(() => document.querySelector('[data-wuu-component="conversations-section"]').focus());
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ArrowDown' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ArrowDown' });
        await until(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded === 'true', 'keyboard expands rail');
        await settle();
        if (platform === 'darwin') assert.equal((await evaluate(read)).toggleHit, false, 'Keyboard expansion covers the toggle too');
        await closeRail();
        fs.writeFileSync(path.join(output, label + '-closed.png'), (await win.webContents.capturePage()).toPNG());
        save();
      }
    }
  }
  report.status = 'passed'; save();
  console.log(`Ribbon chrome passed: ${report.cases.length} cases (${platform} renderer on Linux).`);
  win.destroy(); app.quit();
}
const watchdog = setTimeout(() => { report.status = 'timed-out'; save(); app.exit(1); }, 180000);
watchdog.unref();
app.whenReady().then(run).catch(async error => {
  report.status = 'failed'; report.error = String(error.stack || error); save(); console.error(error);
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  app.exit(1);
});
