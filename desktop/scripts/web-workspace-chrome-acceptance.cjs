// Real pointer input and composed screenshots for native browser chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { contentTracing } = require('electron');

module.exports = async function acceptChrome(h, view) {
  const { win, output, report, evaluate, until, settle, nativeInput, capture, delay, fixtureTabs } = h;
  const wc = view.webContents;
  const samples = report.browserChrome = [];
  for (const [width, height, zoom, theme] of [[1280, 800, 1, 'light'], [600, 700, 1, 'light'], [1280, 800, 1.25, 'dark']]) {
    win.setBounds({ x: 30, y: 30, width, height }); win.webContents.setZoomFactor(zoom);
    await evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const title = theme === 'dark' ? '飞书 | 字节跳动旗下 AI 工作平台 - 飞书官网' : 'Resize animated';
    await wc.executeJavaScript('document.title=' + JSON.stringify(title));
    await until(() => evaluate(({ id, title }) => document.querySelector(`[data-ribbon-id="${id}"]`)?.getAttribute('aria-label') === title, { id: fixtureTabs.animated.id, title }), 'ribbon title updates');
    await settle();
    const anchor = await evaluate(id => {
      const r = document.querySelector(`[data-ribbon-id="${id}"]`).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, fixtureTabs.animated.id);
    const b = win.getContentBounds();
    const focusBeforeHover = wc.isFocused();
    await nativeInput(['mousemove', String(Math.round(b.x + (anchor.x + anchor.width / 2) * zoom)), String(Math.round(b.y + (anchor.y + anchor.height / 2) * zoom))]);
    // Chromium's native tooltip has its own hover delay, outside renderer rAF.
    await delay(1300);
    let hint = await evaluate(() => {
      const el = document.querySelector('[role="tooltip"]'); if (!el || getComputedStyle(el).visibility === 'hidden') return null;
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const nativeHint = win.getChildWindows().find(window => window.isVisible() && !window.isFocusable());
    if (nativeHint) {
      const r = nativeHint.getBounds();
      hint = { x: (r.x - b.x) / zoom, y: (r.y - b.y) / zoom, width: r.width / zoom, height: r.height / zoom,
        native: true, text: await nativeHint.webContents.executeJavaScript('document.body.innerText') };
      const textBox = await nativeHint.webContents.executeJavaScript(`(()=>{const hint=document.getElementById('hint'),r=hint.getBoundingClientRect();return{height:r.height,viewport:innerHeight}})()`);
      assert.ok(textBox.height <= textBox.viewport + 1, 'The native hint includes every wrapped line');
      assert.equal(wc.isFocused(), focusBeforeHover, 'A native hint does not take page focus');
    }
    const label = `${width}-${zoom}-${theme}`;
    fs.writeFileSync(path.join(output, `hover-windows-${label}.txt`), spawnSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' }).stdout || '');
    await capture('hover-' + label);
    const screen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1920x1200', '-i', process.env.DISPLAY, '-frames:v', '1', '-y', path.join(output, 'hover-screen-' + label + '.png')]);
    assert.equal(screen.status, 0, String(screen.stderr));
    const sample = { width, height, zoom, theme, anchor, hint, visibleDuringHover: view.getVisible(), menu: [] };
    samples.push(sample);
    await nativeInput(['mousemove', String(b.x + width - 80), String(b.y + 40)]);
    await until(() => win.getChildWindows().every(window => !window.isVisible()), 'Leaving the ribbon dismisses the hint');
    for (let cycle = 0; cycle < 3; cycle++) {
      await wc.executeJavaScript(`scrollTo(0,${300 + cycle * 180});document.documentElement.style.background='${['#dc5572', '#45a688', '#6766c1'][cycle]}';void 0;`);
      const before = await wc.executeJavaScript('({ticks:window.ticks,scroll:scrollY})');
      const events = [], original = view.setVisible;
      view.setVisible = function (visible) { events.push(visible); return original.call(this, visible); };
      try {
        const button = await evaluate(() => { const r = document.querySelector('button[aria-label="Browser options"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await nativeInput(['mousemove', String(Math.round(b.x + button.x * zoom)), String(Math.round(b.y + button.y * zoom)), 'click', '1']);
        await settle();
        await until(() => evaluate(() => document.querySelector('button[aria-label="Browser options"]').getAttribute('aria-expanded') === 'true'), 'options opens');
        await delay(150);
        const open = { visible: view.getVisible(), ticks: await wc.executeJavaScript('window.ticks') };
        await capture(`options-${label}-${cycle}`);
        if (cycle === 0) {
          const screen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1920x1200', '-i', process.env.DISPLAY, '-frames:v', '1', '-y', path.join(output, 'options-screen-' + label + '.png')]);
          assert.equal(screen.status, 0, String(screen.stderr));
        }
        await nativeInput(['key', 'Escape']); await settle();
        await until(() => evaluate(() => document.querySelector('button[aria-label="Browser options"]').getAttribute('aria-expanded') === 'false'), 'Escape dismisses options');
        sample.menu.push({ cycle, before, open, events, after: { visible: view.getVisible(), scroll: await wc.executeJavaScript('scrollY') } });
      } finally { view.setVisible = original; }
    }
  }
  report.linkNavigation = [];
  if (process.env.WUU_CHROME_TRACE === '1') await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'blink.user_timing', 'cc', 'viz'] });
  win.webContents.setZoomFactor(1); win.setBounds({ x: 30, y: 30, width: 1280, height: 800 }); await settle();
  for (let cycle = 0; cycle < 6; cycle++) {
    const sameDocument = cycle % 2 === 0;
    const url = sameDocument ? wc.getURL().split('#')[0] + '#route-' + cycle : h.origin + '/navigation-' + cycle;
    await wc.executeJavaScript(`scrollTo(0,0);document.querySelector('#draft').value='navigation-state';document.querySelector('header').insertAdjacentHTML('beforeend', '<a id="navigate" href="${url}">Local link</a>');void 0;`);
    const point = await wc.executeJavaScript(`(()=>{const r=document.querySelector('#navigate').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const outer = win.getContentBounds(), inner = view.getBounds(), events = [], original = view.setVisible;
    view.setVisible = function (visible) { events.push({ visible, at: performance.now(), stack: new Error().stack }); return original.call(this, visible); };
    try {
      await nativeInput(['mousemove', String(Math.round(outer.x + inner.x + point.x)), String(Math.round(outer.y + inner.y + point.y)), 'click', '1']);
      await until(() => wc.getURL() === url && !wc.isLoading(), 'same-tab link navigation'); await settle();
      const input = await wc.executeJavaScript('document.querySelector("#draft").value');
      report.linkNavigation.push({ cycle, sameDocument, url, events, visible: view.getVisible(), contentsID: wc.id, input });
      await capture('link-navigation-' + cycle);
      if (sameDocument) {
        assert.equal(input, 'navigation-state', 'Same-document links retain form state');
        await wc.executeJavaScript("document.querySelector('#navigate').remove();void 0;");
      }
    } finally { view.setVisible = original; }
  }
  if (process.env.WUU_CHROME_TRACE === '1') await contentTracing.stopRecording(path.join(output, 'link-navigation-trace.json'));
  fs.writeFileSync(path.join(output, 'link-navigation.json'), JSON.stringify(report.linkNavigation, null, 2));
  for (const navigation of report.linkNavigation) assert.ok(navigation.visible && !navigation.events.some(event => !event.visible), 'Following a link must not hide the native website');
  fs.writeFileSync(path.join(output, 'browser-chrome.json'), JSON.stringify(samples, null, 2));
  for (const sample of samples) {
    assert.ok(sample.visibleDuringHover, 'Hover must not hide the live website');
    assert.ok(sample.hint, 'Hover produces a visible hint');
    assert.ok(Math.abs(sample.hint.y - sample.anchor.y) < sample.anchor.height + sample.hint.height + 12, 'A ribbon hint stays beside its trigger instead of moving to the toolbar');
    for (const menu of sample.menu) {
      assert.ok(menu.open.visible && !menu.events.includes(false), 'Opening options keeps the live webpage visible');
      assert.ok(menu.open.ticks > menu.before.ticks, 'The webpage keeps animating under options');
      assert.equal(menu.after.scroll, menu.before.scroll, 'Options retains the page scroll position');
    }
  }
  if (process.env.WUU_CHROME_REAL_LINK === '1') {
    const events = [], original = view.setVisible;
    view.setVisible = function (visible) { events.push({ visible, at: performance.now() }); return original.call(this, visible); };
    try {
      let loadError;
      void wc.loadURL('https://example.com').catch(error => { loadError = String(error); });
      await until(() => !wc.isLoading() && wc.getURL().startsWith('https://example.com'), 'public website ready', 20000);
      if (loadError) throw new Error(loadError);
      await capture('public-link-before');
      const point = await wc.executeJavaScript(`(async()=>{const link=document.querySelector('a[href*="iana.org"]');link.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=link.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      events.length = 0;
      const outer = win.getContentBounds(), inner = view.getBounds();
      await nativeInput(['mousemove', String(Math.round(outer.x + inner.x + point.x)), String(Math.round(outer.y + inner.y + point.y)), 'click', '1']);
      await until(() => !wc.isLoading() && new URL(wc.getURL()).hostname.endsWith('iana.org'), 'public native link navigates', 20000);
      await capture('public-link-after');
      report.publicLink = { url: wc.getURL(), visible: view.getVisible(), events };
    } catch (error) { report.publicLink = { error: String(error), url: wc.getURL(), events }; }
    finally { view.setVisible = original; wc.stop(); }
    fs.writeFileSync(path.join(output, 'public-link.json'), JSON.stringify(report.publicLink, null, 2));
  }
  assert.ok(win.getChildWindows().length <= 1, 'Repeated hover reuses a bounded native hint window');
  win.webContents.setZoomFactor(1); await evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await settle();
};
