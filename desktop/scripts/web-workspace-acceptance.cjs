// Real native website journeys, run by workbench-acceptance-e2e.cjs under Xvfb.
// The only website and executable extension are authored disposable fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { BrowserWindow, dialog, nativeImage, session, webContents } = require('electron');

async function createWebsiteFixture(home) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://fixture.test');
      requests.push({ method: request.method, path: url.pathname, body, cookie: request.headers.cookie || '' });
      if (url.pathname === '/cookie') {
        response.writeHead(302, { Location: '/alpha', 'Set-Cookie': 'wuu_acceptance=synthetic-session; Path=/; Max-Age=86400; SameSite=Lax' });
        response.end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><title>Local fixture ${url.pathname}</title>
<style>body{font:18px system-ui;margin:0;background:#edf4fa;color:#17354a}main{padding:42px;max-width:850px}h1{font-weight:500}input,button,a{font:inherit;margin:8px 12px 8px 0;padding:10px}a{display:inline-block}input{width:330px}pre{white-space:pre-wrap;padding:18px;background:white;border-radius:12px}button{cursor:pointer}</style>
<main><p>Wuu · isolated local website fixture</p><h1>${url.pathname}</h1><p>No external service, account, or model is contacted.</p>
<label>Retained page draft <input id="draft" placeholder="Type a retained website draft"></label>
<p><a id="next" href="/next">Next page</a><a id="cookie" href="/cookie">Set synthetic session cookie</a></p>
<button id="blank">Open blank popup + postMessage</button>
<form action="/posted" method="post" target="_blank"><input type="hidden" name="fixture" value="post-preserved"><button id="post">Open POST popup</button></form>
<button id="geo">Request location (deny)</button><button id="camera">Request synthetic camera (deny)</button>
<pre id="state"></pre><p id="popup-result"></p><p id="permission-result"></p>
<script>
const state=()=>document.querySelector('#state').textContent=JSON.stringify({cookie:document.cookie,path:location.pathname,visibility:document.visibilityState,wuu:typeof window.wuu,require:typeof require,process:typeof process},null,2);state();document.addEventListener('visibilitychange',state);
document.querySelector('#blank').onclick=()=>{const popup=window.open('about:blank','fixture-blank','width=700,height=460'); if(popup){popup.document.write('<title>Synthetic popup</title><h1>Fixture popup</h1><p>Opener messaging retained.</p>');popup.opener.postMessage('fixture-opener-roundtrip',location.origin);}};
window.addEventListener('message',event=>{if(event.data==='fixture-opener-roundtrip')document.querySelector('#popup-result').textContent=event.data;});
document.querySelector('#geo').onclick=()=>{document.querySelector('#permission-result').textContent='pending';navigator.geolocation.getCurrentPosition(()=>document.querySelector('#permission-result').textContent='unexpected-grant',()=>document.querySelector('#permission-result').textContent='denied');};
document.querySelector('#camera').onclick=async()=>{document.querySelector('#permission-result').textContent='pending';try{const stream=await navigator.mediaDevices.getUserMedia({video:true});stream.getTracks().forEach(track=>track.stop());document.querySelector('#permission-result').textContent='unexpected-grant';}catch{document.querySelector('#permission-result').textContent='denied';}};
</script></main>`);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const plugin = path.join(home, 'plugins/acceptance-webpage');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acceptance-webpage', name: 'Acceptance Webpage', version: '0.1.0',
    description: 'Authored local HTTP fixture, no external service or permission.', desktop: { entry: 'desktop.js' },
    contributes: { navigation: [{ id: 'website-entry', view: 'website', title: 'Fixture Website' }] } }));
  fs.writeFileSync(path.join(plugin, 'desktop.js'), `export function activate(api) { api.registerViewType({ id: 'website', title: 'Fixture Website', defaultRegion: 'primary', persistence: 'durable', render: () => api.react.createElement(api.ui.WebPage, { url: ${JSON.stringify(origin + '/extension')}, title: 'Fixture Website' }) }); }\n`);
  return { origin, requests, close: () => server.close() };
}

async function runWebsiteAcceptance(h, fixture) {
  const { win, report, output, started, save, evaluate, waitFor, settle, delay, point, fill, key, pick, test, goConversations, goSettings, appearance, plugins, conversations } = h;
  const origin = fixture.origin;
  const manager = 'button[aria-label="Customize navigation"]';
  const formName = '.ribbon-website-form label:first-child input';
  const formURL = '.ribbon-website-form label:nth-child(2) input';
  const webRoot = '[data-wuu-component="web-workspace"]';
  const address = `${webRoot} .workspace-browser-url-input`;
  const toolbar = name => `${webRoot} button[aria-label="${name}"]`;
  const ribbon = name => `.sidebar-ribbon-main button[aria-label="${name}"]`;
  const prefs = () => evaluate(() => JSON.parse(localStorage.getItem('wuu.navigation-ribbon.v1')));
  const views = () => win.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL().startsWith(origin));
  const contents = pathname => webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.getURL() === origin + pathname);
  const nativeView = pathname => views().find(view => view.webContents.getURL() === origin + pathname);
  async function until(predicate, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(40); }
    throw new Error(`Timed out: ${label}`);
  }
  // Shell capturePage cannot see WebContentsView children. X11 captures the
  // actual composed native window, including website pixels and native dialogs.
  async function capture(label) {
    await settle();
    const bounds = win.getBounds();
    const taken = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${bounds.width}x${bounds.height}`, '-i', `${process.env.DISPLAY}+${bounds.x},${bounds.y}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { timeout: 12000, maxBuffer: 24 * 1024 * 1024 });
    assert.equal(taken.status, 0, String(taken.stderr || taken.error));
    const image = nativeImage.createFromBuffer(taken.stdout);
    assert.ok(!image.isEmpty(), 'Actual native-window PNG is readable');
    const name = `${String(report.screenshots.length + 1).padStart(3, '0')}-web-${label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 85)}.png`;
    fs.writeFileSync(path.join(output, name), taken.stdout);
    report.screenshots.push({ file: name, source: 'x11-whole-native-window', sha256: createHash('sha256').update(taken.stdout).digest('hex'), atMs: Date.now() - started, image: image.getSize(), window: bounds });
    save(); await delay(160);
  }
  function xinput(args) {
    const result = spawnSync('xdotool', args, { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }
  async function click(target, label, evidence = true) {
    const p = await point(target);
    if (evidence) await capture(`before-${label}`);
    const bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(bounds.x + p.x * zoom)), String(Math.round(bounds.y + p.y * zoom)), 'click', '1']);
    report.actions.push({ label: `web-${label}`, input: 'native-x11', atMs: Date.now() - started, point: p });
    await settle();
    if (evidence) await capture(`after-${label}`);
  }
  async function pageClick(wc, selector, label) {
    const view = win.contentView.children.find(view => view.webContents === wc);
    assert.ok(view?.getVisible(), 'Native website is actually visible before page input');
    const p = await wc.executeJavaScript(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    const outer = win.getContentBounds(), inner = view.getBounds(), zoom = wc.getZoomFactor();
    await capture(`before-${label}`);
    xinput(['mousemove', String(Math.round(outer.x + inner.x + p.x * zoom)), String(Math.round(outer.y + inner.y + p.y * zoom)), 'click', '1']);
    report.actions.push({ label, input: 'native-x11-website', atMs: Date.now() - started });
    await delay(80);
  }
  async function hidden(label) {
    await until(() => views().every(view => !view.getVisible()), `${label}: all native surfaces hidden`);
    return Promise.all(views().map(async view => ({ url: view.webContents.getURL(), visible: view.getVisible(), visibility: await view.webContents.executeJavaScript('document.visibilityState') })));
  }
  async function openSite(name, pathname) {
    await click(ribbon(name), `open-${name}`);
    await until(() => nativeView(pathname)?.getVisible() && !nativeView(pathname).webContents.isLoading(), `visible fixture ${pathname}`);
    return nativeView(pathname).webContents;
  }
  async function addSite(name, pathname) {
    await click(manager, 'customize-navigation');
    await click(pick('.ribbon-manager button', 'Add website'), 'add-website');
    await fill(formName, name); await fill(formURL, origin + pathname);
    await click(pick('.ribbon-manager button', 'Save'), 'save-website');
    await waitFor(name => [...document.querySelectorAll('[data-ribbon-manager-id]')].some(row => row.textContent.includes(name)), name);
    await click(pick('.ribbon-manager button', 'Close'), 'close-customize');
  }
  function security(wc) {
    const p = wc.getLastWebPreferences();
    assert.equal(p.sandbox, true); assert.equal(p.contextIsolation, true); assert.equal(p.nodeIntegration, false);
    assert.ok(!p.preload, 'Untrusted page has no privileged preload');
    assert.equal(wc.session, session.fromPartition('persist:wuu-browser'), 'Uses the existing persistent browser profile');
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, preload: p.preload || null };
  }
  const testNative = (name, action) => test(name, async () => {
    try { return await action(); }
    catch (error) {
      try { await capture(`failure-${name}`); } catch {}
      // Keep the original failure, then dismiss only this fixture's popups.
      for (const popup of BrowserWindow.getAllWindows()) {
        if (popup !== win && (popup.webContents.getURL().startsWith(origin) || popup.webContents.getURL() === 'about:blank')) popup.close();
      }
      win.focus(); throw error;
    }
  });
  let alphaID, savedOrder;

  await testNative('optional websites add safely and stay lazy until selected', async () => {
    assert.equal(await evaluate(() => document.querySelectorAll('[data-wuu-component="website-navigation-item"]').length), 0, 'No websites are added by default');
    await click(manager, 'customize-empty');
    await click(pick('.ribbon-manager button', 'Add website'), 'add-invalid-website');
    await fill(formName, 'Invalid fixture'); await fill(formURL, 'javascript:alert(1)');
    await click(pick('.ribbon-manager button', 'Save'), 'reject-unsafe-scheme');
    await waitFor(() => document.querySelector('#ribbon-website-error'));
    assert.equal((await prefs()).websites.length, 0);
    await click(pick('.ribbon-manager button', 'Cancel'), 'cancel-invalid');
    await click(pick('.ribbon-manager button', 'Close'), 'close-invalid');
    await addSite('Fixture Alpha', '/alpha'); await addSite('Fixture Beta', '/beta');
    const p = await prefs();
    alphaID = p.websites.find(site => site.title === 'Fixture Alpha').id;
    assert.equal(views().length, 0, 'Saved unvisited destinations create no native contents');
    return { sites: p.websites, nativeViews: 0 };
  });

  await testNative('ribbon reorders Chat away from first with real keyboard and pointer', async () => {
    await openSite('Fixture Alpha', '/alpha');
    const before = await evaluate(() => [...document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')].map(node => node.dataset.ribbonId));
    // Opening native contents can focus the page. Enter the ribbon by actual
    // keyboard traversal from its adjacent Customize control before reordering.
    win.webContents.focus();
    await evaluate(selector => document.querySelector(selector).focus(), manager);
    await waitFor(selector => document.activeElement === document.querySelector(selector), manager);
    for (let step = 0; step < before.length; step++) {
      xinput(['key', '--clearmodifiers', 'shift+Tab']);
      await delay(60);
      if (await evaluate(id => document.activeElement?.dataset.ribbonId === id, alphaID)) break;
    }
    assert.ok(await evaluate(id => document.activeElement?.dataset.ribbonId === id, alphaID), 'Real keyboard traversal reaches the website ribbon button');
    assert.equal(await evaluate(() => document.documentElement.dataset.focusModality), 'keyboard');
    await capture('ribbon-keyboard-focus-before-reorder');
    for (let index = before.indexOf(alphaID); index > 0; index--) {
      xinput(['key', '--clearmodifiers', 'alt+Up']);
      await waitFor(({ id, index }) => document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')[index - 1]?.getAttribute('data-ribbon-id') === id, { id: alphaID, index });
      assert.ok(await evaluate(id => document.activeElement?.dataset.ribbonId === id, alphaID), 'Keyboard reorder retains ribbon focus');
    }
    await click(manager, 'customize-order');
    await click('.ribbon-manager button[aria-label="Move Fixture Beta up"]', 'move-beta-up');
    await click(pick('.ribbon-manager button', 'Close'), 'save-order');
    savedOrder = await evaluate(() => [...document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')].map(node => node.getAttribute('data-ribbon-id')));
    assert.equal(savedOrder[0], alphaID);
    assert.ok(savedOrder.indexOf(await evaluate(selector => document.querySelector(selector).dataset.ribbonId, conversations)) > 0, 'Chat is not pinned first');
    assert.deepEqual((await prefs()).order.filter(id => savedOrder.includes(id)), savedOrder);
    await capture('reordered-ribbon'); return { before, after: savedOrder };
  });

  await testNative('native website security cookies history reload and retained input', async () => {
    let wc = await openSite('Fixture Alpha', '/alpha');
    const preferences = security(wc);
    assert.deepEqual(await wc.executeJavaScript('({wuu:typeof window.wuu,require:typeof require,process:typeof process})'), { wuu: 'undefined', require: 'undefined', process: 'undefined' });
    await pageClick(wc, '#cookie', 'set-synthetic-cookie');
    await until(() => !wc.isLoading() && wc.getURL() === origin + '/alpha', 'cookie redirect completed');
    assert.ok((await wc.executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    assert.ok((await session.fromPartition('persist:wuu-browser').cookies.get({ url: origin })).some(cookie => cookie.name === 'wuu_acceptance'));
    await pageClick(wc, '#draft', 'focus-native-draft');
    await wc.insertText('Retained native website draft');
    await until(() => wc.executeJavaScript('document.querySelector("#draft").value === "Retained native website draft"'), 'native draft input');
    await click(conversations, 'website-to-chat'); await hidden('Chat');
    await openSite('Fixture Alpha', '/alpha');
    assert.equal(await wc.executeJavaScript('document.querySelector("#draft").value'), 'Retained native website draft');
    await pageClick(wc, '#next', 'navigate-native-link');
    await until(() => wc.getURL() === origin + '/next' && !wc.isLoading(), 'next page loaded');
    await click(toolbar('Back'), 'native-back');
    await until(() => wc.getURL() === origin + '/alpha' && !wc.isLoading(), 'back returned');
    await click(toolbar('Forward'), 'native-forward');
    await until(() => wc.getURL() === origin + '/next' && !wc.isLoading(), 'forward returned');
    const requestsBeforeReload = fixture.requests.filter(request => request.path === '/next').length;
    await click(toolbar('Reload'), 'native-reload');
    await until(() => fixture.requests.filter(request => request.path === '/next').length > requestsBeforeReload && !wc.isLoading(), 'reload requested a fresh page');
    assert.ok((await wc.executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    await pageClick(wc, '#draft', 'focus-before-native-address-shortcut');
    xinput(['key', 'ctrl+l']);
    await waitFor(selector => document.activeElement?.matches(selector), address, 'native Ctrl+L focuses shell address');
    await fill(address, origin + '/alpha'); key('Enter');
    await until(() => wc.getURL() === origin + '/alpha' && !wc.isLoading(), 'address navigation');
    await capture('native-page-loaded'); return { preferences, cookie: 'synthetic-session', contentsId: wc.id };
  });

  await testNative('native websites yield to sections dialogs and restore real focus', async () => {
    const wc = await openSite('Fixture Alpha', '/alpha');
    await click(manager, 'native-page-customization-modal');
    const managerHidden = await hidden('customization dialog'); await capture('dialog-over-native-page');
    await click(pick('.ribbon-manager button', 'Add website'), 'native-page-add-modal');
    await hidden('add dialog');
    await click(pick('.ribbon-manager button', 'Cancel'), 'cancel-add-modal');
    await click(pick('.ribbon-manager button', 'Close'), 'restore-after-modal');
    await until(() => nativeView('/alpha')?.getVisible(), 'restore after modal');
    await goSettings('Appearance'); await hidden('Settings'); await capture('settings-with-native-hidden');
    await openSite('Fixture Alpha', '/alpha');
    await click(plugins, 'native-to-extensions'); await hidden('Extensions');
    await click(conversations, 'native-to-chat'); await hidden('Conversations');
    key('P', ['control']);
    await waitFor(() => document.querySelector('[role="dialog"] input'));
    await hidden('search'); await capture('search-with-native-hidden'); key('Escape');
    for (let i = 0; i < 3; i++) {
      await openSite('Fixture Alpha', '/alpha');
      await click(plugins, 'rapid-extensions', false); await hidden('rapid Extensions');
      await click(conversations, 'rapid-chat', false); await hidden('rapid Chat');
    }
    await openSite('Fixture Alpha', '/alpha');
    await pageClick(wc, '#draft', 'focus-after-section-return');
    await wc.insertText(' restored');
    await until(() => wc.executeJavaScript('document.querySelector("#draft").value.endsWith(" restored")'), 'native focus accepts input after restore');
    return { managerHidden, retainedContentsId: wc.id };
  });

  await testNative('native website bounds follow narrow large-type and zoomed workbench', async () => {
    const samples = [];
    try {
      for (const [theme, size, width, zoom] of [['light', 20, 960, 1], ['dark', 20, 1440, 1.25]]) {
        await appearance(theme, size, width); win.webContents.setZoomFactor(zoom); await settle();
        await openSite('Fixture Alpha', '/alpha');
        const view = nativeView('/alpha');
        await until(async () => {
          const host = await evaluate(() => { const r=document.querySelector('.web-workspace-host').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; });
          const actual = view.getBounds();
          return ['x','y','width','height'].every(key => Math.abs(actual[key] - Math.round(host[key] * zoom)) <= 2);
        }, 'native view matches rendered host bounds');
        const bounds = view.getBounds(), [w, h] = win.getContentSize();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= w && bounds.y + bounds.height <= h);
        await capture(`bounds-${theme}-${width}-zoom-${zoom}`);
        samples.push({ theme, size, width, zoom, bounds });
      }
    } finally { win.webContents.setZoomFactor(1); await appearance('light', 15, 1280); }
    return samples;
  });

  await testNative('website popups preserve opener and POST with no privileged bridge', async () => {
    const wc = await openSite('Fixture Alpha', '/alpha');
    const initial = new Set(BrowserWindow.getAllWindows().map(window => window.id));
    await pageClick(wc, '#blank', 'open-blank-popup');
    await until(() => BrowserWindow.getAllWindows().some(window => !initial.has(window.id)), 'blank popup created');
    const blank = BrowserWindow.getAllWindows().find(window => !initial.has(window.id));
    await until(() => wc.executeJavaScript('document.querySelector("#popup-result").textContent === "fixture-opener-roundtrip"'), 'popup opener message');
    security(blank.webContents);
    assert.deepEqual(await blank.webContents.executeJavaScript('({wuu:typeof window.wuu,require:typeof require,process:typeof process})'), { wuu: 'undefined', require: 'undefined', process: 'undefined' });
    await capture('blank-popup-opener'); blank.close(); win.focus();
    await pageClick(wc, '#post', 'open-post-popup');
    await until(() => fixture.requests.some(request => request.path === '/posted' && request.method === 'POST' && request.body === 'fixture=post-preserved'), 'native POST body preserved');
    await until(() => contents('/posted') && !contents('/posted').isLoading(), 'POST popup loaded');
    const post = contents('/posted'); security(post); await capture('post-popup');
    BrowserWindow.fromWebContents(post).close(); win.focus();
    return { openerRoundtrip: true, post: fixture.requests.find(request => request.path === '/posted') };
  });

  await testNative('website camera and location never receive silent grants', async () => {
    const wc = await openSite('Fixture Alpha', '/alpha');
    const observed = [];
    const original = dialog.showMessageBox;
    dialog.showMessageBox = function(...args) {
      const options = args.at(-1);
      observed.push({ title: options.title, message: options.message, buttons: options.buttons });
      return original.apply(this, args);
    };
    try {
      for (const selector of ['#geo', '#camera']) {
        const before = observed.length;
        await pageClick(wc, selector, `request-${selector.slice(1)}-permission`);
        await until(() => observed.length > before, 'real native permission dialog opened');
        assert.equal(observed.at(-1).title, 'Website permission');
        await capture(`${selector.slice(1)}-permission-prompt`);
        xinput(['key', 'Escape']);
        await until(() => wc.executeJavaScript('document.querySelector("#permission-result").textContent === "denied"'), 'native permission denial returned');
      }
    } finally { xinput(['key', 'Escape']); dialog.showMessageBox = original; }
    return observed;
  });

  await testNative('website edit removal recreation and renderer restart preserve saved state', async () => {
    await openSite('Fixture Alpha', '/alpha');
    await click(manager, 'edit-active-destination'); await hidden('edit manager');
    await click('.ribbon-manager button[aria-label="Edit Fixture Alpha"]', 'edit-alpha');
    await fill(formName, 'Fixture Alpha Edited'); await fill(formURL, origin + '/edited');
    await click(pick('.ribbon-manager button', 'Save'), 'save-edit');
    await click(pick('.ribbon-manager button', 'Close'), 'close-edit');
    const wc = await openSite('Fixture Alpha Edited', '/edited');
    assert.ok((await wc.executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    await click(manager, 'remove-active-destination');
    await click('.ribbon-manager button[aria-label="Remove Fixture Alpha Edited shortcut"]', 'remove-alpha');
    await until(() => wc.isDestroyed(), 'removed native contents destroyed');
    await click(pick('.ribbon-manager button', 'Close'), 'close-remove');
    assert.ok(!(await prefs()).websites.some(site => site.id === alphaID));
    await addSite('Fixture Alpha Restored', '/alpha');
    await openSite('Fixture Alpha Restored', '/alpha');
    assert.ok((await contents('/alpha').executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'), 'Removing shortcut never clears shared login/session data');
    const before = await prefs();
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await Promise.race([reloaded, delay(30000).then(() => { throw new Error('Renderer reload did not finish'); })]);
    await waitFor(() => window.wuu && document.querySelector('.sidebar-ribbon-main'), undefined, 'reloaded workbench ready', 30000);
    assert.deepEqual(await prefs(), before, 'Saved order and destinations survive renderer restart');
    const order = await evaluate(() => [...document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')].map(node => node.dataset.ribbonId));
    assert.deepEqual(order, before.order.filter(id => order.includes(id)));
    await openSite('Fixture Alpha Restored', '/alpha');
    assert.ok((await contents('/alpha').executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    await capture('saved-destinations-after-restart'); return { before, order, sharedCookieRetained: true };
  });

  await testNative('authored extension uses shared native website and unloads cleanly', async () => {
    await click(plugins, 'open-extension-inventory'); await hidden('extension inventory');
    await click(pick('.sidebar-section-item', 'Plugins'), 'select-plugin-inventory');
    await waitFor(() => document.querySelector('.catalog-row-open[aria-label*="Acceptance Webpage"]'));
    await click('.catalog-row-open[aria-label*="Acceptance Webpage"]', 'review-authored-extension');
    await click(pick('.settings-detail-actions button', 'Approve and enable'), 'approve-authored-local-fixture');
    await waitFor(() => document.querySelector('.sidebar-ribbon-main button[aria-label="Fixture Website"]'), undefined, 'production extension activation', 20000);
    const wc = await openSite('Fixture Website', '/extension');
    security(wc);
    assert.ok((await wc.executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    await capture('extension-native-website');
    await click(conversations, 'extension-to-chat'); await hidden('extension off-stage');
    await openSite('Fixture Website', '/extension');
    await click(plugins, 'disable-extension-inventory');
    await click(pick('.sidebar-section-item', 'Plugins'), 'plugin-details-for-disable');
    if (await evaluate(() => !!document.querySelector('.catalog-row-open[aria-label*="Acceptance Webpage"]'))) await click('.catalog-row-open[aria-label*="Acceptance Webpage"]', 'open-enabled-fixture');
    await click('button[role="switch"][aria-label="Turn off Acceptance Webpage"]', 'disable-authored-extension');
    await waitFor(() => !document.querySelector('.sidebar-ribbon-main button[aria-label="Fixture Website"]'));
    await until(() => !contents('/extension'), 'disabled extension native contents destroyed');
    await capture('extension-disabled-cleanly');
    return { sharedCookieRetained: true, navigationRemoved: true, nativeContentsDestroyed: true };
  });
  await goConversations();
  report.websiteFixture = { origin, requestCount: fixture.requests.length, externalAccounts: false, authoredExtension: true };
}
module.exports = { createWebsiteFixture, runWebsiteAcceptance };
