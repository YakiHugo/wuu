// Regression: Chromium can report an empty CDP worker target URL. Passing the
// gate still requires native worker traffic and exact packaged asset provenance.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { installWorkerObserver, findPackagedWorker } = require('./packaged-runtime-smoke.cjs');
const root = 'file:///tmp/isolated%20app/wuu.app/Contents/Resources/app.asar/out/renderer/assets/';

function fixture(wrappers = {}) {
  class NativeWorker {
    static sentinel = 42;
    constructor(url, options) { this.url = url; this.options = options; this.listeners = {}; this.sent = []; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    postMessage(...args) { this.sent.push(args); }
    terminate() { this.stopped = true; }
  }
  const context = vm.createContext({ Worker: NativeWorker, URL, location: { href: root + '../index.html' },
    fetch: async url => ({ text: async () => { if (!(url in wrappers)) throw Error('missing blob'); return wrappers[url]; } }) });
  vm.runInContext(`(${installWorkerObserver.toString()})()`, context);
  return { context, NativeWorker, records: () => JSON.parse(JSON.stringify(context.__wuuPackagedWorkers)) };
}

test('empty CDP URL needs no fallback when packaged worker actually responds; native behavior preserved', () => {
  const { context, NativeWorker, records } = fixture();
  const options = { type: 'module' };
  const worker = new context.Worker(new URL(root + 'ts.worker-hash.js'), options);
  assert.ok(worker instanceof NativeWorker && worker instanceof context.Worker);
  assert.equal(context.Worker.sentinel, 42);
  assert.equal(worker.options, options);
  const payload = { request: 1 }, transfer = [];
  worker.postMessage(payload, transfer);
  assert.equal(worker.sent[0][0], payload);
  assert.equal(worker.sent[0][1], transfer);
  assert.equal(findPackagedWorker(records(), 'ts.worker', root), null, 'construction alone cannot pass');
  worker.emit('message', { data: { response: 1 } });
  assert.equal(findPackagedWorker(records(), 'ts.worker', root).responses, 1);
});

test('PDF blob wrapper must import packaged worker and receive native response', async () => {
  const url = root + 'pdf.worker-hash.mjs';
  const { context, records } = fixture({ 'blob:null/pdf': `await import("${url}");` });
  const worker = new context.Worker('blob:null/pdf', { type: 'module' });
  worker.emit('message', { data: { action: 'ready' } });
  worker.emit('message', { data: { action: 'test', data: true } });
  await new Promise(setImmediate);
  assert.equal(findPackagedWorker(records(), 'pdf.worker', root), null, 'ready/test-only native worker may coexist with fake-worker fallback');
  worker.emit('message', { data: { action: 'GetDoc', data: { sensitive: 'do not retain' } } });
  assert.equal(findPackagedWorker(records(), 'pdf.worker', root), null, 'document handshake alone does not prove page rendering');
  worker.emit('message', { data: { action: 'StartRenderPage', data: { sensitive: 'do not retain' } } });
  assert.equal(findPackagedWorker(records(), 'pdf.worker', root).sourceURL, url);
  assert.equal(JSON.stringify(records()).includes('do not retain'), false, 'worker payloads must not be logged');
  worker.terminate();
  assert.equal(worker.stopped, true);
  assert.equal(findPackagedWorker(records(), 'pdf.worker', root), null, 'terminated worker cannot conceal fake-worker fallback');
});

test('failed workers, absent workers, wrong roots and spoofed blob wrappers fail closed', async () => {
  assert.equal(findPackagedWorker([], 'pdf.worker', root), null);
  for (const url of ['https://example.com/ts.worker.js', 'file:///checkout/ts.worker.js', root + '../ts.worker.js', root + 'other.js']) {
    const { context, records } = fixture();
    new context.Worker(url).emit('message');
    assert.equal(findPackagedWorker(records(), 'ts.worker', root), null, url);
  }
  for (const type of ['error', 'messageerror']) {
    const { context, records } = fixture();
    const worker = new context.Worker(root + 'ts.worker-hash.js');
    worker.emit('message'); worker.emit(type, { message: 'failed' });
    assert.equal(findPackagedWorker(records(), 'ts.worker', root), null, type);
  }
  for (const wrapper of [`// ${root}pdf.worker.js\nawait import("https://example.com/pdf.worker.js");`, `await import("${root}pdf.worker.js"); throw Error("fallback");`, 'invalid']) {
    const { context, records } = fixture({ 'blob:null/pdf': wrapper });
    const worker = new context.Worker('blob:null/pdf');
    worker.emit('message', { data: { action: 'GetDoc' } });
    worker.emit('message', { data: { action: 'StartRenderPage' } });
    await new Promise(setImmediate);
    assert.equal(findPackagedWorker(records(), 'pdf.worker', root), null);
  }
});
