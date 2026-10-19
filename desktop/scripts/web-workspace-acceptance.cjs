// Real native website journeys, run by workbench-acceptance-e2e.cjs under Xvfb.
// The only website and executable extension are authored disposable fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, dialog, nativeImage, session, webContents } = require('electron');
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
      if (url.pathname === '/loading-hold') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.write('<!doctype html><title>Controlled loading fixture</title><body style="font:24px system-ui;padding:48px;background:#edf4fa;color:#17354a"><h1>Loading fixture</h1><p>This local response stays open until Stop is clicked.</p>');
        controls.finishLoading = () => response.end('</body>');
        const timer = setTimeout(controls.finishLoading, 20000);
        response.once('close', () => { clearTimeout(timer); controls.finishLoading = null; });
        return;
      }
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
  const addTabButton = '.sidebar-ribbon-add';
  const webTabs = '[data-wuu-component="website-navigation-item"]';
  const tabButton = id => `${webTabs}[data-ribbon-id="${id}"]`;
  const siteIDs = new Map();
  const ribbonGroup = 'ribbon-browser';
  const readSite = () => evaluate(() => window.wuu.webWorkspace.initializeTabs([]));
  const webRoot = '[data-wuu-component="web-workspace"]';
  const address = `${webRoot} .web-workspace-toolbar .workspace-browser-url-input`;
  const startInput = '.web-workspace-stage:not([hidden]) .web-workspace-start-search input';
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
      nativeFocus: { ownerFocused: win.isFocused(), ownerFullscreen: win.isFullScreen(), focusedContentsID: webContents.getFocusedWebContents()?.id ?? null },
      nativeViews: win.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed()).map(view => ({ id: view.webContents.id, url: view.webContents.getURL(), visible: view.getVisible(), focused: view.webContents.isFocused(), bounds: view.getBounds(), zoom: view.webContents.getZoomFactor() })),
      activeElement: await evaluate(() => document.activeElement?.outerHTML.slice(0, 240)) });
    save(); await delay(160);
  }
  function xinput(args) {
    const result = spawnSync('xdotool', args, { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }
  async function leaveRail() {
    const outer = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(outer.x + Math.min(300, outer.width / zoom - 20) * zoom)), String(Math.round(outer.y + 90 * zoom))]);
    await settle();
  }
  async function hoverTab(id) {
    const p = await point(tabButton(id)), outer = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(outer.x + 26 * zoom)), String(Math.round(outer.y + p.y * zoom))]);
    await waitFor(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded === 'true');
  }
  async function finishRailInteraction(wc, label) {
    await leaveRail();
    if (await evaluate(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded === 'true')) {
      // Escape/Tab can correctly retain keyboard focus in the expanded rail.
      // A real click back into browser chrome ends that interaction explicitly.
      await click(address, `${label}-return-to-browser-chrome`, false);
    }
    await waitFor(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded !== 'true');
    if (wc) await until(() => !wc.isDestroyed() && win.contentView.children.some(view => view.webContents === wc && view.getVisible()), `${label}: leaving rail restores the same native page`);
  }
  async function click(target, label, evidence = true, retainHover = false) {
    if (evidence) await capture(`before-${label}`);
    // Bundled navigation can finish mounting after a renderer reload. Measure
    // immediately before the real click, not before the slower X11 capture.
    const p = await point(target);
    const inRail = await evaluate(p => Boolean(document.elementFromPoint(p.x, p.y)?.closest('.sidebar-ribbon')), p);
    const bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(bounds.x + p.x * zoom)), String(Math.round(bounds.y + p.y * zoom)), 'click', '1']);
    report.actions.push({ label: `web-${label}`, input: 'native-x11', atMs: Date.now() - started, point: p });
    await settle();
    if (evidence) await capture(`after-${label}`);
    if (inRail && !retainHover) await leaveRail();
  }
  async function mascotGaze() {
    const selector = '.web-workspace-stage:not([hidden]) .web-workspace-start-mascot';
    await waitFor(selector => document.querySelector(selector)?.querySelector('.web-workspace-start-mascot-eyes'), selector);
    await evaluate(selector => {
      const svg = document.querySelector(selector), eyes = svg.querySelector('.web-workspace-start-mascot-eyes');
      const rect = svg.getBoundingClientRect, computed = window.getComputedStyle;
      const probe = { svg, eyes, reads: 0, mutations: 0 };
      svg.getBoundingClientRect = function (...args) { probe.reads++; return rect.apply(this, args); };
      window.getComputedStyle = function (element, ...args) { if (element === svg || svg.contains(element)) probe.reads++; return computed.call(this, element, ...args); };
      const observer = new MutationObserver(records => { probe.mutations += records.length; });
      observer.observe(svg, { subtree: true, attributes: true, attributeFilter: ['transform', 'd', 'style'] });
      probe.cleanup = () => { observer.disconnect(); delete svg.getBoundingClientRect; window.getComputedStyle = computed; delete window.__wuuMascotAcceptance; };
      window.__wuuMascotAcceptance = probe;
    }, selector);
    const states = [];
    for (const direction of [-1, 1]) {
      const target = await evaluate(({ selector, direction }) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: Math.max(64, Math.min(innerWidth - 24, r.x + r.width / 2 + direction * 180)), y: r.y + r.height / 2 };
      }, { selector, direction });
      const bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
      xinput(['mousemove', String(Math.round(bounds.x + target.x * zoom)), String(Math.round(bounds.y + target.y * zoom))]);
      await waitFor(direction => {
        const eyes = window.__wuuMascotAcceptance.eyes;
        return eyes.transform.baseVal.consolidate()?.matrix.e * direction > 0;
      }, direction);
      await capture(direction < 0 ? 'mascot-pointer-left' : 'mascot-pointer-right');
      states.push(await evaluate(() => {
        const { eyes } = window.__wuuMascotAcceptance, r = eyes.getBoundingClientRect();
        return { transform: eyes.getAttribute('transform'), centerX: r.x + r.width / 2 };
      }));
    }
    assert.ok(states[1].centerX > states[0].centerX + 0.5, 'Actual eye geometry follows left and right native pointer input');
    await evaluate(() => { const p = window.__wuuMascotAcceptance; p.reads = p.mutations = 0; });
    await delay(400);
    const idle = await evaluate(() => ({ reads: window.__wuuMascotAcceptance.reads, mutations: window.__wuuMascotAcceptance.mutations }));
    assert.deepEqual(idle, { reads: 0, mutations: 0 }, 'Settled mascot does not poll geometry/styles or mutate eye artwork while idle');
    return { states, idle, idleMs: 400 };
  }
  async function mascotUnmount() {
    await waitFor(() => !window.__wuuMascotAcceptance.svg.isConnected);
    await delay(80);
    await evaluate(() => { const p = window.__wuuMascotAcceptance; p.reads = p.mutations = 0; });
    const bounds = win.getContentBounds();
    xinput(['mousemove', String(bounds.x + 100), String(bounds.y + 60)]);
    await delay(120);
    const result = await evaluate(() => {
      const p = window.__wuuMascotAcceptance;
      return { detached: !p.svg.isConnected, reads: p.reads, mutations: p.mutations };
    });
    assert.deepEqual(result, { detached: true, reads: 0, mutations: 0 }, 'Navigating away releases mascot pointer work');
    await evaluate(() => window.__wuuMascotAcceptance.cleanup());
    return result;
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
  async function verticalTabGeometry(expanded = false) {
    const geometry = await evaluate(() => {
      const bar = document.querySelector('.sidebar-ribbon'), r = bar.getBoundingClientRect();
      const rows = [...bar.querySelectorAll('.sidebar-ribbon-tab-row')].map(row => {
        const button = row.querySelector('[data-ribbon-id]'), title = button.querySelector('.sidebar-ribbon-label');
        const close = row.querySelector('.sidebar-ribbon-close'), tr = title.getBoundingClientRect();
        return { id: button.dataset.ribbonId, web: button.dataset.wuuComponent === 'website-navigation-item',
          title: title.textContent, titleWidth: tr.width, titleVisible: tr.width > 0 && getComputedStyle(title).visibility === 'visible',
          close: Boolean(close), active: button.getAttribute('aria-current') === 'page',
          closeVisible: close ? close.getBoundingClientRect().width > 0 && getComputedStyle(close).visibility === 'visible' && Number(getComputedStyle(close).opacity) > 0.95 : false };
      });
      return { width: r.width, expanded: bar.dataset.expanded === 'true', viewportWidth: innerWidth, rows };
    });
    assert.equal(geometry.expanded, expanded, `Rail expansion follows the current interaction: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.width - (expanded ? 200 : 52)) <= 1, `Rail is52px at rest and200px only while expanded: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.rows.every(row => row.title && (expanded ? row.titleVisible && row.titleWidth >= 20 : !row.titleVisible)), 'Destination labels appear only in the expanded overlay');
    assert.ok(geometry.rows.some(row => row.id === 'conversations' && !row.close), 'Built-in Chat has no close button');
    assert.ok(geometry.rows.every(row => row.close === row.web), 'Only real website tabs have direct close controls');
    assert.ok(geometry.rows.filter(row => row.web && row.active).every(row => row.closeVisible === expanded), 'Active web tab exposes its direct close control only in the expanded rail');
    return geometry;
  }
  async function traceLoadedTabSwitches() {
    const traces = [], originalBounds = win.getBounds();
    let current = await openSite('Fixture Alpha', '/alpha');
    try {
      for (const [pathname, width, mode] of [['/beta', 1280, 'keyboard'], ['/alpha', 1280, 'keyboard'], ['/beta', 960, 'keyboard'], ['/alpha', 960, 'pointer']]) {
        if (win.getContentSize()[0] !== width) { win.setContentSize(width, 900); await settle(); }
        await pageClick(current, '#draft', `focus-before-${mode}-tab-switch`);
        const incoming = views().find(view => view.webContents.getURL() === origin + pathname);
        assert.ok(incoming && !incoming.getVisible(), 'Switch target is an existing hidden native page');
        const trace = { pathname, width, mode, incomingID: incoming.webContents.id, calls: [], boundsIPC: [], frames: [], captures: [] };
        const capturePage = incoming.webContents.capturePage;
        incoming.webContents.capturePage = async function (...args) {
          const image = await capturePage.apply(this, args);
          trace.captures.push({ sha256: createHash('sha256').update(image.toPNG()).digest('hex'), pixels: image.getSize() });
          return image;
        };
        const restore = [() => { incoming.webContents.capturePage = capturePage; }], pending = [];
        for (const view of views()) for (const method of ['setVisible', 'setBounds']) {
          const original = view[method];
          view[method] = function (...args) {
            const result = original.apply(this, args);
            trace.calls.push({ contentsID: view.webContents.id, method, value: args[0], atMs: Date.now() - started, bounds: view.getBounds() });
            if (view === incoming && method === 'setVisible' && args[0] === true) pending.push(view.webContents.executeJavaScript(`new Promise(resolve => {
              const frames = []; const sample = () => { const r = document.querySelector('#draft').getBoundingClientRect();
                frames.push({ width: innerWidth, height: innerHeight, inputX: r.x, inputWidth: r.width });
                if (frames.length < 6) requestAnimationFrame(sample); else resolve(frames); }; requestAnimationFrame(sample);
            })`).then(frames => trace.frames.push(...frames)));
            return result;
          };
          restore.push(() => { view[method] = original; });
        }
        report.activeTabSwitchTrace = trace;
        try {
          if (mode === 'keyboard') xinput(['key', '--clearmodifiers', 'ctrl+Tab']);
          else {
            const before = win.contentView.children.find(view => view.webContents === current).getBounds();
            await click(tabButton(alphaID), 'pointer-switch-loaded-tab', false, true);
            await verticalTabGeometry(true);
            await assertMenuBackdrop('hovered incoming tab', incoming.webContents);
            const source = await evaluate(() => document.querySelector('.web-workspace-stage:not([hidden]) .web-workspace-backdrop').src);
            const snapshotHash = createHash('sha256').update(Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')).digest('hex');
            assert.ok(trace.captures.some(capture => capture.sha256 === snapshotHash), 'Hovered tab shows a fresh capture of the incoming native page');
            assert.deepEqual(incoming.getBounds(), before, 'Expanding the rail does not resize the incoming native viewport');
            await capture('hover-expanded-incoming-native-tab');
            await leaveRail();
          }
          await until(() => incoming.getVisible(), 'Incoming native tab becomes visible');
          await Promise.race([Promise.all(pending), delay(3000).then(() => { throw new Error('Native switch frame sampling timed out'); })]);
          await delay(120);
          trace.settled = incoming.getBounds();
          const visibility = trace.calls.filter(call => call.contentsID === incoming.webContents.id && call.method === 'setVisible').map(call => call.value);
          if (mode === 'keyboard') {
            assert.deepEqual(visibility, [true], 'No-overlay native keyboard switch reveals the incoming view once without a hide/show flash');
            assert.ok(!trace.boundsIPC.some(event => event.id === ribbonGroup && (event.bounds === null || event.bounds?.occluded)), 'Tab identity change does not tear down unchanged host bounds');
          }
          assert.ok(trace.frames.length >= 6 && trace.frames.every(frame => Math.abs(frame.width - trace.settled.width / incoming.webContents.getZoomFactor()) <= 2),
            `Incoming page has current viewport width from its first sampled frames: ${JSON.stringify(trace)}`);
          assert.ok(trace.frames.every(frame => Math.abs(frame.inputX - trace.frames[0].inputX) <= 1), 'Page content does not shift horizontally across reveal frames');
          current = incoming.webContents;
        } finally {
          restore.forEach(restore => restore()); delete report.activeTabSwitchTrace;
          traces.push(trace); (report.tabSwitchTraces ||= []).push(trace); save();
        }
      }
    } finally { win.setBounds(originalBounds); await settle(); }
    return traces;
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
        horizontalTabs: Boolean(root.querySelector('.web-workspace-tabstrip')),
        leftTabs: document.querySelectorAll('[data-wuu-component="website-navigation-item"]').length,
      };
    });
    const { toolbar, navigation, address: field, input, actions } = geometry;
    assert.ok(Math.max(navigation.centerY, field.centerY, actions.centerY) - Math.min(navigation.centerY, field.centerY, actions.centerY) <= 1,
      `Browser navigation, address and actions stay on one centerline: ${JSON.stringify(geometry)}`);
    assert.ok(navigation.left >= toolbar.left && navigation.right <= field.left && field.right <= actions.left && actions.right <= toolbar.right,
      `Browser controls remain ordered and inside the toolbar: ${JSON.stringify(geometry)}`);
    assert.ok(input.width >= 48, `The address remains editable at the supported narrow width: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.horizontalTabs, false, 'Web pages have one left tab and no nested horizontal tab strip');
    assert.ok(geometry.leftTabs > 0, 'Live website tabs remain reachable from the ribbon');
    return geometry;
  }
  async function dragBrowserToolbar() {
    const before = win.getBounds(), outer = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    const drag = await evaluate(() => {
      const bar = document.querySelector('.web-workspace-stage:not([hidden]) .web-workspace-toolbar');
      const r = bar.getBoundingClientRect(), actions = bar.querySelector('.web-workspace-actions').getBoundingClientRect();
      const x = (actions.right + r.right) / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
      return { x, y, gap: r.right - actions.right, region: getComputedStyle(hit).getPropertyValue('-webkit-app-region'),
        safe: bar.contains(hit) && !hit.closest('button,input,form,a,[role="button"]') };
    });
    assert.ok(drag.safe && drag.gap >= 4 && drag.region === 'drag', `Toolbar padding is a safe native drag target: ${JSON.stringify(drag)}`);
    const x = Math.round(outer.x + drag.x * zoom), y = Math.round(outer.y + drag.y * zoom);
    try {
      await capture('before-toolbar-padding-drag');
      report.actions.push({ label: 'native-toolbar-drag-start', input: 'native-x11', before, point: { x, y }, drag, atMs: Date.now() - started }); save();
      xinput(['mousemove', String(x), String(y), 'mousedown', '1']); await delay(100);
      for (let step = 1; step <= 5; step++) {
        xinput(['mousemove', String(x + step * 10), String(y + step * 8)]); await delay(40);
      }
      await until(() => Math.abs(win.getBounds().x - before.x) >= 20 || Math.abs(win.getBounds().y - before.y) >= 20,
        'Dragging empty browser toolbar padding moves the actual native window', 4000);
      xinput(['mouseup', '1']); await settle();
      report.actions.push({ label: 'native-toolbar-drag', input: 'native-x11', before, after: win.getBounds(), atMs: Date.now() - started }); save();
      await capture('after-toolbar-padding-drag');
    } finally {
      xinput(['mouseup', '1']); await delay(40);
      xinput(['key', '--clearmodifiers', 'Escape']); await settle();
      win.setBounds(before);
      await until(() => ['x', 'y', 'width', 'height'].every(key => Math.abs(win.getBounds()[key] - before[key]) <= 1),
        'Native toolbar drag cleanup restores original window bounds');
    }
    await click(toolbar('Browser options'), 'options-remains-clickable-after-drag', false);
    await waitFor(() => document.querySelector('button[aria-label="Browser options"]')?.getAttribute('aria-expanded') === 'true');
    xinput(['key', '--clearmodifiers', 'Escape']);
    await waitFor(() => document.querySelector('button[aria-label="Browser options"]')?.getAttribute('aria-expanded') === 'false');
    await click(address, 'address-remains-editable-after-drag', false);
    await until(() => win.webContents.isFocused(), 'Real address click retains shell keyboard focus');
    xinput(['key', '--clearmodifiers', 'ctrl+a']);
    assert.ok(await evaluate(selector => { const input = document.querySelector(selector); return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length; }, address), 'URL text remains selectable inside draggable toolbar');
    xinput(['type', '--clearmodifiers', '--delay', '0', origin + '/alpha']);
    await waitFor(({ selector, url }) => document.querySelector(selector).value === url, { selector: address, url: origin + '/alpha' });
    xinput(['key', '--clearmodifiers', 'Return']);
    await until(() => nativeView('/alpha')?.getVisible() && !nativeView('/alpha').webContents.isLoading(), 'Editable URL submits after toolbar drag');
  }
  async function assertMenuBackdrop(label, qualitySource) {
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
    let quality;
    if (qualitySource) {
      const live = await qualitySource.capturePage(undefined, { stayHidden: true });
      const scales = live.getScaleFactors(), highestScale = Math.max(1, ...scales);
      const original = live.toPNG({ scaleFactor: highestScale });
      assert.ok(source.startsWith('data:image/png;base64,'), 'The authored page backdrop uses lossless PNG');
      const backdrop = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
      const pixels = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
      quality = { nativeScaleFactors: scales, encodedScale: highestScale, nativePixels: pixels(original), backdropPixels: pixels(backdrop), bytes: backdrop.length };
      assert.deepEqual(quality.backdropPixels, quality.nativePixels, 'Profile backdrop preserves the native capture pixel resolution without1280-edge downsampling');
    }
    report.actions.push({ label: `${label}-snapshot`, atMs: Date.now() - started, image: image.getSize(), sampledColors: colors.size, quality, sha256: createHash('sha256').update(image.toPNG()).digest('hex') });
    save();
  }
  async function profileMenu(label, wc) {
    if (label === 'narrow-new-tab') await hoverTab((await readSite()).activeTabId);
    if (label === 'narrow-new-tab') {
      const alignment = await evaluate(() => {
        const center = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.x + r.width / 2; };
        return { rows: { upper: center('.sidebar-ribbon-main [data-ribbon-id="conversations"]'),
          settings: center('.sidebar-ribbon-footer .sidebar-ribbon-button'), account: center('.sidebar-ribbon-footer .sidebar-account-trigger') },
        icons: { upper: center('.sidebar-ribbon-main [data-ribbon-id="conversations"] > svg'),
          settings: center('.sidebar-ribbon-footer .sidebar-ribbon-button > svg'), account: center('.sidebar-ribbon-footer .sidebar-account-avatar') } };
      });
      assert.ok([alignment.rows, alignment.icons].every(group => Object.values(group).every(x => Math.abs(x - group.upper) <= 0.5))
        && alignment.icons.upper < alignment.rows.upper - 16,
      `Narrow large-type footer rows align with upper tabs, with icons on their shared left axis: ${JSON.stringify(alignment)}`);
      report.actions.push({ label: 'narrow-ribbon-footer-alignment', atMs: Date.now() - started, alignment }); save();
    }
    await click('.sidebar-account-trigger', `open-profile-${label}`);
    await waitFor(() => document.querySelector('.sidebar-account-menu[role="menu"]'));
    if (wc) await assertMenuBackdrop(`profile-${label}`, wc);
    const geometry = await evaluate(() => {
      const menu = document.querySelector('.sidebar-account-menu'), r = menu.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewport: { width: innerWidth, height: innerHeight },
        hit: [r.left + 8, r.right - 8].every(x => menu.contains(document.elementFromPoint(x, r.top + r.height / 2))),
        items: [...menu.querySelectorAll('[role="menuitem"]')].map(item => {
          const b = item.getBoundingClientRect();
          return { text: item.textContent, hit: item.contains(document.elementFromPoint(b.right - 8, b.top + b.height / 2)) };
        }) };
    });
    assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewport.width
      && geometry.bottom <= geometry.viewport.height && geometry.hit && geometry.items.every(item => item.hit),
    `Full account panel stays above the browser and is hit-testable: ${JSON.stringify(geometry)}`);
    await capture(`profile-over-${label}`);
    xinput(['key', '--clearmodifiers', 'Escape']);
    await waitFor(() => !document.querySelector('.sidebar-account-menu'));
    await finishRailInteraction(wc, 'profile-dismissal');
    if (wc) {
      geometry.keyboardDepartures = [];
      for (const [chord, direction] of [['Tab', 1], ['shift+Tab', -1]]) {
        const expected = await evaluate(direction => {
          const items = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')].filter(node =>
            node instanceof HTMLElement && node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]')
            && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden');
          const index = items.indexOf(document.querySelector('.sidebar-account-trigger'));
          return items[(index + direction + items.length) % items.length].outerHTML;
        }, direction);
        await click('.sidebar-account-trigger', `profile-${chord}-departure`, false);
        await waitFor(() => document.querySelector('.sidebar-account-menu')?.contains(document.activeElement));
        xinput(['key', '--clearmodifiers', chord]);
        await waitFor(() => !document.querySelector('.sidebar-account-menu'));
        const actual = await evaluate(() => document.activeElement?.outerHTML);
        assert.equal(actual, expected, `${chord} continues from the profile trigger, not the document-end portal`);
        const expanded = await evaluate(() => document.querySelector('.sidebar-ribbon')?.dataset.expanded === 'true');
        if (expanded) await assertMenuBackdrop(`profile-${chord}-retained-rail`, wc);
        await finishRailInteraction(wc, `profile-${chord}`);
        geometry.keyboardDepartures.push({ chord, focus: actual.slice(0, 400), nativeContentsID: wc.id });
      }
      await capture('profile-keyboard-departures');
    }
    return geometry;
  }
  async function openSite(name, pathname) {
    await click(siteIDs.has(name) ? tabButton(siteIDs.get(name)) : ribbon(name), `open-${name}`);
    await waitFor(() => [...document.querySelectorAll('[data-wuu-component="web-workspace"]')].some(node => node.getBoundingClientRect().width > 0));
    const id = await evaluate(() => [...document.querySelectorAll('[data-wuu-component="web-workspace"]')].find(node => node.getBoundingClientRect().width > 0).dataset.websiteId);
    const state = id === ribbonGroup ? await readSite() : await evaluate(({ id, url }) => window.wuu.webWorkspace.open({ id, url }), { id, url: origin + pathname });
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
  async function tabMenu(id, label) {
    const p = await point(tabButton(id)), bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(bounds.x + p.x * zoom)), String(Math.round(bounds.y + p.y * zoom)), 'click', '3']);
    await waitFor(() => document.querySelector('.thread-row-context-menu [role="menuitem"]'));
    await capture(`tab-context-${label}`);
  }
  async function closeActiveTab(label) {
    const id = (await readSite()).activeTabId;
    await hoverTab(id);
    await click(`.sidebar-ribbon-close[data-ribbon-close-id="${id}"]`, label);
    await until(async () => !(await readSite()).tabs.some(tab => tab.id === id), 'Direct close button removes the web tab from the ribbon');
  }
  async function blankTab(label) {
    const before = (await readSite()).tabs.length;
    await click(addTabButton, label);
    await until(async () => (await readSite()).tabs.length === before + 1, 'Left plus creates one real tab');
    await waitFor(selector => document.activeElement?.matches(selector), startInput);
    const state = await readSite();
    assert.equal(state.url, 'about:blank');
    await hidden('blank mascot page');
    return state.activeTabId;
  }
  async function addSite(name, pathname) {
    const id = await blankTab(`new-${name}`);
    siteIDs.set(name, id);
    await fill(startInput, pathname.startsWith('http') ? pathname : origin + pathname);
    xinput(['key', '--clearmodifiers', 'Return']);
    if (!pathname.startsWith('http')) await until(() => nativeView(pathname)?.getVisible() && !nativeView(pathname).webContents.isLoading(), `New left tab loads ${pathname}`);
    return id;
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
    } finally { await evaluate(() => window.__wuuMascotAcceptance?.cleanup()); }
  });
  let alphaID, savedOrder;

  await testNative('bundled Notion ribbon resolves its setting and creates the native website', async () => {
    const diagnostic = report.notionPlugin = {
      entry: 'notion-workspace:website', requestedURL: 'https://www.notion.so/',
      externalAccount: false, samples: [], events: [], networkStatus: 'pending',
    };
    const created = [];
    const observe = (_event, wc) => {
      if (wc === win.webContents) return;
      created.push(wc);
      const record = (event, detail = {}) => {
        diagnostic.events.push({ atMs: Date.now() - started, id: wc.id, event, ...detail }); save();
      };
      record('created');
      for (const event of ['did-start-loading', 'did-stop-loading', 'dom-ready', 'did-finish-load']) {
        wc.on(event, () => record(event, { url: wc.getURL(), loading: wc.isLoading() }));
      }
      wc.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
        if (mainFrame) record('did-start-navigation', { url, inPlace });
      });
      wc.on('did-redirect-navigation', (_event, url, inPlace, mainFrame) => {
        if (mainFrame) record('did-redirect-navigation', { url, inPlace });
      });
      wc.on('did-navigate', (_event, url, statusCode, statusText) => record('did-navigate', { url, statusCode, statusText }));
      wc.on('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (mainFrame) record('did-fail-load', { code, description, url });
      });
      wc.on('console-message', event => {
        if (event.level === 'error' && diagnostic.events.filter(item => item.event === 'console-error').length < 20) {
          record('console-error', { message: event.message.slice(0, 1800), source: event.sourceId, line: event.lineNumber });
        }
      });
      wc.on('render-process-gone', (_event, detail) => record('render-process-gone', detail));
      wc.on('destroyed', () => record('destroyed'));
    };
    app.on('web-contents-created', observe);
    const pluginRow = '.plugin-row[data-plugin="notion-workspace"]';
    try {
      await click(plugins, 'notion-open-extension-inventory');
      await click(pick('.sidebar-section-item', 'Plugins'), 'notion-plugin-list');
      await waitFor(selector => document.querySelector(selector), pluginRow);
      await click(`${pluginRow} [role="switch"]`, 'enable-bundled-notion');
      await waitFor(() => document.querySelector('.sidebar-ribbon-main button[aria-label="Notion"]'), undefined, 'bundled Notion ribbon activation', 20000);
      diagnostic.ribbonID = await evaluate(() => document.querySelector('.sidebar-ribbon-main button[aria-label="Notion"]').dataset.ribbonId);
      assert.ok(diagnostic.ribbonID.startsWith('plugin:'), 'Notion is a registered plugin destination, not a website shortcut');
      const [registeredPluginID] = JSON.parse(diagnostic.ribbonID.slice('plugin:'.length));
      diagnostic.registeredPluginID = registeredPluginID;
      const selectedAt = Date.now();
      await click(ribbon('Notion'), 'actual-bundled-notion-ribbon');
      for (const elapsed of [0, 3000, 10000, 20000]) {
        await delay(Math.max(0, selectedAt + elapsed - Date.now()));
        const shell = await evaluate(registeredPluginID => {
          const root = [...document.querySelectorAll('.plugin-workbench-view, [data-wuu-component="plugin-view-content"]')]
            .find(node => (node.dataset.pluginId || node.dataset.wuuPlugin) === registeredPluginID
              && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
          return { mounted: Boolean(root), text: root?.innerText.slice(0, 1600) || '',
            nativeHost: root?.querySelector('[data-wuu-component="web-workspace"]')?.getAttribute('data-website-id') || null,
            alert: root?.querySelector('[role="alert"]')?.textContent || null };
        }, registeredPluginID);
        const native = [];
        for (const view of win.contentView.children) {
          const wc = view.webContents;
          if (!wc || wc.isDestroyed() || !created.includes(wc)) continue;
          const state = { id: wc.id, url: wc.getURL(), visible: view.getVisible(), loading: wc.isLoading(), bounds: view.getBounds() };
          if (!wc.isLoadingMainFrame() && /^https:\/\//.test(state.url)) {
            state.document = await Promise.race([
              wc.executeJavaScript('({title:document.title,ready:document.readyState,userAgent:navigator.userAgent,text:document.body?.innerText.slice(0,1800)||"",visibleInputs:Array.from(document.querySelectorAll("input")).filter(e=>e.getBoundingClientRect().width>0).map(e=>({type:e.type,placeholder:e.placeholder}))})').catch(error => ({ error: String(error) })),
              delay(1500).then(() => ({ unavailable: 'document observation timed out' })),
            ]);
          }
          native.push(state);
        }
        diagnostic.samples.push({ elapsedMs: Date.now() - selectedAt, shell, native });
        save(); await capture(`notion-plugin-${elapsed}ms`);
      }
      const last = diagnostic.samples.at(-1);
      diagnostic.networkStatus = last.native.some(page => !page.loading && page.document?.text)
        ? 'document-rendered' : diagnostic.events.some(event => event.event === 'did-fail-load') ? 'navigation-failed' : 'unsettled-after-20s';
      diagnostic.createdContents = created.length;
      save();
      assert.ok(last.shell.nativeHost, `Bundled Notion must leave its plugin loading state: ${JSON.stringify(last.shell)}`);
      assert.ok(diagnostic.events.some(event => event.event === 'did-start-navigation' && event.url === diagnostic.requestedURL), 'The actual plugin requests its default notion.so URL');
      assert.ok(last.native.some(page => page.visible), 'The Notion plugin presents its native page, independent of external network availability');
      assert.ok(created.length <= 2, `Plugin renders must not recreate native pages repeatedly: ${created.length}`);
      // Anonymous notion.so can redirect to marketing. Follow its real public
      // login link to observe the application, without entering any account data.
      const page = created.find(wc => !wc.isDestroyed() && /^https:\/\/(?:www\.)?notion\.(?:com|so)\//.test(wc.getURL()));
      const existingLogin = last.native.find(page => /^https:\/\/(?:app\.|www\.)?notion\.(?:com|so)\/login/.test(page.url) && page.document?.visibleInputs?.length);
      diagnostic.publicLogin = existingLogin ? { status: 'login-form-visible', ...existingLogin } : { status: 'not-offered' };
      if (existingLogin) { save(); await capture('notion-public-application-login'); }
      else if (page && !page.isLoadingMainFrame()) {
        const href = await Promise.race([
          page.executeJavaScript(`Array.from(document.querySelectorAll('a[href]')).find(a => /^(log in|登录)$/i.test(a.textContent.trim()))?.getAttribute('href') || ''`),
          delay(1500).then(() => ''),
        ]);
        const destination = href ? new URL(href, page.getURL()) : null;
        if (destination?.protocol === 'https:' && /(^|\.)notion\.(com|so)$/.test(destination.hostname) && destination.pathname.startsWith('/login')) {
          diagnostic.publicLogin = { requestedURL: destination.href, status: 'observing' }; save();
          await pageClick(page, `a[href=${JSON.stringify(href)}]`, 'notion-public-login-link');
          await delay(10000);
          const live = created.filter(wc => !wc.isDestroyed()).map(wc => ({ id: wc.id, url: wc.getURL(), loading: wc.isLoading() }));
          diagnostic.publicLogin.pages = live;
          const login = created.find(wc => !wc.isDestroyed() && /^https:\/\/(?:app\.|www\.)?notion\.(?:com|so)\/login/.test(wc.getURL()));
          if (login && !login.isLoadingMainFrame()) {
            diagnostic.publicLogin.document = await Promise.race([
              login.executeJavaScript('({title:document.title,ready:document.readyState,userAgent:navigator.userAgent,text:document.body?.innerText.slice(0,2400)||"",visibleInputs:Array.from(document.querySelectorAll("input")).filter(e=>e.getBoundingClientRect().width>0).map(e=>({type:e.type,placeholder:e.placeholder}))})'),
              delay(1500).then(() => ({ unavailable: 'document observation timed out' })),
            ]);
          }
          diagnostic.publicLogin.status = diagnostic.publicLogin.document?.visibleInputs?.length ? 'login-form-visible' : 'unsettled-after-10s';
          save(); await capture('notion-public-application-login');
        }
      }
      return { requestedURL: diagnostic.requestedURL, networkStatus: diagnostic.networkStatus, createdContents: created.length, final: last };
    } finally {
      app.removeListener('web-contents-created', observe);
      // Return the isolated profile to its original optional-plugin state so
      // external activity cannot contaminate unrelated local fixture journeys.
      await click(plugins, 'notion-diagnostic-return-to-inventory');
      await click(pick('.sidebar-section-item', 'Plugins'), 'notion-diagnostic-plugin-list');
      if (await evaluate(selector => document.querySelector(`${selector} [role="switch"]`)?.getAttribute('aria-checked') === 'true', pluginRow)) {
        await click(`${pluginRow} [role="switch"]`, 'disable-diagnostic-notion');
      }
      await goConversations();
    }
  });

  await testNative('left plus opens one blank mascot tab and Pin retains the website', async () => {
    assert.equal(await evaluate(selector => document.querySelectorAll(selector).length, webTabs), 0, 'No website tabs are added by default');
    await blankTab('first-left-web-tab');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.web-workspace-tabstrip'))), false);
    await fill(startInput, 'javascript:alert(1)'); xinput(['key', '--clearmodifiers', 'Return']);
    await waitFor(selector => document.querySelector(selector)?.getAttribute('aria-invalid') === 'true', startInput);
    assert.equal((await readSite()).url, 'about:blank', 'Unsafe scheme never navigates');
    await capture('unsafe-address-rejected');
    await closeActiveTab('close-final-blank-tab');
    assert.equal((await readSite()).tabs.length, 0, 'Closing the final tab leaves no artificial replacement');
    await waitFor(() => !document.querySelector('.web-workspace-stage:not([hidden])'));
    alphaID = await blankTab('new-alpha-left-tab'); siteIDs.set('Fixture Alpha', alphaID);
    await fill(startInput, origin + '/alpha'); xinput(['key', '--clearmodifiers', 'Return']);
    await until(() => nativeView('/alpha')?.getVisible() && !nativeView('/alpha').webContents.isLoading(), 'First left tab loads fixture');
    await tabMenu(alphaID, 'pin-alpha');
    const options = await evaluate(() => [...document.querySelectorAll('.thread-row-context-menu [role="menuitem"]')].map(item => item.textContent.trim()));
    assert.deepEqual(options, ['Pin tab', 'Close tab'], 'Website context menu stays minimal');
    await click(pick('.thread-row-context-menu [role="menuitem"]', 'Pin tab'), 'pin-alpha');
    await waitFor(id => document.querySelector(`[data-ribbon-id="${id}"]`)?.dataset.pinned === 'true', alphaID);
    await addSite('Fixture Beta', '/beta');
    await openSite('Fixture Alpha', '/alpha');
    const vertical = { collapsed: await verticalTabGeometry() }, hostBefore = nativeView('/alpha').getBounds();
    const viewportBefore = await nativeView('/alpha').webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    await hoverTab(siteIDs.get('Fixture Beta'));
    vertical.expanded = await verticalTabGeometry(true);
    await assertMenuBackdrop('hover rail', nativeView('/alpha').webContents);
    assert.deepEqual(nativeView('/alpha').getBounds(), hostBefore, 'Hover expansion does not resize the native website');
    assert.deepEqual(await nativeView('/alpha').webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'), viewportBefore, 'Hover expansion leaves the page viewport unchanged');
    await waitFor(id => { const close = document.querySelector(`[data-ribbon-close-id="${id}"]`); return close && getComputedStyle(close).visibility === 'visible' && Number(getComputedStyle(close).opacity) > 0.95; }, siteIDs.get('Fixture Beta'));
    await capture('vertical-left-tabs-with-hover-close');
    await leaveRail();
    await until(() => nativeView('/alpha')?.getVisible(), 'Pointer leave restores the same live page');
    vertical.restored = await verticalTabGeometry();
    await capture('collapsed-left-tabs-unchanged-web-viewport');
    return { alphaID, betaID: siteIDs.get('Fixture Beta'), options, tabs: (await readSite()).tabs, vertical };
  });

  await testNative('ribbon reorders Chat away from first with real keyboard and pointer', async () => {
    await openSite('Fixture Alpha', '/alpha');
    const before = await evaluate(() => [...document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')].map(node => node.dataset.ribbonId));
    await click('.sidebar-account-trigger', 'anchor-ribbon-keyboard'); xinput(['key', 'Escape']);
    await waitFor(() => document.activeElement?.matches('.sidebar-account-trigger'));
    for (let step = 0; step < before.length * 2 + 4; step++) {
      xinput(['key', '--clearmodifiers', 'shift+Tab']); await delay(60);
      if (await evaluate(id => document.activeElement?.dataset.ribbonId === id, alphaID)) break;
    }
    assert.ok(await evaluate(id => document.activeElement?.dataset.ribbonId === id, alphaID), 'Real keyboard traversal reaches the left web tab');
    await capture('ribbon-keyboard-focus-before-reorder');
    for (let index = before.indexOf(alphaID); index > 0; index--) {
      xinput(['key', '--clearmodifiers', 'alt+Up']);
      await waitFor(({ id, index }) => document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')[index - 1]?.dataset.ribbonId === id, { id: alphaID, index });
      assert.ok(await evaluate(id => document.activeElement?.dataset.ribbonId === id, alphaID), 'Keyboard reorder retains ribbon focus');
    }
    const betaID = siteIDs.get('Fixture Beta');
    const from = await point(tabButton(betaID)), to = await point(tabButton(alphaID));
    const bounds = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    const sx = bounds.x + from.x * zoom, sy = bounds.y + from.y * zoom, ex = bounds.x + to.x * zoom, ey = bounds.y + to.y * zoom;
    try {
      xinput(['mousemove', String(Math.round(sx)), String(Math.round(sy)), 'mousedown', '1']); await delay(80);
      for (let step = 1; step <= 8; step++) {
        xinput(['mousemove', String(Math.round(sx + (ex - sx) * step / 8)), String(Math.round(sy + (ey - sy) * step / 8))]); await delay(40);
      }
      xinput(['mouseup', '1']);
      await waitFor(id => document.querySelector('.sidebar-ribbon-main [data-ribbon-id]')?.dataset.ribbonId === id, betaID);
    } finally { xinput(['mouseup', '1']); }
    savedOrder = await evaluate(() => [...document.querySelectorAll('.sidebar-ribbon-main [data-ribbon-id]')].map(node => node.dataset.ribbonId));
    assert.ok(savedOrder.indexOf(await evaluate(selector => document.querySelector(selector).dataset.ribbonId, conversations)) > 0, 'Chat is not pinned first');
    assert.deepEqual((await prefs()).order.filter(id => savedOrder.includes(id)), savedOrder);
    await capture('reordered-left-tabs'); return { before, after: savedOrder };
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
    try {
      await fill(address, origin + '/loading-hold'); xinput(['key', '--clearmodifiers', 'Return']);
      await until(() => wc.getURL() === origin + '/loading-hold' && wc.isLoading(), 'Controlled local document remains loading');
      await waitFor(() => document.querySelector('.web-workspace-toolbar button[aria-label="Stop loading"]')
        && document.querySelector('[data-wuu-component="website-navigation-item"][aria-current="page"] .sidebar-ribbon-tab-loading'));
      assert.equal(await evaluate(() => Boolean(document.querySelector('.web-workspace-toolbar .workspace-browser-loading-bar'))), false, 'Loading has no redundant full-width blue progress strip');
      await capture('controlled-loading-ribbon-spinner-and-stop');
      await click(toolbar('Stop loading'), 'stop-controlled-loading');
      await until(() => !wc.isLoading(), 'Stop cancels the controlled loading document');
      await waitFor(() => document.querySelector('.web-workspace-toolbar button[aria-label="Reload"]'));
    } finally { fixture.controls.finishLoading?.(); }
    await navigateAddress('/alpha', 'return-from-history');
    assert.equal(wc.getURL(), origin + '/alpha');
    await capture('native-page-loaded'); return { preferences, cookie: 'synthetic-session', contentsId: wc.id };
  });

  await testNative('native websites yield to sections dialogs and restore real focus', async () => {
    const transitions = await traceLoadedTabSwitches();
    const wc = await openSite('Fixture Alpha', '/alpha');
    await tabMenu(alphaID, 'over-live-page');
    const managerHidden = await hidden('tab context menu'); await assertMenuBackdrop('tab context menu');
    await capture('context-menu-over-native-page');
    xinput(['key', 'Escape']);
    await waitFor(() => !document.querySelector('.thread-row-context-menu'));
    await finishRailInteraction(wc, 'tab-context-dismissal');
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
    return { managerHidden, retainedContentsId: wc.id, transitions };
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
        chrome.verticalTabs = await verticalTabGeometry();
        if (width === 700) await dragBrowserToolbar();
        await capture(`bounds-${theme}-${width}-zoom-${zoom}`);
        if (width === 440) {
          for (const [name, trigger, panel] of [['library', '[data-browser-library-trigger]', '[data-browser-library]'], ['downloads', '[data-web-workspace-downloads-trigger]', '[data-web-workspace-downloads]']]) {
            await click(`.web-workspace-toolbar ${trigger}`, `narrow-toolbar-${name}`, false);
            await waitFor(selector => document.querySelector(selector), panel);
            await assertMenuBackdrop(`narrow-toolbar-${name}`);
            await capture(`narrow-toolbar-${name}`);
            xinput(['key', '--clearmodifiers', 'Escape']);
            await waitFor(selector => !document.querySelector(selector), panel);
            await until(() => view.getVisible(), 'Closing narrow toolbar menus restores the same native webpage');
          }
        }
        if (width === 440 || theme === 'dark') {
          await blankTab(`new-tab-${theme}-${width}`);
          await waitFor(selector => document.activeElement?.matches(selector), startInput);
          await hidden('new-tab start page');
          await capture(`new-tab-${theme}-${width}-font-${size}`);
          if (width === 440) await profileMenu('narrow-new-tab');
          await closeActiveTab('return-from-visual-new-tab');
          await until(() => nativeView('/alpha')?.getVisible(), 'Closing visual new tab restores website');
        }
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
    const tabsBefore = (await readSite()).tabs.length;
    await pageClick(wc, '#post', 'open-post-popup');
    await until(() => fixture.requests.some(request => request.path === '/posted' && request.method === 'POST' && request.body === 'fixture=post-preserved'), 'native POST body preserved');
    await until(() => contents('/posted') && !contents('/posted').isLoading(), 'POST left tab loaded');
    const post = contents('/posted'); security(post); await capture('post-left-tab');
    assert.ok(nativeView('/posted')?.getVisible(), 'Ordinary target=_blank POST opens a left tab');
    assert.equal((await readSite()).tabs.length, tabsBefore + 1);
    assert.equal(await evaluate(selector => document.querySelectorAll(selector).length, webTabs), tabsBefore + 1);
    await closeActiveTab('close-post-tab');
    win.focus();
    return { openerRoundtrip: true, ordinaryPostMode: 'left-tab', post: fixture.requests.find(request => request.path === '/posted') };
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
  let clearedHistoryURL;

  await testNative('left web tabs native shortcuts find and per-page zoom', async () => {
    let wc = await openSite('Fixture Alpha', '/alpha');
    const before = (await readSite()).tabs.length;
    await blankTab('click-left-add-tab');
    await closeActiveTab('click-close-left-tab');
    await until(() => nativeView('/alpha')?.getVisible(), 'Closing left tab restores prior page');
    await pageClick(wc, '#draft', 'native-tab-shortcut-focus'); xinput(['key', '--clearmodifiers', 'ctrl+t']);
    await waitFor(({ count, input }) => document.querySelectorAll('[data-wuu-component="website-navigation-item"]').length === count && document.activeElement?.matches(input), { count: before + 1, input: startInput });
    await hidden('new blank tab');
    await fill(startInput, origin + '/tab-two');
    await capture('new-tab-central-address'); xinput(['key', '--clearmodifiers', 'Return']);
    await until(() => nativeView('/tab-two')?.getVisible() && !nativeView('/tab-two').webContents.isLoading(), 'Central new-tab input navigates on native Return');
    wc = nativeView('/tab-two').webContents;
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
    xinput(['key', 'Home', 'key', 'Down', 'key', 'Down', 'key', 'Down', 'key', 'Return']);
    await until(() => wc.getZoomFactor() > 1, 'actual native website zoom increased');
    const zoom = wc.getZoomFactor();
    await click(`${liveStage} button[aria-label="Browser options"]`, 'reopen-browser-options');
    xinput(['key', 'Home', 'key', 'Down', 'key', 'Down', 'key', 'Return']);
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
    const tabsBeforeStart = (await readSite()).tabs.length;
    await blankTab('saved-history-new-tab');
    await waitFor(selector => document.activeElement?.matches(selector), startInput);
    await waitFor(() => {
      const mascot = document.querySelector('.web-workspace-start-mascot');
      return mascot?.getBoundingClientRect().width > 0 && (!(mascot instanceof HTMLImageElement) || mascot.complete && mascot.naturalWidth > 0);
    });
    await capture('mascot-new-tab-ready');
    const gaze = await mascotGaze();
    await fill(startInput, 'fixture');
    const suggestion = url => `[data-address-suggestion-url="${url}"]`;
    await waitFor(({ alpha, history }) => document.querySelector(`[data-address-suggestion-url="${alpha}"]`)?.dataset.addressSuggestionSource === 'bookmark'
      && document.querySelector(`[data-address-suggestion-url="${history}"]`)?.dataset.addressSuggestionSource === 'history', { alpha: origin + '/alpha', history: origin + '/history-target' });
    await capture('central-history-and-bookmark-suggestions');
    xinput(['key', '--clearmodifiers', 'Escape']);
    await waitFor(selector => !document.querySelector('[data-web-workspace-address-suggestions]') && document.activeElement?.matches(selector) && document.activeElement.value === 'fixture', startInput);
    await fill(startInput, 'alpha');
    await waitFor(selector => document.querySelector(selector), suggestion(origin + '/alpha'));
    xinput(['key', '--clearmodifiers', 'Down']);
    await waitFor(url => document.querySelector(`[data-address-suggestion-url="${url}"]`)?.getAttribute('aria-selected') === 'true', origin + '/alpha');
    xinput(['key', '--clearmodifiers', 'Return']);
    await until(() => nativeView('/alpha')?.getVisible() && !nativeView('/alpha').webContents.isLoading(), 'Keyboard selection opens the saved bookmark');
    gaze.unmount = await mascotUnmount();
    // The page now owns native focus. A renderer-only sendInputEvent can edit
    // its DOM address field without moving OS focus from the WebContentsView.
    // Exercise the real user's click and typing before judging autocomplete.
    await click(address, 'focus-toolbar-history-suggestions');
    await until(() => win.webContents.isFocused(), 'Native toolbar click transfers keyboard focus to the shell');
    xinput(['key', '--clearmodifiers', 'ctrl+a']);
    xinput(['type', '--clearmodifiers', '--delay', '0', 'history-target']);
    await waitFor(selector => document.activeElement?.matches(selector) && document.activeElement.value === 'history-target', address);
    await waitFor(selector => document.querySelector(selector), suggestion(origin + '/history-target'));
    await assertMenuBackdrop('toolbar-address-suggestions');
    await capture('toolbar-history-suggestion-over-page');
    xinput(['key', '--clearmodifiers', 'Escape']);
    await waitFor(selector => !document.querySelector('[data-web-workspace-address-suggestions]') && document.activeElement?.matches(selector) && document.activeElement.value === 'history-target', address);
    await until(() => nativeView('/alpha')?.getVisible(), 'Escape restores native page while retaining address draft');
    xinput(['key', '--clearmodifiers', 'Down']);
    await waitFor(selector => document.querySelector(selector), suggestion(origin + '/history-target'));
    await click(suggestion(origin + '/history-target'), 'choose-history-with-pointer');
    await until(() => nativeView('/history-target')?.getVisible() && !nativeView('/history-target').webContents.isLoading(), 'Pointer selection opens stored history URL');
    const selectedPage = nativeView('/history-target').webContents;
    const profile = await profileMenu('live-website', selectedPage);
    assert.equal(selectedPage.getURL(), origin + '/history-target');
    await capture('profile-dismissed-native-page-restored');
    await closeActiveTab('close-suggestion-journey-tab');
    await until(async () => (await readSite()).tabs.length === tabsBeforeStart && nativeView('/history-target')?.getVisible(), 'Close journey tab restores original browsing state');
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
    return { history: state.history.length, bookmarks: state.bookmarks.length, keyboardAndPointerSuggestions: true, profile, gaze };
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

  await testNative('left tab close recreation and renderer restart preserve order pin and cookies', async () => {
    const wc = await openSite('Fixture Alpha', '/alpha');
    assert.ok((await wc.executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    const backgroundOwner = await openSite('Fixture Beta', '/beta'), beforeClose = win.getBounds();
    const backgroundRow = await point(tabButton(alphaID)), outer = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
    xinput(['mousemove', String(Math.round(outer.x + backgroundRow.x * zoom)), String(Math.round(outer.y + backgroundRow.y * zoom))]);
    await waitFor(id => { const close = document.querySelector(`[data-ribbon-close-id="${id}"]`); return close && Number(getComputedStyle(close).opacity) > 0.95; }, alphaID);
    await click(`.sidebar-ribbon-close[data-ribbon-close-id="${alphaID}"]`, 'close-background-alpha');
    await until(() => wc.isDestroyed(), 'Closed left tab releases native contents');
    assert.equal((await readSite()).activeTabId, siteIDs.get('Fixture Beta'), 'Closing a background tab does not select it or change the active tab');
    await until(() => !backgroundOwner.isDestroyed() && nativeView('/beta')?.getVisible(), 'Background close keeps the active native page visible after leaving the rail');
    assert.deepEqual(win.getBounds(), beforeClose, 'Close control does not begin a native window drag');
    assert.ok(!(await readSite()).tabs.some(tab => tab.id === alphaID));
    alphaID = await addSite('Fixture Alpha Restored', '/alpha'); siteIDs.set('Fixture Alpha', alphaID);
    await tabMenu(alphaID, 'pin-restored-alpha');
    await click(pick('.thread-row-context-menu [role="menuitem"]', 'Pin tab'), 'pin-restored-alpha');
    await waitFor(id => document.querySelector(`[data-ribbon-id="${id}"]`)?.dataset.pinned === 'true', alphaID);
    assert.ok((await contents('/alpha').executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'), 'Closing a tab never clears shared login/session data');
    const before = await prefs(), stateBefore = await readSite();
    const nativeBefore = views().map(view => view.webContents);
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await Promise.race([reloaded, delay(30000).then(() => { throw new Error('Renderer reload did not finish'); })]);
    await waitFor(() => window.wuu && document.querySelector('.sidebar-ribbon-main'), undefined, 'reloaded workbench ready', 30000);
    await waitFor(count => document.querySelectorAll('[data-wuu-component="website-navigation-item"]').length === count, stateBefore.tabs.length);
    assert.deepEqual(await prefs(), before, 'Saved ribbon order survives renderer restart');
    const restored = await readSite();
    assert.deepEqual(restored.tabs.map(tab => ({ id: tab.id, url: tab.url, pinned: Boolean(tab.pinned) })), stateBefore.tabs.map(tab => ({ id: tab.id, url: tab.url, pinned: Boolean(tab.pinned) })), 'Left tabs and pins survive renderer restart');
    assert.ok(nativeBefore.every(wc => wc.isDestroyed()), 'Shell reload releases old native pages before lazy recreation');
    await evaluate(() => {
      const events = [], types = ['pointerover', 'pointerout', 'pointermove', 'focusin', 'focusout'];
      const observe = event => {
        const nav = document.querySelector('.sidebar-ribbon');
        events.push({ type: event.type, at: performance.now(), x: event.clientX, y: event.clientY,
          target: event.target instanceof Element ? event.target.outerHTML.slice(0, 200) : String(event.target),
          related: event.relatedTarget instanceof Element ? event.relatedTarget.outerHTML.slice(0, 160) : String(event.relatedTarget),
          expanded: nav?.dataset.expanded, hovered: nav?.matches(':hover'), focusedWithin: nav?.contains(document.activeElement) });
        if (events.length > 100) events.shift();
      };
      types.forEach(type => document.addEventListener(type, observe, true));
      window.__wuuRestartInputProbe = { events, stop: () => types.forEach(type => document.removeEventListener(type, observe, true)) };
    });
    try {
      await openSite('Fixture Alpha Restored', '/alpha');
      assert.ok((await contents('/alpha').executeJavaScript('document.cookie')).includes('wuu_acceptance=synthetic-session'));
    } finally {
      report.restartInteraction = await evaluate(() => {
        const nav = document.querySelector('.sidebar-ribbon'), probe = window.__wuuRestartInputProbe;
        const result = { events: probe.events, expanded: nav?.dataset.expanded, hovered: nav?.matches(':hover'),
          focusedWithin: nav?.contains(document.activeElement), activeElement: document.activeElement?.outerHTML.slice(0, 300),
          layers: [...document.querySelectorAll('[role="tooltip"],.sidebar-account-menu,.thread-row-context-menu')].map(node => node.outerHTML.slice(0, 240)) };
        probe.stop(); delete window.__wuuRestartInputProbe; return result;
      }).catch(error => ({ unavailable: String(error) }));
      report.restartInteraction.nativeViews = views().map(view => ({ id: view.webContents.id, url: view.webContents.getURL(), visible: view.getVisible(), focused: view.webContents.isFocused(), bounds: view.getBounds() }));
      report.restartInteraction.nativeChildren = win.getChildWindows().map(child => ({ title: child.getTitle(), visible: child.isVisible(), focusable: child.isFocusable(), url: child.webContents.getURL() }));
      save();
    }
    const library = await evaluate(() => window.wuu.webWorkspace.library.getState());
    if (clearedHistoryURL) {
      assert.ok(!library.history.some(entry => entry.url === clearedHistoryURL), 'Renderer restart does not restore cleared history');
      assert.ok(library.bookmarks.some(entry => entry.url === origin + '/alpha'), 'Bookmark survives renderer restart');
    }
    await capture('left-tabs-after-restart'); return { before, restoredTabs: restored.tabs, sharedCookieRetained: true };
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
  {
    // This is the user's saved-website path, separate from the earlier bundled
    // plugin probe. Public network availability is diagnostic, never a gate.
    const optional = { name: 'Notion opened as a real left web tab', requestedURL: 'https://www.notion.so/', required: false, status: 'unavailable', events: [], accountUsed: false };
    const observed = [];
    const observe = (_event, wc) => {
      if (wc === win.webContents) return;
      observed.push(wc);
      wc.on('did-navigate', (_event, url, code) => optional.events.push({ event: 'navigate', id: wc.id, url, code }));
      wc.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame) optional.events.push({ event: 'failed', id: wc.id, code, description, url }); });
      wc.on('did-stop-loading', () => optional.events.push({ event: 'loaded', id: wc.id, url: wc.getURL() }));
    };
    app.on('web-contents-created', observe);
    try {
      await addSite('Public Notion preview', optional.requestedURL);
      const notion = () => observed.find(wc => !wc.isDestroyed() && /^https:\/\/(?:[a-z0-9-]+\.)*notion\.(?:com|so)\//.test(wc.getURL()));
      await until(() => notion() && !notion().isLoadingMainFrame(), 'optional Notion left-tab document', 12000);
      const wc = notion();
      const login = await wc.executeJavaScript(`(() => {const links=[...document.querySelectorAll('a[href]')];const a=links.find(a=>/log\\s*in/i.test(a.textContent)&&/^https:\\/\\/(?:[a-z0-9-]+\\.)*notion\\.(?:com|so)\\//.test(a.href));return a?.getAttribute('href')||null;})()`);
      if (login && !/\/login(?:[/?#]|$)/.test(wc.getURL())) {
        await pageClick(wc, `a[href=${JSON.stringify(login)}]`, 'notion-public-login-link');
      }
      await until(async () => !wc.isDestroyed() && !wc.isLoadingMainFrame() && await wc.executeJavaScript(`Boolean([...document.querySelectorAll('input[type=email]')].find(input=>input.getBoundingClientRect().width>0))`), 'optional Notion public login form', 12000);
      optional.status = 'public-login-visible';
      optional.document = await wc.executeJavaScript(`({url:location.href,title:document.title,ready:document.readyState,userAgent:navigator.userAgent,text:document.body.innerText.slice(0,1200)})`);
      optional.nativeContentsID = wc.id;
      await capture('optional-left-tab-notion-public-login');
    } catch (error) { optional.error = String(error); try { await capture('optional-left-tab-notion-unavailable'); } catch {} }
    finally { app.removeListener('web-contents-created', observe); }
    report.optionalEvidence = [optional]; save();
  }
  await goConversations();
  report.websiteFixture = { origin, requestCount: fixture.requests.length, externalAccounts: false, authoredExtension: true };
}
module.exports = { createWebsiteFixture, runWebsiteAcceptance };
