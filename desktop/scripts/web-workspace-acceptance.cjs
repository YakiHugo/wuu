// Real native website journeys, run by workbench-acceptance-e2e.cjs under Xvfb.
// The only website and executable extension are authored disposable fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { BrowserWindow, dialog, nativeImage, session, webContents } = require('electron');
const { prepareMediaFixture, serveMediaFixture, runBrowserMediaAcceptance } = require('./browser-media-acceptance.cjs');

async function createWebsiteFixture(home) {
  const requests = [];
  const controls = { offline: true };
  const media = prepareMediaFixture(home);
  const downloadBytes = Buffer.from('Synthetic Wuu browser download.\n'.repeat(128));
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://fixture.test');
      requests.push({ method: request.method, path: url.pathname, body, cookie: request.headers.cookie || '' });
      if (serveMediaFixture(request, response, url, media)) return;
      if (url.pathname === '/offline' && controls.offline) { response.destroy(); return; }
      if (url.pathname === '/download') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.txt"', 'Content-Length': downloadBytes.length });
        response.end(downloadBytes); return;
      }
      if (url.pathname === '/slow-download') {
        const chunk = Buffer.alloc(65536, 'w'); let count = 0;
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow-fixture.bin"', 'Content-Length': chunk.length * 160 });
        const timer = setInterval(() => { response.write(chunk); if (++count === 160) { clearInterval(timer); response.end(); } }, 100);
        response.once('close', () => clearInterval(timer)); return;
      }
      if (url.pathname === '/cookie') {
        response.writeHead(302, { Location: '/alpha', 'Set-Cookie': 'wuu_acceptance=synthetic-session; Path=/; Max-Age=86400; SameSite=Lax' });
        response.end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><title>Local fixture ${url.pathname}</title>
<style>body{font:18px system-ui;margin:0;background:#edf4fa;color:#17354a}main{padding:42px;max-width:850px}h1{font-weight:500}input,button,a{font:inherit;margin:8px 12px 8px 0;padding:10px}a{display:inline-block}input{width:330px}pre{white-space:pre-wrap;padding:18px;background:white;border-radius:12px}button{cursor:pointer}</style>
<main><p>Wuu · isolated local website fixture</p><h1>${url.pathname}</h1><p>No external service, account, or model is contacted.</p><p>Find marker: fixture one, fixture two, fixture three.</p>
<label>Retained page draft <input id="draft" placeholder="Type a retained website draft"></label>
<p><a id="next" href="/next">Next page</a><a id="cookie" href="/cookie">Set synthetic session cookie</a></p>
<button id="blank">Open blank popup + postMessage</button>
<form action="/posted" method="post" target="_blank"><input type="hidden" name="fixture" value="post-preserved"><button id="post">Open POST popup</button></form>
<p><a id="download" href="/download">Download synthetic text</a><a id="slow-download" href="/slow-download">Slow synthetic download</a></p>
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
  return { origin, requests, controls, downloadBytes, media, close: () => server.close() };
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
  const nativeView = pathname => views().find(view => view.getVisible() && view.webContents.getURL() === origin + pathname) || views().find(view => view.webContents.getURL() === origin + pathname);
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
    report.screenshots.push({ file: name, source: 'x11-whole-native-window', sha256: createHash('sha256').update(taken.stdout).digest('hex'), atMs: Date.now() - started, image: image.getSize(), window: bounds,
      nativeViews: win.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed()).map(view => ({ id: view.webContents.id, url: view.webContents.getURL(), visible: view.getVisible(), focused: view.webContents.isFocused(), bounds: view.getBounds(), zoom: view.webContents.getZoomFactor() })),
      activeElement: await evaluate(() => document.activeElement?.outerHTML.slice(0, 240)) });
    save(); await delay(160);
  }
  function xinput(args) {
    const result = spawnSync('xdotool', args, { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }
  async function click(target, label, evidence = true) {
    if (evidence) await capture(`before-${label}`);
    // Bundled navigation can finish mounting after a renderer reload. Measure
    // immediately before the real click, not before the slower X11 capture.
    const p = await point(target);
    const bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(bounds.x + p.x * zoom)), String(Math.round(bounds.y + p.y * zoom)), 'click', '1']);
    report.actions.push({ label: `web-${label}`, input: 'native-x11', atMs: Date.now() - started, point: p });
    await settle();
    if (evidence) await capture(`after-${label}`);
  }
  async function pageClick(wc, selector, label) {
    const view = win.contentView.children.find(view => view.webContents === wc);
    await until(() => view?.getVisible() && !wc.isDestroyed(), 'Native website is actually visible before page input');
    const p = await wc.executeJavaScript(`(async () => { const node=document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
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
  async function chromeGeometry() {
    const geometry = await evaluate(() => {
      const root = document.querySelector('.web-workspace-stage:not([hidden]) [data-wuu-component="web-workspace"]');
      const rect = selector => {
        const r = root.querySelector(selector).getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, centerY: r.top + r.height / 2 };
      };
      return {
        toolbar: rect('.web-workspace-toolbar'), navigation: rect('.workspace-browser-nav-cluster'),
        address: rect('.web-workspace-address'), input: rect('.workspace-browser-url-input'), actions: rect('.web-workspace-actions'),
        tab: rect('.web-workspace-tab[data-active]'), close: rect('.web-workspace-tab[data-active] .web-workspace-tab-close'), add: rect('.web-workspace-new-tab'),
      };
    });
    const { toolbar, navigation, address: field, input, actions, tab, close, add } = geometry;
    assert.ok(Math.max(navigation.centerY, field.centerY, actions.centerY) - Math.min(navigation.centerY, field.centerY, actions.centerY) <= 1,
      `Browser navigation, address and actions stay on one centerline: ${JSON.stringify(geometry)}`);
    assert.ok(navigation.left >= toolbar.left && navigation.right <= field.left && field.right <= actions.left && actions.right <= toolbar.right,
      `Browser controls remain ordered and inside the toolbar: ${JSON.stringify(geometry)}`);
    assert.ok(input.width >= 48, `The address remains editable at the supported narrow width: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(tab.centerY - close.centerY) <= 1 && Math.abs(close.centerY - add.centerY) <= 1,
      `Tab close and add controls share the tab centerline: ${JSON.stringify(geometry)}`);
    return geometry;
  }
  async function assertMenuBackdrop(label) {
    await hidden(label);
    const selector = '.web-workspace-stage:not([hidden]) .web-workspace-backdrop';
    await waitFor(selector => {
      const image = document.querySelector(selector);
      return image?.complete && image.naturalWidth > 100 && image.naturalHeight > 100 && image.getBoundingClientRect().width > 100;
    }, selector, `${label}: real page snapshot decoded behind menu`);
    const source = await evaluate(selector => document.querySelector(selector).src, selector);
    const image = nativeImage.createFromDataURL(source);
    const bitmap = image.getBitmap(), colors = new Set();
    for (let i = 0; i + 3 < bitmap.length; i += 4 * 97) colors.add(bitmap.readUInt32LE(i));
    assert.ok(colors.size > 12, 'Snapshot has actual nonblank page content, not a flat placeholder');
    report.actions.push({ label: `${label}-snapshot`, atMs: Date.now() - started, image: image.getSize(), sampledColors: colors.size, sha256: createHash('sha256').update(image.toPNG()).digest('hex') });
    save();
  }
  async function openSite(name, pathname) {
    await click(ribbon(name), `open-${name}`);
    await waitFor(() => [...document.querySelectorAll('[data-wuu-component="web-workspace"]')].some(node => node.getBoundingClientRect().width > 0));
    const id = await evaluate(() => [...document.querySelectorAll('[data-wuu-component="web-workspace"]')].find(node => node.getBoundingClientRect().width > 0).dataset.websiteId);
    const state = await evaluate(({ id, url }) => window.wuu.webWorkspace.open({ id, url, tabs: Boolean(document.querySelector('.web-workspace-stage:not([hidden]) .web-workspace-tabs')) }), { id, url: origin + pathname });
    if (state.url !== origin + pathname || state.error) {
      // Independent journey setup only. Address-bar behavior has its own real
      // native Return assertion and a failed navigation is never erased.
      report.actions.push({ label: 'reset-independent-website-fixture', setupOnly: true, from: state.url, to: origin + pathname, atMs: Date.now() - started });
      await evaluate(({ id, url }) => window.wuu.webWorkspace.command(id, 'navigate', url), { id, url: origin + pathname });
    }
    await until(() => nativeView(pathname)?.getVisible() && !nativeView(pathname).webContents.isLoading(), `visible fixture ${pathname}`);
    return nativeView(pathname).webContents;
  }
  async function navigateAddress(pathname, label) {
    await fill(address, pathname.startsWith('http') ? pathname : origin + pathname);
    await capture(`before-address-submit-${label}`);
    xinput(['key', '--clearmodifiers', 'Return']);
    report.actions.push({ label: `native-address-submit-${label}`, input: 'native-x11-Return', atMs: Date.now() - started });
    await until(() => nativeView(pathname)?.getVisible() && !nativeView(pathname).webContents.isLoading(), `native address navigation ${pathname}`);
  }
  async function addSite(name, pathname) {
    await click(manager, 'customize-navigation');
    await click(pick('.ribbon-manager button', 'Add website'), 'add-website');
    await fill(formName, name); await fill(formURL, pathname.startsWith('http') ? pathname : origin + pathname);
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
    await navigateAddress('/alpha', 'return-from-history');
    assert.equal(wc.getURL(), origin + '/alpha');
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
      for (const [theme, size, width, zoom] of [['light', 15, 700, 1], ['light', 20, 440, 1], ['light', 20, 960, 1], ['dark', 20, 1440, 1.25]]) {
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
        const chrome = await chromeGeometry();
        if (width === 700) {
          const before = win.getBounds(), outer = win.getContentBounds();
          const drag = await evaluate(() => {
            const stage = document.querySelector('.web-workspace-stage:not([hidden])');
            const strip = stage.querySelector('.web-workspace-tabstrip').getBoundingClientRect();
            const add = stage.querySelector('.web-workspace-new-tab').getBoundingClientRect();
            return { x: (add.right + strip.right) / 2, y: strip.top + strip.height / 2 };
          });
          const x = Math.round(outer.x + drag.x * zoom), y = Math.round(outer.y + drag.y * zoom);
          try {
            await capture('before-tabstrip-drag');
            report.actions.push({ label: 'native-browser-tabstrip-drag-start', input: 'native-x11', point: { x, y }, before, atMs: Date.now() - started });
            save();
            xinput(['mousemove', '--sync', String(x), String(y), 'mousedown', '1']);
            // Yield between native events: Electron must process the press to
            // enter its window-manager move loop before motion and release.
            await delay(100);
            for (let step = 1; step <= 5; step++) {
              xinput(['mousemove', String(x + step * 10), String(y + step * 8)]);
              await delay(40);
            }
            await until(() => Math.abs(win.getBounds().x - before.x) >= 20 || Math.abs(win.getBounds().y - before.y) >= 20,
              'Dragging empty browser tab strip moves the actual native window');
            xinput(['mouseup', '1']);
            await settle();
            report.actions.push({ label: 'native-browser-tabstrip-drag', input: 'native-x11', before, after: win.getBounds(), atMs: Date.now() - started });
            await capture('after-tabstrip-drag');
          } finally {
            xinput(['mouseup', '1']); await delay(40);
            xinput(['key', '--clearmodifiers', 'Escape']); await settle();
            win.setBounds(before);
            await until(() => ['x', 'y', 'width', 'height'].every(key => Math.abs(win.getBounds()[key] - before[key]) <= 1),
              'Native drag cleanup restores the original window bounds');
          }
        }
        await capture(`bounds-${theme}-${width}-zoom-${zoom}`);
        samples.push({ theme, size, width, zoom, bounds, chrome });
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
    const grouped = await evaluate(() => Boolean(document.querySelector('.web-workspace-stage:not([hidden]) .web-workspace-tabs')));
    const tabsBefore = await evaluate(() => document.querySelectorAll('.web-workspace-stage:not([hidden]) .web-workspace-tabs [role=tab]').length);
    await pageClick(wc, '#post', 'open-post-popup');
    await until(() => fixture.requests.some(request => request.path === '/posted' && request.method === 'POST' && request.body === 'fixture=post-preserved'), 'native POST body preserved');
    await until(() => contents('/posted') && !contents('/posted').isLoading(), 'POST popup loaded');
    const post = contents('/posted'); security(post); await capture('post-popup');
    if (grouped) {
      assert.ok(nativeView('/posted')?.getVisible(), 'Ordinary target=_blank POST opens in the destination tab group');
      assert.equal(await evaluate(() => document.querySelectorAll('.web-workspace-stage:not([hidden]) .web-workspace-tabs [role=tab]').length), tabsBefore + 1);
      await click('.web-workspace-stage:not([hidden]) .web-workspace-tab[data-active] .web-workspace-tab-close', 'close-post-tab');
    } else {
      const popup = BrowserWindow.fromWebContents(post); assert.ok(popup && popup !== win); popup.close();
    }
    win.focus();
    return { openerRoundtrip: true, ordinaryPostMode: grouped ? 'tab' : 'popup', post: fixture.requests.find(request => request.path === '/posted') };
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

  const liveStage = '.web-workspace-stage:not([hidden])';
  const readSite = () => evaluate(({ id, url }) => window.wuu.webWorkspace.open({ id, url, tabs: true }), { id: alphaID, url: origin + '/alpha' });
  let clearedHistoryURL;

  await testNative('grouped tabs native shortcuts find and per-page zoom', async () => {
    let wc = await openSite('Fixture Alpha', '/alpha');
    const before = (await readSite()).tabs.length;
    await click(`${liveStage} .web-workspace-new-tab`, 'click-add-tab');
    await waitFor(({ stage, count }) => document.querySelectorAll(`${stage} [role=tab]`).length === count,
      { stage: liveStage, count: before + 1 });
    await click(`${liveStage} .web-workspace-tab[data-active] .web-workspace-tab-close`, 'click-close-tab');
    await waitFor(({ stage, count }) => document.querySelectorAll(`${stage} [role=tab]`).length === count,
      { stage: liveStage, count: before });
    await until(() => nativeView('/alpha')?.getVisible(), 'Native tab buttons remain clickable inside the draggable strip');
    await pageClick(wc, '#draft', 'native-tab-shortcut-focus'); xinput(['key', '--clearmodifiers', 'ctrl+t']);
    await waitFor(({ stage, count }) => document.querySelectorAll(`${stage} [role=tab]`).length === count && document.activeElement?.matches('.workspace-browser-url-input'), { stage: liveStage, count: before + 1 });
    await hidden('new blank tab');
    await navigateAddress('/tab-two', 'new-tab'); wc = nativeView('/tab-two').webContents;
    report.nativeFindEvents ||= [];
    wc.on('found-in-page', (_event, result) => { report.nativeFindEvents.push({ contentsID: wc.id, result, atMs: Date.now() - started }); save(); });
    await pageClick(wc, '#draft', 'native-find-shortcut-focus'); xinput(['key', '--clearmodifiers', 'ctrl+f']);
    const findInput = `${liveStage} .web-workspace-findbar input`;
    await waitFor(selector => document.activeElement?.matches(selector), findInput);
    await fill(findInput, 'fixture');
    await until(async () => (await readSite()).findResult?.matches > 1, 'native find returns multiple matches');
    const found = (await readSite()).findResult;
    await click(`${liveStage} button[aria-label="Next match"]`, 'next-native-find-match');
    await until(async () => (await readSite()).findResult?.activeMatchOrdinal !== found.activeMatchOrdinal, 'next find result selected');
    await chromeGeometry();
    await capture('tabs-and-native-find');
    await click(`${liveStage} button[aria-label="Close find"]`, 'close-native-find');
    await click(`${liveStage} button[aria-label="Browser options"]`, 'browser-options');
    await click('.web-workspace-menu button[aria-label="Zoom in"]', 'zoom-website-in');
    await until(() => wc.getZoomFactor() > 1, 'actual native website zoom increased');
    const zoom = wc.getZoomFactor();
    await click('.web-workspace-menu button[aria-label="Reset zoom"]', 'reset-website-zoom');
    await until(() => wc.getZoomFactor() === 1, 'actual native zoom reset'); xinput(['key', 'Escape']);
    await pageClick(wc, '#draft', 'native-close-tab-focus'); xinput(['key', '--clearmodifiers', 'ctrl+w']);
    await until(async () => !win.isDestroyed() && (await readSite()).tabs.length === before, 'native Ctrl+W closes one tab only');
    wc = nativeView('/alpha').webContents;
    await pageClick(wc, '#draft', 'native-reopen-tab-focus'); xinput(['key', '--clearmodifiers', 'ctrl+shift+t']);
    await until(async () => (await readSite()).tabs.length === before + 1 && nativeView('/tab-two')?.getVisible(), 'native reopen restores closed tab');
    await click(address, 'address-focused-close-tab'); xinput(['key', '--clearmodifiers', 'ctrl+w']);
    await until(async () => !win.isDestroyed() && (await readSite()).tabs.length === before, 'address-focused Ctrl+W closes only the active tab');
    return { originalTabs: before, find: found, zoom, windowSurvived: !win.isDestroyed() };
  });

  await testNative('native downloads complete pause resume and cancel safely', async () => {
    const wc = await openSite('Fixture Alpha', '/alpha');
    const partition = session.fromPartition('persist:wuu-browser');
    const directory = path.join(output, 'synthetic-downloads'); fs.mkdirSync(directory, { recursive: true });
    const saveFixture = (_event, item) => {
      if ([origin + '/download', origin + '/slow-download'].includes(item.getURL())) item.setSavePath(path.join(directory, item.getFilename()));
    };
    // Only the fixture's OS save-picker destination is predetermined. Native
    // transfer bytes/events, UI controls and ownership remain production code.
    partition.on('will-download', saveFixture);
    const downloads = () => evaluate(() => window.wuu.webWorkspace.listDownloads());
    const menu = '[data-web-workspace-downloads-trigger]';
    try {
      await pageClick(wc, '#download', 'download-synthetic-file');
      await until(async () => (await downloads()).some(item => item.filename === 'fixture.txt' && item.state === 'completed'), 'download completed');
      const completed = (await downloads()).find(item => item.filename === 'fixture.txt');
      assert.deepEqual(fs.readFileSync(completed.savePath), fixture.downloadBytes, 'Downloaded bytes match the synthetic response');
      await click(menu, 'open-downloads'); await assertMenuBackdrop('downloads panel');
      await waitFor(id => document.querySelector(`[data-download-id="${id}"] [data-download-command="reveal"]`), completed.id);
      await capture('completed-download'); xinput(['key', 'Escape']);
      await until(() => nativeView('/alpha')?.getVisible(), 'restore after downloads');
      await pageClick(wc, '#slow-download', 'start-cancellable-download');
      await until(async () => (await downloads()).some(item => item.filename === 'slow-fixture.bin' && item.receivedBytes > 0 && !item.done), 'streaming download made progress');
      const transfer = (await downloads()).find(item => item.filename === 'slow-fixture.bin');
      const action = command => `[data-download-id="${transfer.id}"] [data-download-command="${command}"]`;
      await click(menu, 'manage-live-download');
      await click(action('pause'), 'pause-download');
      await until(async () => (await downloads()).find(item => item.id === transfer.id)?.paused, 'download paused');
      await click(action('resume'), 'resume-download');
      await until(async () => !(await downloads()).find(item => item.id === transfer.id)?.paused, 'download resumed');
      await click(action('cancel'), 'cancel-download');
      await until(async () => (await downloads()).find(item => item.id === transfer.id)?.state === 'cancelled', 'download cancellation completed');
      await capture('cancelled-download'); xinput(['key', 'Escape']);
      return { completed: { filename: completed.filename, bytes: completed.receivedBytes, sha256: createHash('sha256').update(fixture.downloadBytes).digest('hex') }, cancelled: transfer.id, nativeSavePicker: 'fixture path preselected, not exercised' };
    } finally { partition.removeListener('will-download', saveFixture); }
  });

  await testNative('bookmarks history search and clearing preserve private saved state', async () => {
    await openSite('Fixture Alpha', '/alpha');
    await click('[data-browser-bookmark-current]', 'bookmark-local-page');
    await waitFor(() => document.querySelector('[data-browser-bookmark-current]')?.getAttribute('aria-pressed') === 'true');
    await navigateAddress('/history-target', 'history-page');
    await click('[data-browser-library-trigger]', 'open-browser-library'); await assertMenuBackdrop('browser library');
    await fill('[data-browser-library] input[type=search]', 'history-target');
    await waitFor(url => document.querySelector(`[data-library-url="${url}"]`), origin + '/history-target');
    await capture('searched-browser-history');
    await click('[data-library-section="bookmarks"]', 'show-bookmarks');
    await fill('[data-browser-library] input[type=search]', 'alpha');
    await click(`[data-library-url="${origin}/alpha"]`, 'open-saved-bookmark');
    await until(() => nativeView('/alpha')?.getVisible() && !nativeView('/alpha').webContents.isLoading(), 'bookmark navigated');
    await click('[data-browser-library-trigger]', 'clear-fixture-history');
    await click('[data-library-section="history"]', 'history-section');
    await fill('[data-browser-library] input[type=search]', '');
    await click('[data-library-clear-history]', 'review-clear-history');
    await click('[data-library-confirm-clear]', 'confirm-clear-synthetic-history');
    await until(async () => (await evaluate(() => window.wuu.webWorkspace.library.getState())).history.length === 0, 'history cleared');
    const state = await evaluate(() => window.wuu.webWorkspace.library.getState());
    assert.ok(state.bookmarks.some(bookmark => bookmark.url === origin + '/alpha'), 'Clearing history retains bookmarks');
    clearedHistoryURL = origin + '/history-target';
    await capture('cleared-history-retained-bookmark'); xinput(['key', 'Escape']);
    return { history: state.history.length, bookmarks: state.bookmarks.length };
  });

  await testNative('failed website navigation retries requested destination', async () => {
    await openSite('Fixture Alpha', '/alpha'); fixture.controls.offline = true;
    await fill(address, origin + '/offline'); xinput(['key', '--clearmodifiers', 'Return']);
    await waitFor(() => document.querySelector('.web-workspace-stage:not([hidden]) .web-workspace-message[role=alert]'));
    await capture('failed-requested-destination');
    fixture.controls.offline = false;
    await click(pick(`${liveStage} .web-workspace-message button`, 'Try again'), 'retry-requested-destination');
    await until(() => nativeView('/offline')?.getVisible() && !nativeView('/offline').webContents.isLoading(), 'retry loads requested URL, not previous page');
    await capture('retried-requested-destination'); return { url: nativeView('/offline').webContents.getURL() };
  });

  await runBrowserMediaAcceptance({ win, report, output, started, save, testNative, openSite, pageClick, navigateAddress, readSite, nativeView, until, evaluate, fill, address, capture, xinput, delay }, fixture);

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
    const library = await evaluate(() => window.wuu.webWorkspace.library.getState());
    if (clearedHistoryURL) {
      assert.ok(!library.history.some(entry => entry.url === clearedHistoryURL), 'Renderer restart does not restore cleared history');
      assert.ok(library.bookmarks.some(entry => entry.url === origin + '/alpha'), 'Bookmark survives renderer restart');
    }
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
    await pageClick(wc, '#draft', 'type-retained-extension-draft'); await wc.insertText('Retain this extension draft across Chat');
    await capture('extension-native-website');
    await click(conversations, 'extension-to-chat'); await hidden('extension off-stage');
    assert.ok(!wc.isDestroyed(), 'Hidden plugin page remains alive');
    const restored = await openSite('Fixture Website', '/extension');
    assert.equal(restored.id, wc.id, 'Returning activates the exact existing plugin page');
    assert.equal(await restored.executeJavaScript('document.querySelector("#draft").value'), 'Retain this extension draft across Chat');
    await click(plugins, 'disable-extension-inventory');
    await click(pick('.sidebar-section-item', 'Plugins'), 'plugin-details-for-disable');
    if (await evaluate(() => !!document.querySelector('.catalog-row-open[aria-label*="Acceptance Webpage"]'))) await click('.catalog-row-open[aria-label*="Acceptance Webpage"]', 'open-enabled-fixture');
    await click('button[role="switch"][aria-label="Turn off Acceptance Webpage"]', 'disable-authored-extension');
    await waitFor(() => !document.querySelector('.sidebar-ribbon-main button[aria-label="Fixture Website"]'));
    await until(() => !contents('/extension'), 'disabled extension native contents destroyed');
    await capture('extension-disabled-cleanly');
    assert.ok(wc.isDestroyed());
    await click('button[role="switch"][aria-label="Turn on Acceptance Webpage"]', 're-enable-authored-extension');
    await waitFor(() => document.querySelector('.sidebar-ribbon-main button[aria-label="Fixture Website"]'), undefined, 'fixture re-enabled', 20000);
    const replacement = await openSite('Fixture Website', '/extension');
    assert.notEqual(replacement.id, wc.id, 'Re-enabled generation gets a new page');
    assert.equal(views().filter(view => view.webContents.getURL() === origin + '/extension').length, 1, 'Exactly one replacement plugin native page');
    return { sharedCookieRetained: true, hiddenPageRetained: true, retainedDraft: true, oldGenerationDestroyed: true, singleReplacementPage: true };
  });
  if (report.checks.every(check => check.status === 'passed') && report.errors.length === 0) {
    const optional = { name: 'Public Notion landing page', required: false, status: 'unavailable' };
    try {
      await addSite('Public Notion preview', 'https://www.notion.com/');
      await click(ribbon('Public Notion preview'), 'optional-public-notion');
      await until(() => win.contentView.children.some(view => view.webContents && !view.webContents.isDestroyed() && view.getVisible() && /^https:\/\/(?:www\.)?notion\.(?:com|so)\//.test(view.webContents.getURL()) && !view.webContents.isLoading()), 'optional public site', 10000);
      optional.status = 'loaded';
      await capture('optional-public-notion');
    } catch (error) { optional.error = String(error); try { await capture('optional-public-site-unavailable'); } catch {} }
    report.optionalEvidence = [optional]; save();
  }
  await goConversations();
  report.websiteFixture = { origin, requestCount: fixture.requests.length, externalAccounts: false, authoredExtension: true };
}
module.exports = { createWebsiteFixture, runWebsiteAcceptance };
