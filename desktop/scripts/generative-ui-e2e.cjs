// Runs the real native tool process, then feeds its result through Wuu's real
// artifact collector, plugin lifecycle, renderer and storage adapter in Electron.
// No inference service, account, API key, or user Wuu data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, clipboard } = require('electron');
let activeWindow;
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.env.WUU_GENUI_OUTPUT || path.join(root, 'desktop/out/e2e/generative-ui'));
const helper = process.env.WUU_GENERATIVE_UI_PLUGIN_HELPER || path.join(root, 'desktop/build/bin/wuu-generative-ui-plugin');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
if (app) app.setPath('userData', profile);
const source = path.join(root, 'internal/plugin/bundled/generative-ui/desktop.js');
const spec = {
  version: 1, title: 'Project delivery overview', fallback: 'Design: 12 tasks. Engineering: 24 tasks. Review: 8 tasks. The local form does not submit data.',
  blocks: [
    { id: 'intro', type: 'text', text: 'Explore the project locally. Filter or sort the table, inspect the chart, and prepare a small follow-up draft.' },
    { id: 'teams', type: 'table', title: 'Team progress', columns: [{ key: 'team', label: 'Team' }, { key: 'tasks', label: 'Tasks' }], rows: [['Design', 12], ['Engineering', 24], ['Review', 8]] },
    { id: 'progress', type: 'chart', title: 'Weekly completions', chartType: 'line', xLabel: 'Week', yLabel: 'Completed tasks', points: Array.from({ length: 30 }, (_, i) => ({ label: `Week ${i + 1}`, value: (i * 7) % 19 - 4 })) },
    { id: 'draft', type: 'form', title: 'Prepare a follow-up', fields: [{ id: 'owner', label: 'Owner', kind: 'text', initial: 'Design' }, { id: 'priority', label: 'Priority', kind: 'select', options: ['Normal', 'High'] }, { id: 'estimate', label: 'Estimate', kind: 'number' }, { id: 'ready', label: 'Ready for review', kind: 'checkbox' }] },
  ],
};
const state = key => ({ op: 'state', key });
const literal = value => ({ op: 'literal', value });
const operation = (op, ...args) => ({ op, args });
const samplePoints = [{ label: 'Design', value: 18 }, { label: 'Engineering', value: 32 }, { label: 'Review', value: 12 }];
const program = {
  version: 2, title: 'Delivery scenario planner', fallback: 'An interactive local scenario with editable capacity, computed totals, local tabs, and six chart types.',
  state: [{ id: 'capacity', value: 40 }, { id: 'tab', value: 'overview' }, { id: 'includeReview', value: true }, { id: 'note', value: 'Local scenario' }],
  body: [
    { id: 'introV2', type: 'caption', text: 'Adjust the scenario. Calculations and view changes stay in this conversation until you explicitly send a message.' },
    { id: 'controlsV2', type: 'grid', columns: 2, children: [
      { id: 'capacityInput', type: 'input', inputType: 'number', label: 'Weekly capacity', state: 'capacity' },
      { id: 'capacitySlider', type: 'slider', label: 'Capacity adjustment', state: 'capacity', min: 0, max: 200 },
      { id: 'reviewToggle', type: 'checkbox', label: 'Include review', state: 'includeReview' },
      { id: 'noteInput', type: 'textarea', label: 'Scenario notes', state: 'note' },
    ] },
    { id: 'tabsV2', type: 'segmented', label: 'View', state: 'tab', options: [{ label: 'Overview', value: 'overview' }, { label: 'Details', value: 'details' }] },
    { id: 'overviewOnly', type: 'if', when: operation('eq', state('tab'), 'overview'), then: [
      { id: 'statsV2', type: 'grid', columns: 3, children: [
        { id: 'capacityMetric', type: 'metric', label: 'Monthly capacity', value: operation('multiply', state('capacity'), 4), detail: '4 weeks per scenario' },
        { id: 'reviewMetric', type: 'metric', label: 'Review allocation', value: operation('if', state('includeReview'), operation('multiply', state('capacity'), 0.2), 0) },
        { id: 'progressV2', type: 'progress', label: 'Capacity target', value: state('capacity'), max: 200 },
      ] },
    ], else: [
      { id: 'detailsList', type: 'each', items: operation('filter', literal([{ name: 'Design', value: 18 }, { name: 'Engineering', value: 32 }]), operation('gt', { op: 'item', path: ['value'] }, 20)), children: [
        { id: 'detailText', type: 'text', text: operation('concat', { op: 'item', path: ['name'] }, ': ', { op: 'item', path: ['value'] }) },
      ] },
    ] },
    { id: 'buttonsV2', type: 'flow', children: [
      { id: 'increaseV2', type: 'button', label: 'Add 10', onClick: [{ type: 'set', state: 'capacity', value: operation('add', state('capacity'), 10) }] },
      { id: 'invalidV2', type: 'button', label: 'Check invalid calculation', onClick: [{ type: 'set', state: 'capacity', value: operation('divide', state('capacity'), 0) }] },
      { id: 'resetV2', type: 'button', label: 'Reset scenario', onClick: [{ type: 'reset' }] },
    ] },
    { id: 'scenarioForm', type: 'form', label: 'Apply note', children: [
      { id: 'requiredNote', type: 'input', label: 'Required scenario note', state: 'note', required: true, invalid: operation('eq', state('note'), 'invalid') },
    ], onSubmit: [{ type: 'set', state: 'capacity', value: 100 }] },
    { id: 'chartGridV2', type: 'grid', columns: 2, gap: 'large', children: [
      { id: 'areaV2', type: 'chart', title: 'Capacity projection', chartType: 'area', points: operation('map', operation('range', 1, 6), operation('object', 'label', operation('concat', 'Week ', { op: 'item' }), 'value', operation('multiply', { op: 'item' }, state('capacity')))) },
      { id: 'mixedV2', type: 'chart', title: 'Completed and planned', chartType: 'bar', series: [{ id: 'actual', label: 'Completed', points: literal(samplePoints) }, { id: 'plan', label: 'Planned', chartType: 'line', points: literal(samplePoints.map(point => ({ ...point, value: point.value + 8 }))) }] },
      { id: 'scatterV2', type: 'chart', title: 'Effort vs impact', chartType: 'scatter', points: literal([{ label: 'A', x: 2, value: 7 }, { label: 'B', x: 5, value: 3 }, { label: 'C', x: 9, value: 10 }]) },
      { id: 'stackedV2', type: 'chart', title: 'Work allocation', chartType: 'bar', stacked: true, series: [{ id: 'first', label: 'Current', points: literal(samplePoints) }, { id: 'second', label: 'Next', points: literal(samplePoints.map(point => ({ ...point, value: point.value / 2 }))) }] },
      { id: 'pieV2', type: 'chart', title: 'Team share', chartType: 'pie', points: literal(samplePoints) },
      { id: 'donutV2', type: 'chart', title: 'Capacity share', chartType: 'donut', points: literal(samplePoints) },
    ] },
    { id: 'detailsV2', type: 'disclosure', title: 'Scenario data', children: [
      { id: 'tableV2', type: 'table', columns: [{ key: 'week', label: 'Week' }, { key: 'tasks', label: 'Tasks' }], rows: operation('map', operation('range', 1, 5), operation('array', { op: 'item' }, operation('multiply', { op: 'item' }, state('capacity')))) },
    ] },
  ],
};

function toolCall(value, index = 1) {
  const requests = [
    { id: 'init', method: 'initialize', params: { protocol_version: 1, capability_protocol_version: 3, plugin_id: 'generative-ui' } },
    { id: 'call', method: 'tool.execute', params: { tool_id: 'render_ui', thread_id: 'synthetic-thread', turn_id: 'synthetic-turn', call_id: `call-${index}`, arguments: { spec: value } } },
    { id: 'end', method: 'shutdown' },
  ];
  const stdout = execFileSync(helper, [], { input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(messages.find(message => message.id === 'init')?.result, 'Native plugin initialized');
  return messages.find(message => message.id === 'call');
}
function edit(change) { const value = structuredClone(spec); change(value); return value; }
const cases = [
  ['valid', spec, true],
  ['bar-chart', edit(s => { s.blocks[2].chartType = 'bar'; }), true],
  ['empty-table', edit(s => { s.blocks[1].rows = []; }), true],
  ['zero-chart', edit(s => { s.blocks[2].points = [{ label: 'Zero', value: 0 }]; }), true],
  ['unicode', edit(s => { s.blocks[0].text = '中文🙂'; }), true],
  ['html-as-text', edit(s => { s.blocks[0].text = '<img src=x onerror=alert(1)>'; }), true],
  ['unknown-version', edit(s => { s.version = 2; }), false],
  ['unknown-property', edit(s => { s.onLoad = 'run'; }), false],
  ['unknown-block', edit(s => { s.blocks[0].type = 'iframe'; }), false],
  ['style-injection', edit(s => { s.blocks[0].style = { color: 'red' }; }), false],
  ['duplicate-block', edit(s => { s.blocks[1].id = 'intro'; }), false],
  ['duplicate-column', edit(s => { s.blocks[1].columns[1].key = 'team'; }), false],
  ['row-width', edit(s => { s.blocks[1].rows[0].push('extra'); }), false],
  ['cell-object', edit(s => { s.blocks[1].rows[0][0] = { html: 'x' }; }), false],
  ['large-number', edit(s => { s.blocks[2].points[0].value = 1e13; }), false],
  ['too-many-points', edit(s => { s.blocks[2].points = Array(101).fill({ label: 'x', value: 1 }); }), false],
  ['duplicate-option', edit(s => { s.blocks[3].fields[1].options = ['x', 'x']; }), false],
  ['wrong-form-initial', edit(s => { s.blocks[3].fields[3].initial = 'true'; }), false],
  ['extra-field-options', edit(s => { s.blocks[3].fields[0].options = ['x']; }), false],
  ['prototype-id', edit(s => { s.blocks[0].id = '__proto__'; }), false],
  ['empty-fallback', edit(s => { s.fallback = ' '; }), false],
  ['empty-blocks', edit(s => { s.blocks = []; }), false],
  ['too-many-rows', edit(s => { s.blocks[1].rows = Array(201).fill(['x', 1]); }), false],
  ['byte-budget', edit(s => { s.blocks = Array.from({ length: 16 }, (_, i) => ({ id: `text${i}`, type: 'text', text: '界'.repeat(4000) })); }), false],
];
const results = { sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'), helperSha256: createHash('sha256').update(fs.readFileSync(helper)).digest('hex'), cases: [], checks: [], categoryAxes: [] };
const result = toolCall(spec).result?.result;
assert.ok(result && !result.is_error, 'Valid tool result');
const resource = result.content.find(part => part.type === 'resource');
assert.equal(resource.mime_type, 'application/vnd.wuu.ui+json');
assert.equal(resource.artifact.placement, 'inline');
assert.ok(result.content.some(part => part.type === 'text' && part.text.includes('Design')));
fs.writeFileSync(path.join(output, 'tool-result.json'), JSON.stringify(result, null, 2));
for (const [name, value, valid] of cases) {
  const response = toolCall(value, name);
  const accepted = !!response.result?.result && !response.result.result.is_error && !response.error;
  assert.equal(accepted, valid, `Native schema: ${name}`);
  results.cases.push({ name, accepted });
}
const fixture = path.join(output, 'fixture.tsx');
fs.writeFileSync(fixture, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { collectTurnArtifacts, TurnInlineArtifactOutputs } from ${JSON.stringify(path.join(root, 'desktop/src/renderer/ArtifactOutputs'))};
import { ArtifactThreadContext } from ${JSON.stringify(path.join(root, 'desktop/src/renderer/ArtifactPreviewContext'))};
import { desktopPluginHost, desktopWorkbenchController } from ${JSON.stringify(path.join(root, 'desktop/src/renderer/plugins/DesktopPluginRuntime'))};
import { I18nProvider } from ${JSON.stringify(path.join(root, 'desktop/src/renderer/i18n'))};
import { activate, parseSpec, parseToolInput } from ${JSON.stringify(source)};
import ${JSON.stringify(path.join(root, 'desktop/src/renderer/styles.css'))};
const root = createRoot(document.getElementById('root'));
let threadId = 'synthetic-thread';
let itemId = 'tool-call';
let currentResult = ${JSON.stringify(result)};
let streamingInput = null;
let failStorage = false;
let mounted = true;
let pending = 0;
desktopWorkbenchController.updateServices({
 getStorage: async (_p, _g, key) => { if (failStorage) throw Error('Fixture storage unavailable'); return localStorage.getItem(key); },
 setStorage: async (_p, _g, key, value) => { pending++; try { if (failStorage) throw Error('Fixture storage unavailable'); localStorage.setItem(key, value); } finally { pending--; } },
});
function render() {
 const turn = { id:'fixture-turn', items: [{ id:itemId, type:'tool_call', status:streamingInput?.status ?? 'completed', arguments:streamingInput?.text, display:streamingInput ? {capability:'generative-ui', label:'Building view'} : undefined, result_detail:streamingInput?.final ? currentResult : streamingInput ? undefined : currentResult }] };
 root.render(<I18nProvider><ArtifactThreadContext.Provider value={threadId}>{mounted ? <TurnInlineArtifactOutputs artifacts={collectTurnArtifacts(turn)} /> : null}</ArtifactThreadContext.Provider></I18nProvider>);
}
window.probe = {
 async enable() { await desktopPluginHost.activateGeneration({ pluginId:'generative-ui', generation:'e2e', register:activate }); render(); },
 disable() { desktopPluginHost.disable('generative-ui'); render(); },
 mount(value = true) { mounted=value; render(); },
 thread(value) { threadId=value; render(); },
 item(value) { itemId=value; render(); },
 result(value) { streamingInput=null; currentResult=value; render(); },
 preview(text,status="in_progress",final=false) { streamingInput={text,status,final};render(); },
 finish(value) { currentResult=value;streamingInput={...streamingInput,status:"completed",final:true};render(); },
 failStorage(value) { failStorage=value; },
 parse(raw) { try { parseSpec(raw); return true; } catch { return false; } },
 parsePrefix(raw) { try { return parseToolInput(raw); } catch { return null; } },
 get pending() { return pending; },
};
render();
`);
// Resolve Vite's URL/inline asset imports for this standalone production-component fixture.
const pdfWorker = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
fs.copyFileSync(pdfWorker, path.join(output, 'pdf.worker.min.mjs'));
fs.writeFileSync(path.join(output, 'pdf-worker-url.js'), 'export default "./pdf.worker.min.mjs";');
fs.writeFileSync(path.join(output, 'pdf-inline-css.js'), `export default ${JSON.stringify(fs.readFileSync(require.resolve('pdfjs-dist/web/pdf_viewer.css'), 'utf8'))};`);
buildSync({ entryPoints: [fixture], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', alias: { 'pdfjs-dist/build/pdf.worker.min.mjs?url': path.join(output, 'pdf-worker-url.js'), 'pdfjs-dist/web/pdf_viewer.css?inline': path.join(output, 'pdf-inline-css.js') }, define: { 'import.meta.env': '{}' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.gif': 'file' }, nodePaths: [path.join(root, 'desktop/node_modules')], logLevel: 'warning' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\' data:; img-src \'self\' data:"><link rel="stylesheet" href="fixture.css"><style>body{overflow:auto;margin:0;padding:32px}#root{max-width:760px;margin:auto}html{--font-size:14px}</style></head><body><main id="root"></main><script src="fixture.js"></script></body></html>');
if (process.env.WUU_GENUI_PREPARE_ONLY === '1') {
  fs.writeFileSync(path.join(output, 'native-validation.json'), JSON.stringify(results, null, 2));
  fs.rmSync(profile, { recursive:true, force:true });
  console.log('Native validation passed and Electron fixture built; renderer checks not run.');
  process.exit(0);
}
async function evaluate(win, script) { return win.webContents.executeJavaScript(script, true); }
async function waitFor(win, expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(win, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timed out: ${expression}`);
}
async function input(win, selector, value) {
  await evaluate(win, `(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function click(win, selector) {
  const box = await evaluate(win, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  win.webContents.sendInputEvent({ type:'mouseDown', x:Math.round(box.x), y:Math.round(box.y), button:'left', clickCount:1 });
  win.webContents.sendInputEvent({ type:'mouseUp', x:Math.round(box.x), y:Math.round(box.y), button:'left', clickCount:1 });
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width:1100, height:1200, show:true, webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } });
  activeWindow = win;
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  await win.loadFile(path.join(output, 'index.html'));
  win.focus();
  win.webContents.focus();
  await waitFor(win, '!!window.probe');
  assert.equal(await evaluate(win, `!!document.querySelector('[data-wuu-component="generated-ui"]')`), false);
  assert.ok(await evaluate(win, `document.body.textContent.includes('Design: 12 tasks')`));
  results.checks.push('disabled renderer keeps ordinary text fallback');
  for (const [name, value, valid] of cases) assert.equal(await evaluate(win, `window.probe.parse(${JSON.stringify(JSON.stringify(value))})`), valid, `Renderer schema: ${name}`);
  results.checks.push('native and renderer schema agreement');
  await evaluate(win, 'window.probe.enable()');
  await waitFor(win, `document.querySelector('[data-wuu-component="generated-ui"]')?.getAttribute('aria-busy') === 'false'`);
  await input(win, '[data-genui-block="teams"] input', 'engineering');
  await waitFor(win, `document.querySelectorAll('[data-genui-block="teams"] tbody tr').length === 1`);
  await input(win, '[data-genui-block="teams"] input', '');
  await click(win, '[data-genui-block="teams"] th:nth-child(2) button');
  await waitFor(win, `document.querySelector('[data-genui-block="teams"] tbody td')?.textContent === 'Review'`);
  await evaluate(win, `(() => {const s=document.querySelector('[data-genui-block="progress"] select');s.value='10';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(win, `document.querySelectorAll('[data-genui-block="progress"] tbody tr').length === 10`);
  await input(win, '[data-genui-block="draft"] input[type="text"]', 'Saved owner');
  await input(win, '[data-genui-block="draft"] input[type="number"]', '12.5');
  await click(win, '[data-genui-block="draft"] input[type="checkbox"]');
  await click(win, '[data-genui-block="draft"] button[type="submit"]');
  await waitFor(win, `document.querySelector('.plugin-genui-form-preview')?.textContent.includes('Saved owner')`);
  await clipboard.writeText('Synthetic untouched clipboard');
  await evaluate(win, `document.querySelector('.plugin-genui-form-preview button').click()`);
  assert.equal(await clipboard.readText(), 'Synthetic untouched clipboard', 'Synthetic events cannot copy');
  await click(win, '.plugin-genui-form-preview button');
  await waitFor(win, `document.querySelector('[data-genui-block="draft"]')?.textContent.includes('Copied')`);
  assert.ok((await clipboard.readText()).includes('Estimate: 12.5'));
  results.checks.push('filter, numeric sort, chart range, form preview and trusted-click copy');
  await waitFor(win, 'window.probe.pending === 0');
  await evaluate(win, 'window.probe.mount(false)');
  await waitFor(win, `!document.querySelector('[data-wuu-component="generated-ui"]')`);
  await evaluate(win, 'window.probe.mount()');
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Saved owner'`);
  await evaluate(win, `window.probe.thread('other-thread')`);
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Design'`);
  await evaluate(win, `window.probe.thread('synthetic-thread')`);
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Saved owner'`);
  results.checks.push('unmount restore and conversation isolation');
  await evaluate(win, `window.probe.item('other-message')`);
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Design'`);
  await evaluate(win, `window.probe.item('tool-call')`);
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Saved owner'`);
  const independent = structuredClone(result); independent.content.find(part => part.type === 'resource').artifact.ref = 'second-widget';
  await evaluate(win, `window.probe.result(${JSON.stringify(independent)})`);
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Design'`);
  await evaluate(win, `window.probe.result(${JSON.stringify(result)})`);
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Saved owner'`);
  results.checks.push('message and explicit resource-instance isolation');

  await evaluate(win, 'window.probe.disable()');
  await waitFor(win, `!document.querySelector('[data-wuu-component="generated-ui"]') && document.body.textContent.includes('Design: 12 tasks')`);
  await evaluate(win, 'window.probe.enable()');
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Saved owner'`);
  results.checks.push('disable/re-enable preserves fallback and local state');
  win.reload();
  await waitFor(win, '!!window.probe');
  await evaluate(win, 'window.probe.enable()');
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Saved owner'`);
  await click(win, '[data-genui-block="draft"] button[type="submit"]');
  await waitFor(win, `!!document.querySelector('.plugin-genui-form-preview')`);
  await click(win, '[data-genui-block="draft"] form button[type="button"]');
  await waitFor(win, `document.querySelector('[data-genui-block="draft"] input[type="text"]')?.value === 'Design' && !document.querySelector('.plugin-genui-form-preview')`);
  results.checks.push('full renderer reload restores state; reset restores defaults and dismisses preview');

  const settlePaint = () => evaluate(win, `(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  for (const theme of ['light', 'dark']) for (const size of [14, 20]) for (const width of [1100, 480]) {
    win.setContentSize(width, 1200);
    await evaluate(win, `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.setProperty('--wuu-font-size-ui', '${size}px');document.documentElement.style.setProperty('--font-ui', '${size}px');window.scrollTo({top:0,behavior:'instant'})`);
    await settlePaint();
    const geometry = await evaluate(win, `(() => { const r=document.querySelector('.plugin-genui').getBoundingClientRect(); return {width:innerWidth, right:r.right, left:r.left, scroll:document.documentElement.scrollWidth, lineStroke:getComputedStyle(document.querySelector('.plugin-genui-line')).stroke, labelSize:parseFloat(getComputedStyle(document.querySelector('.plugin-genui-y-labels')).fontSize), axisOffsets:[...document.querySelectorAll('.plugin-genui-y-labels span')].map((node,index)=>{const label=node.getBoundingClientRect(),plot=document.querySelector('.plugin-genui-chart').getBoundingClientRect();return Math.abs((label.top+label.bottom)/2-(plot.top+plot.height*index/2));})}; })()`);
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.scroll <= width + 1, JSON.stringify(geometry));
    assert.notEqual(geometry.lineStroke, 'none', 'Chart line is painted without optional theme overrides');
    assert.ok(geometry.labelSize >= size, 'Chart labels retain the user UI font size');
    assert.ok(geometry.axisOffsets.every(offset=>offset<1), 'Y-axis labels align with their grid values');
    fs.writeFileSync(path.join(output, `${theme}-${size}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await evaluate(win, `document.querySelector('[data-genui-block="draft"]').scrollIntoView({block:'center',behavior:'instant'})`);
    await settlePaint();
    assert.ok(await evaluate(win, `(() => { const r=document.querySelector('[data-genui-block="draft"] input').getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight; })()`), 'Form input is visible before screenshot');
    fs.writeFileSync(path.join(output, `${theme}-${size}-${width}-form.png`), (await win.webContents.capturePage()).toPNG());
  }
  results.checks.push('light/dark, 14/20 px, wide/narrow screenshots and page overflow');
  await click(win, '[data-genui-block="draft"] input[type="text"]');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await waitFor(win, `document.activeElement === document.querySelector('[data-genui-block="draft"] select')`);
  assert.equal(await evaluate(win, `document.activeElement.matches(':focus-visible')`), true);
  fs.writeFileSync(path.join(output, 'keyboard-focus.png'), (await win.webContents.capturePage()).toPNG());
  results.checks.push('native keyboard focus reaches the next form control visibly');
  const bars = toolCall(edit(s => { s.blocks[2].chartType = 'bar'; }), 'bar-render').result.result;
  await evaluate(win, `window.probe.result(${JSON.stringify(bars)})`);
  await waitFor(win, `document.querySelectorAll('.plugin-genui-chart rect').length === 30`);
  await evaluate(win, `document.querySelector('[data-genui-block="progress"]').scrollIntoView({block:'center',behavior:'instant'})`);
  await settlePaint();
  fs.writeFileSync(path.join(output, 'bar-chart.png'), (await win.webContents.capturePage()).toPNG());
  for (const chartType of ['bar', 'line']) for (const count of [1, 2, 7]) {
    const categories = toolCall(edit(s => {
      s.blocks[2].chartType = chartType;
      s.blocks[2].points = Array.from({ length: count }, (_, i) => ({ label: ['Design', 'Engineering'][i] || `Team ${i + 1}`, value: (i + 1) * 12 }));
    }), `${chartType}-categories-${count}`).result.result;
    await evaluate(win, `window.probe.result(${JSON.stringify(categories)})`);
    await waitFor(win, `document.querySelectorAll('.plugin-genui-x-categories span').length === ${count}`);
    for (const [theme, size, width] of [['light', 14, 1100], ['dark', 20, 480]]) {
      win.setContentSize(width, 1200);
      await evaluate(win, `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.setProperty('--wuu-font-size-ui', '${size}px');document.documentElement.style.setProperty('--font-ui', '${size}px');document.querySelector('[data-genui-block="progress"]').scrollIntoView({block:'center',behavior:'instant'})`);
      await settlePaint();
      const labels = await evaluate(win, `(() => { const marks=[...document.querySelectorAll('.plugin-genui-chart ${chartType === 'bar' ? 'rect' : 'circle'}')];return [...document.querySelectorAll('.plugin-genui-x-categories span')].map((node,index)=>{const label=node.getBoundingClientRect(),mark=marks[index].getBoundingClientRect();const style=getComputedStyle(node);return {offset:Math.abs((label.left+label.right-mark.left-mark.right)/2),fontSize:parseFloat(style.fontSize),singleLine:label.height<=parseFloat(style.lineHeight)+1,fullName:node.title===node.textContent&&document.querySelector('[data-genui-block="progress"] details').textContent.includes(node.title)};}); })()`);
      results.categoryAxes.push({ chartType, count, theme, size, width, labels });
      assert.ok(labels.every(label => label.offset < 1 && label.fontSize >= size && label.singleLine && label.fullName), `${chartType} ${count} category labels align with marks without shrinking text`);
      if (chartType === 'bar' && count === 2) fs.writeFileSync(path.join(output, `bar-categories-${theme}-${size}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      if (chartType === 'bar' && count === 7 && width === 480) fs.writeFileSync(path.join(output, 'bar-categories-seven-dark-20-480.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  await evaluate(win, `window.probe.result(${JSON.stringify(result)})`);
  await waitFor(win, `document.querySelector('[data-wuu-component="generated-ui"]')?.getAttribute('aria-busy') === 'false'`);
  results.checks.push('bar/line category-label centers for 1, 2 and 7 marks at wide/default and narrow/large sizes');

  await evaluate(win, 'window.probe.failStorage(true)');
  await input(win, '[data-genui-block="draft"] input[type="text"]', 'Still editable');
  await waitFor(win, `document.body.textContent.includes('could not be saved')`);
  results.checks.push('storage failure stays editable and warns');

  const literal = toolCall(edit(s => { s.fallback = '![Do not fetch](https://example.test/pixel)'; s.blocks[0].text = '<img src=x onerror=alert(1)>'; }), 'literal').result.result;
  await evaluate(win, `window.probe.result(${JSON.stringify(literal)})`);
  await waitFor(win, `document.body.textContent.includes('<img src=x onerror=alert(1)>')`);
  assert.equal(await evaluate(win, `!!document.querySelector('#root img, #root iframe')`), false);
  await evaluate(win, 'window.probe.disable()');
  await waitFor(win, `document.body.textContent.includes('![Do not fetch](https://example.test/pixel)')`);
  assert.equal(await evaluate(win, `!!document.querySelector('#root img, #root iframe')`), false);
  await evaluate(win, 'window.probe.enable()');
  results.checks.push('HTML and fallback Markdown remain literal without image or frame elements');
  const bad = structuredClone(result); bad.content.find(part => part.type === 'resource').resource.text = '{"version":99}';
  await evaluate(win, `window.probe.result(${JSON.stringify(bad)})`);
  await waitFor(win, `document.body.textContent.includes('Interactive preview unavailable') && document.body.textContent.includes('Design: 12 tasks')`);
  results.checks.push('invalid historical payload preserves text fallback');
  await evaluate(win, 'window.probe.failStorage(false)');
  const programResult = toolCall(program, 'reactive-program').result?.result;
  assert.ok(programResult && !programResult.is_error, 'Native helper accepts rich version 2 program');
  await evaluate(win, `window.probe.result(${JSON.stringify(programResult)})`);
  await waitFor(win, `document.querySelector('.plugin-genui-program')?.getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="capacityMetric"] strong')?.textContent`), '160');
  const nativeInput = async (selector, value) => {
    await click(win, selector);
    await evaluate(win, `document.querySelector(${JSON.stringify(selector)}).select()`);
    await win.webContents.insertText(value);
  };
  await nativeInput('[data-genui-node="capacityInput"]', '50');
  await waitFor(win, `document.querySelector('[data-genui-node="capacityMetric"] strong')?.textContent === '200'`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="capacitySlider"] input').value`), '50');
  await click(win, '[data-genui-node="capacityInput"]');
  await evaluate(win, `document.querySelector('[data-genui-node="capacityInput"]').select()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await waitFor(win, `document.querySelector('[data-genui-node="capacityInput"]').value === ''`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="capacityMetric"] strong').textContent`), '200', 'An empty numeric draft does not corrupt committed calculations');
  await win.webContents.insertText('75');
  await waitFor(win, `document.querySelector('[data-genui-node="capacityMetric"] strong').textContent === '300'`);
  await click(win, '[data-genui-node="increaseV2"] button');
  await waitFor(win, `document.querySelector('[data-genui-node="capacityInput"]').value === '85'`);
  await click(win, '[data-genui-node="invalidV2"] button');
  await waitFor(win, `document.body.textContent.includes('Cannot divide by zero')`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="capacityMetric"] strong').textContent`), '340', 'Failed computation keeps last committed state and tree');
  await click(win, '[data-genui-node="reviewToggle"]');
  await waitFor(win, `document.querySelector('[data-genui-node="reviewMetric"] strong').textContent === '0'`);
  await click(win, '[data-genui-node="tabsV2"] label:nth-child(2)');
  await waitFor(win, `document.querySelector('[data-genui-node="detailsList"]').textContent === 'Engineering: 32'`);
  assert.equal(await evaluate(win, `!!document.querySelector('[data-genui-node="capacityMetric"]')`), false);
  await click(win, '[data-genui-node="tabsV2"] label:nth-child(1)');
  await waitFor(win, `!!document.querySelector('[data-genui-node="capacityMetric"]')`);
  await waitFor(win, 'window.probe.pending === 0');
  await evaluate(win, 'window.probe.mount(false)');
  await waitFor(win, `!document.querySelector('.plugin-genui-program')`);
  await evaluate(win, 'window.probe.mount(true)');
  await waitFor(win, `document.querySelector('[data-genui-node="capacityInput"]')?.value === '85'`);
  results.checks.push('v2 numeric drafts, bound sliders, reactive metrics, map/filter/each, local tabs, atomic calculation failure and durable state');
  await nativeInput('[data-genui-node="requiredNote"]', 'invalid');
  await click(win, '[data-genui-node="scenarioForm"] button[type="submit"]');
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="capacityInput"]').value`), '85', 'Declarative invalid state blocks native form submission');
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="requiredNote"]').validity.customError`), true);
  await nativeInput('[data-genui-node="requiredNote"]', 'Approved local note');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(win, `document.querySelector('[data-genui-node="capacityInput"]').value === '100'`);
  results.checks.push('native form invalid-field gating and keyboard Enter submission');


  await click(win, '[data-genui-node="mixedV2"] .plugin-genui-legend button:nth-child(1)');
  await waitFor(win, `document.querySelectorAll('[data-genui-node="mixedV2"] svg rect').length === 0`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="mixedV2"] .plugin-genui-legend button').getAttribute('aria-pressed')`), 'false');
  await click(win, '[data-genui-node="mixedV2"] .plugin-genui-legend button:nth-child(1)');
  await click(win, '[data-genui-node="areaV2"] svg');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ArrowRight' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ArrowRight' });
  await waitFor(win, `document.querySelector('[data-genui-node="areaV2"] .plugin-genui-chart-caption').textContent.includes('Week')`);
  assert.equal(await evaluate(win, `document.querySelectorAll('[data-genui-node="scatterV2"] svg circle').length`), 3);
  assert.equal(await evaluate(win, `document.querySelectorAll('[data-genui-node="stackedV2"] svg rect').length`), 6);
  assert.equal(await evaluate(win, `document.querySelectorAll('[data-genui-node="pieV2"] svg path').length`), 3);
  assert.equal(await evaluate(win, `document.querySelectorAll('[data-genui-node="donutV2"] svg path').length`), 3);
  await click(win, '[data-genui-node="detailsV2"] > summary');
  await waitFor(win, `document.querySelector('[data-genui-node="tableV2"] tbody td:nth-child(2)').textContent === '100'`);
  results.checks.push('v2 area/bar/line/scatter/pie/donut, stacked/mixed series, legend toggles, keyboard chart inspection and computed table');
  for (const theme of ['light', 'dark']) for (const size of [14, 20]) for (const width of [1100, 480]) {
    win.setContentSize(width, 1200);
    await evaluate(win, `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.setProperty('--wuu-font-size-ui','${size}px');document.documentElement.style.setProperty('--font-ui','${size}px');window.scrollTo({top:0,behavior:'instant'})`);
    await settlePaint();
    const geometry = await evaluate(win, `({width:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('.plugin-genui-program input,.plugin-genui-program textarea')].map(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,font:parseFloat(getComputedStyle(node).fontSize)}))})`);
    assert.ok(geometry.scroll <= width + 1, JSON.stringify(geometry));
    assert.ok(geometry.controls.every(control => control.left >= 0 && control.right <= width + 1 && control.font >= size), JSON.stringify(geometry));
    fs.writeFileSync(path.join(output, `v2-${theme}-${size}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await evaluate(win, `document.querySelector('[data-genui-node="chartGridV2"]').scrollIntoView({block:'start',behavior:'instant'})`);
    await settlePaint();
    fs.writeFileSync(path.join(output, `v2-charts-${theme}-${size}-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  results.checks.push('v2 light/dark, default/large type, wide/narrow controls and chart screenshots without page overflow');
  await waitFor(win, 'window.probe.pending === 0');
  await evaluate(win, `window.probe.mount(false)`);
  await waitFor(win, `!document.querySelector('.plugin-genui-program')`);
  await evaluate(win, `(() => {const key=Object.keys(localStorage).find(key=>{try{return JSON.parse(localStorage.getItem(key)).version===2&&Object.hasOwn(JSON.parse(localStorage.getItem(key)).values,'capacity')}catch{return false}});if(!key)throw Error('Missing persisted program state');localStorage.setItem(key,'{broken');window.probe.mount(true);})()`);
  await waitFor(win, `document.body.textContent.includes('Saved view state is unavailable') && document.querySelector('.plugin-genui-program')?.getAttribute('aria-busy') === 'false'`);
  await nativeInput('[data-genui-node="capacityInput"]', '60');
  await waitFor(win, `window.probe.pending === 0 && document.querySelector('[data-genui-node="capacityMetric"] strong').textContent === '240'`);
  await evaluate(win, `window.probe.mount(false)`);
  await waitFor(win, `!document.querySelector('.plugin-genui-program')`);
  await evaluate(win, `window.probe.mount(true)`);
  await waitFor(win, `document.querySelector('[data-genui-node="capacityInput"]')?.value === '60'`);
  results.checks.push('corrupt stored program state recovers and the next valid edit repairs durable storage');


  const streamed = { version: 2, title: 'Streamed scenario', fallback: 'A safe partial scenario.', state: [], body: [{ id: 'streamedText', type: 'text', text: 'Braces in text: "]}, with an escaped quote " and a slash \\.' }, { id: 'streamedSecond', type: 'text', text: 'Second complete node' }] };
  const argumentsText = JSON.stringify({ spec: streamed });
  const boundary = argumentsText.indexOf(JSON.stringify(streamed.body[0])) + JSON.stringify(streamed.body[0]).length;
  await evaluate(win, `window.probe.preview(${JSON.stringify(argumentsText.slice(0, boundary))})`);
  await waitFor(win, `document.querySelector('[data-genui-preview="true"]')?.textContent.includes('Braces in text')`);
  await evaluate(win, `window.originalPreview=document.querySelector('[data-wuu-component="generated-ui"]')`);
  assert.equal(await evaluate(win, `!!document.querySelector('[data-genui-node="streamedSecond"]')`), false);
  await evaluate(win, `window.probe.preview(${JSON.stringify(argumentsText.slice(0, -3))})`);
  await waitFor(win, `!!document.querySelector('[data-genui-node="streamedSecond"]')`);
  assert.equal(await evaluate(win, `window.originalPreview===document.querySelector('[data-wuu-component="generated-ui"]')`), true, 'Appending complete nodes preserves preview surface identity');
  const failedCalculation = argumentsText.slice(0, boundary) + ',{"id":"badCalculation","type":"text","text":{"op":"divide","args":[1,0]}}';
  await evaluate(win, `window.probe.preview(${JSON.stringify(failedCalculation)})`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="streamedSecond"]').textContent`), 'Second complete node', 'A schema-valid runtime error cannot replace the last valid preview');
  const malformed = argumentsText.slice(0, boundary) + ',{"id":"bad","type":"iframe"}';
  await evaluate(win, `window.probe.preview(${JSON.stringify(malformed)})`);
  assert.equal(await evaluate(win, `document.querySelector('[data-genui-node="streamedSecond"]').textContent`), 'Second complete node', 'Malformed next node cannot replace the last valid preview');
  await evaluate(win, `window.probe.preview(${JSON.stringify(malformed)},'failed')`);
  await waitFor(win, `document.querySelector('[data-genui-preview="true"]').getAttribute('aria-busy') === 'false' && document.body.textContent.includes('Generation stopped')`);
  await evaluate(win, `window.probe.finish(${JSON.stringify(bad)})`);
  await waitFor(win, `document.body.textContent.includes('The final view could not be validated') && !!document.querySelector('[data-genui-node="streamedSecond"]')`);
  await evaluate(win, `window.probe.mount(false)`);
  await waitFor(win, `!document.querySelector('[data-wuu-component="generated-ui"]')`);
  await evaluate(win, `window.probe.result(${JSON.stringify(bad)});window.probe.mount(true)`);
  await waitFor(win, `document.body.textContent.includes('Interactive preview unavailable')`);
  results.checks.push('escaped-string-safe complete-node streaming, stable preview identity, malformed successor rollback, stop clears busy, invalid final preserves live preview only');

  const manyRows = Array.from({length:200},()=>Array(8).fill(0));
  const renderBudget = {version:2,title:'Render budget',fallback:'The oversized view remains text-only.',state:[{id:'rows',value:manyRows}],body:[{id:'repeat',type:'each',items:operation('range',0,100),children:Array.from({length:9},(_,index)=>({id:`table${index}`,type:'table',columns:Array.from({length:8},(_,column)=>({key:`c${column}`,label:`Column ${column}`})),rows:state('rows')}))}]};
  const aliasBudget = {version:2,title:'Computation budget',fallback:'The oversized computation remains text-only.',state:[{id:'data',value:Array.from({length:40},()=>Array(200).fill(0))}],body:[{id:'result',type:'text',text:operation('length',operation('map',operation('range',0,95),operation('map',operation('range',0,95),state('data'))))}]};
  for (const [name,value,message] of [['expanded-data-budget',renderBudget,'Rendered data limit reached'],['aliased-computation-budget',aliasBudget,'Local computation limit reached']]) {
    const bounded = toolCall(value,name).result?.result;
    assert.ok(bounded&&!bounded.is_error,'Native schema accepts the bounded program syntax');
    await evaluate(win, `window.probe.result(${JSON.stringify(bounded)})`);
    await waitFor(win, `document.body.textContent.includes(${JSON.stringify(message)})`);
    assert.equal(await evaluate(win, `document.querySelectorAll('.plugin-genui-program td').length`),0,'Preflight rejects oversized output before data DOM is constructed');
  }
  results.checks.push('expanded table-cell and aliased collection-result budgets reject oversized runtime output before DOM construction');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  win.destroy();
  app.quit();
}).catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(output, 'failure.txt'), error.stack);
  if (activeWindow && !activeWindow.isDestroyed()) {
    fs.writeFileSync(path.join(output, 'failure.png'), (await activeWindow.webContents.capturePage()).toPNG());
    const state = await evaluate(activeWindow, `({text:document.body.innerText, focused:document.hasFocus(), activeElement:document.activeElement?.outerHTML})`).catch(() => null);
    fs.writeFileSync(path.join(output, 'failure-state.json'), JSON.stringify(state, null, 2));
  }
  app.exit(1);
});
app.on('will-quit', () => fs.rmSync(profile, { recursive:true, force:true }));
