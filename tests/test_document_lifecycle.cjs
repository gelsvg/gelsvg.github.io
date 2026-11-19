const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { root, tick, deferred, button, file, page, result, open } = require('./browser_harness.cjs');

test('selecting B immediately removes A; a delayed A result cannot append panels', async () => {
  const p = page();
  const openingA = p.context.openFile(file('A.gel.svg'));
  await tick();
  const requestA = p.requests('open')[0];
  const readingB = deferred();
  const openingB = p.context.openFile(file('B.gel.svg', readingB.promise));
  assert.equal(p.requests('select').length, 2);
  assert.equal(p.get('doc-title').textContent, 'B.gel.svg');
  assert.equal(p.get('panels').children.length, 0);
  p.worker.reply(requestA, result('A only'));
  await openingA;
  assert.equal(p.get('panels').children.length, 0);
  readingB.resolve(new ArrayBuffer(4));
  await tick();
  p.worker.reply(p.requests('open').at(-1), result('B only'));
  await openingB;
  assert.match(p.get('panels').textContent, /B only/);
  assert.doesNotMatch(p.get('panels').textContent, /A only/);
  assert.equal(p.pending(), 0);
});

test('the last selection wins even when file buffers finish in reverse order', async () => {
  const p = page(), a = deferred(), b = deferred();
  const openingA = p.context.openFile(file('A.gel.svg', a.promise));
  const openingB = p.context.openFile(file('B.gel.svg', b.promise));
  b.resolve(new ArrayBuffer(4));
  await tick();
  const requestB = p.requests('open')[0];
  p.worker.reply(requestB, result('B only'));
  await openingB;
  a.resolve(new ArrayBuffer(4));
  await openingA;
  assert.deepEqual(p.requests('open').map(r => r.name), ['B.gel.svg']);
  assert.equal(p.get('doc-title').textContent, 'B.gel.svg');
  assert.match(p.get('panels').textContent, /B only/);
});

test('a stale parse error cannot replace the current file with an error', async () => {
  const p = page();
  const openingA = p.context.openFile(file('A.gel.svg'));
  await tick();
  const requestA = p.requests('open')[0];
  await open(p, 'B.gel.svg', result('B only'));
  p.worker.reply(requestA, null, 'A was damaged');
  await openingA;
  assert.equal(p.get('doc-status').textContent, '');
  assert.match(p.get('panels').textContent, /B only/);
  assert.equal(p.pending(), 0);
});

test('file read errors are handled, and an old file read error is ignored', async () => {
  const p = page(), a = deferred();
  const openingA = p.context.openFile(file('A.gel.svg', a.promise));
  await open(p, 'B.gel.svg', result('B only'));
  a.reject(new Error('A unreadable'));
  await openingA;
  assert.equal(p.get('doc-status').textContent, '');
  await p.context.openFile(file('C.gel.svg', Promise.reject(new Error('C unreadable'))));
  assert.match(p.get('doc-status').textContent, /C unreadable/);
  assert.equal(p.get('panels').children.length, 0);
});

test('a normal save works; stale save replies and retained old buttons cannot download', async () => {
  const p = page();
  const requestA = await open(p, 'A.gel.svg', result('A', { readable: true }));
  const saveA = button(p.get('panels'), 'Save the picture');
  const saving = saveA.click();
  let request = p.requests('save').at(-1);
  assert.equal(request.documentId, requestA.documentId);
  p.worker.reply(request, { bytes: Uint8Array.of(10), name: 'panel-1-picture.png' });
  await saving;
  assert.equal(p.downloads[0].name, 'A-panel-1-picture.png');
  const secondSave = saveA.click();
  request = p.requests('save').at(-1);
  const readingB = deferred();
  const openingB = p.context.openFile(file('B.gel.svg', readingB.promise));
  p.worker.reply(request, { bytes: Uint8Array.of(10), name: 'panel-1-picture.png' });
  await secondSave;
  assert.equal(p.downloads.length, 1);
  const saves = p.requests('save').length;
  await saveA.click();
  assert.equal(p.requests('save').length, saves);
  assert.equal(p.downloads.length, 1);
  assert.equal(p.pending(), 0);
  readingB.resolve(new ArrayBuffer(4));
  await tick();
  p.worker.reply(p.requests('open').at(-1), result('B'));
  await openingB;
});

test('old converted SVG, JSON and comparison-image buttons cannot save after switching files', async () => {
  const p = page();
  await open(p, 'A.mywb.svg', result('A', { readable: true, converted: true }));
  const converted = button(p.get('doc-banners'), 'Save as .gel.svg');
  await button(p.get('panels'), 'File').click();
  await button(p.get('panels'), 'JSON').click();
  const json = button(p.get('panels'), 'Save the JSON');
  await button(p.get('panels'), 'Images').click();
  const comparing = button(p.get('panels'), 'Redraw and compare').click();
  p.worker.reply(p.requests('compare').at(-1), {
    state: 'same', message: 'same', differing: 0, notes: [], redrawn_png: Uint8Array.of(4), difference_png: Uint8Array.of(5),
  });
  await comparing;
  const redraw = button(p.get('panels'), 'Save the picture drawn again');
  const difference = button(p.get('panels'), 'Save the difference map');
  await converted.click();
  await json.click();
  await redraw.click();
  await difference.click();
  assert.equal(p.downloads.length, 4);
  const oldUrlCount = p.blobs.size;
  const readingB = deferred();
  const openingB = p.context.openFile(file('B.gel.svg', readingB.promise));
  assert.ok(p.revoked.length >= oldUrlCount);
  for (const stale of [converted, json, redraw, difference]) await stale.click();
  assert.equal(p.downloads.length, 4);
  readingB.resolve(new ArrayBuffer(4));
  await tick();
  p.worker.reply(p.requests('open').at(-1), result('B'));
  await openingB;
});

test('a delayed aligned-image response cannot populate an old image view', async () => {
  const p = page();
  await open(p, 'A.gel.svg', result('A', { readable: true, views: [{
    label: 'channel', channel: 'gray', element: 0, available: true, drawn: true, reference: true,
    size: [1, 1], contrast: [0, 255], invert: false, saveable: true,
  }] }));
  const stage = p.get('panels').querySelector('.stage');
  p.observers[0].callback([{ isIntersecting: true }]);
  await tick();
  const aligned = p.requests('aligned').at(-1);
  await open(p, 'B.gel.svg', result('B only'));
  p.worker.reply(aligned, { pixels: Uint8Array.of(10), dtype: 'uint8', shape: [1, 1] });
  await tick();
  assert.equal(stage.querySelector('canvas'), null);
  assert.match(p.get('panels').textContent, /B only/);
  assert.equal(p.pending(), 0);
});

test('a delayed comparison cannot create stale pictures or PNG-save buttons after switching files', async () => {
  const p = page();
  await open(p, 'A.gel.svg', result('A', { readable: true }));
  const out = p.get('panels').querySelector('.redraw');
  const comparing = button(p.get('panels'), 'Redraw and compare').click();
  const request = p.requests('compare').at(-1);
  await open(p, 'B.gel.svg', result('B only'));
  const createdUrls = p.blobs.size;
  p.worker.reply(request, {
    state: 'same', message: 'stale comparison', differing: 0, notes: [],
    redrawn_png: Uint8Array.of(4), difference_png: Uint8Array.of(5),
  });
  await comparing;
  assert.equal(out.textContent, 'Drawing the picture again…');
  assert.equal(out.querySelector('button'), null);
  assert.equal(p.blobs.size, createdUrls);
  assert.equal(p.downloads.length, 0);
  assert.match(p.get('panels').textContent, /B only/);
  assert.equal(p.pending(), 0);
});

function workerHarness({ delayStartup = false } = {}) {
  const messages = [], calls = [], startup = deferred();
  let currentFile = null;
  const proxy = value => ({ toJs: () => value, destroy() {} });
  const bridge = {
    versions: () => proxy({}),
    open_document: (_bytes, name) => {
      calls.push(['open', name]);
      if (name === 'broken') throw new Error('invalid file');
      currentFile = name;
      return proxy({ file_name: name });
    },
    save: () => { calls.push(['save', currentFile]); return proxy({ file: currentFile }); },
    aligned: () => { calls.push(['aligned', currentFile]); return proxy({ file: currentFile }); },
    compare: () => { calls.push(['compare', currentFile]); return proxy({ file: currentFile }); },
  };
  const pyodide = { loadPackage: async () => {}, FS: { writeFile() {} }, runPython() {},
    pyimport: name => name === 'micropip' ? { install: async () => {} } : bridge };
  const context = vm.createContext({
    URL, Uint8Array, postMessage: m => messages.push(m),
    loadPyodide: () => delayStartup ? startup.promise : Promise.resolve(pyodide),
    fetch: async url => ({ ok: true, text: async () => String(url).endsWith('manifest.json') ? '{"path":"test.whl"}' : '' }),
  });
  const sourcePath = path.join(root, 'js/worker.js');
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/^import .*loadPyodide.*;\s*$/m, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href));
  vm.runInContext(source, context, { filename: sourcePath });
  let requestId = 0;
  return { messages, calls, release: () => startup.resolve(pyodide),
    select: documentId => context.onmessage({ data: { type: 'select', documentId } }),
    request: (type, documentId, extra = {}) => {
      const id = ++requestId;
      const done = context.onmessage({ data: { id, type, documentId, bytes: new ArrayBuffer(1), ...extra } });
      return { id, done, reply: () => messages.find(m => m.id === id) };
    } };
}

test('the worker rejects commands from old files and from a selection not yet opened', async () => {
  const w = workerHarness();
  await w.select(1);
  let request = w.request('open', 1, { name: 'A' }); await request.done;
  assert.equal(request.reply().type, 'done');
  await w.select(2);
  for (const type of ['save', 'aligned', 'compare']) {
    request = w.request(type, 1); await request.done;
    assert.equal(request.reply().type, 'error');
    request = w.request(type, 2); await request.done;
    assert.equal(request.reply().type, 'error');
  }
  assert.deepEqual(w.calls, [['open', 'A']]);
  request = w.request('open', 2, { name: 'B' }); await request.done;
  assert.equal(request.reply().type, 'done');
  request = w.request('open', 1, { name: 'A' }); await request.done;
  assert.equal(request.reply().type, 'error');
  request = w.request('save', 2); await request.done;
  assert.equal(request.reply().result.file, 'B');
  assert.equal(request.reply().documentId, 2);
});

test('a failed open leaves the worker unable to save the previous document under the new ID', async () => {
  const w = workerHarness();
  await w.select(1);
  let request = w.request('open', 1, { name: 'A' }); await request.done;
  await w.select(2);
  request = w.request('open', 2, { name: 'broken' }); await request.done;
  assert.equal(request.reply().type, 'error');
  for (const documentId of [1, 2]) {
    request = w.request('save', documentId); await request.done;
    assert.equal(request.reply().type, 'error');
  }
  assert.deepEqual(w.calls, [['open', 'A'], ['open', 'broken']]);
});

test('the worker rechecks the selection after waiting for Python startup', async () => {
  const w = workerHarness({ delayStartup: true });
  await w.select(1);
  const a = w.request('open', 1, { name: 'A' });
  await w.select(2);
  const b = w.request('open', 2, { name: 'B' });
  w.release();
  await Promise.all([a.done, b.done]);
  assert.equal(a.reply().type, 'error');
  assert.equal(b.reply().type, 'done');
  assert.deepEqual(w.calls, [['open', 'B']]);
});
