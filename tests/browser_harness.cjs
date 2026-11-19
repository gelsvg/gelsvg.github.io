// A browser surface for running the actual page script without a network or
// a DOM package. Messages and file reads are deliberately controlled by tests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tag, downloads) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {} };
    this.hidden = false;
    this.offsetHeight = 0;
    this.downloads = downloads;
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(c => c instanceof Element ? c.textContent : String(c)).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) { child.remove(); child.parentNode = this; }
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const c of this.children) if (c instanceof Element) c.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  async dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) await handler({ target: this, ...event });
  }
  click() {
    if (this.tagName === 'a') this.downloads.push({ name: this.attributes.download, url: this.attributes.href });
    return this.dispatch('click');
  }
  matches(selector) {
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    return this.tagName === selector;
  }
  querySelector(selector) { return descendants(this).find(n => n.matches(selector)) || null; }
  closest(selector) {
    for (let n = this; n; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  contains(node) { return node === this || descendants(this).includes(node); }
}

function descendants(root) {
  return root.children.flatMap(c => c instanceof Element ? [c, ...descendants(c)] : []);
}
function button(root, label) {
  const found = descendants(root).find(n => n.tagName === 'button' && n.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
function file(name, reading = Promise.resolve(new ArrayBuffer(4))) {
  return { name, arrayBuffer: () => reading };
}

function page() {
  const nodes = new Map(), downloads = [], blobs = new Map(), revoked = [], observers = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element('div', downloads));
    return nodes.get(id);
  };
  const body = new Element('body', downloads);
  const figure = new Element('figure', downloads);
  figure.append(get('figure-img'));
  body.append(figure);
  class BrowserURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${blobs.size + 1}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  let worker;
  class Worker {
    constructor() { worker = this; this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    reply(request, result, error) {
      this.onmessage({ data: error
        ? { type: 'error', id: request.id, documentId: request.documentId, text: error }
        : { type: 'done', id: request.id, documentId: request.documentId, result } });
    }
  }
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({
    Worker, URL: BrowserURL, Blob, Uint8Array, Uint16Array, TextEncoder, Node: Element,
    document: { getElementById: get, createElement: tag => new Element(tag, downloads),
      createElementNS: (_ns, tag) => new Element(tag, downloads), body },
    window: { addEventListener() {} }, IntersectionObserver,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, console,
  });
  const sourcePath = path.join(root, 'js/main.js');
  const source = fs.readFileSync(sourcePath, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href));
  vm.runInContext(source, context, { filename: sourcePath });
  return { context, worker, get, downloads, blobs, revoked, observers,
    requests: type => worker.messages.filter(m => m.type === type),
    pending: () => vm.runInContext('pending.size', context) };
}

function result(label, { readable = false, converted = false, views = [] } = {}) {
  const panel = { index: 0, png: Uint8Array.of(1), readable, notices: [], unreadable_reason: label,
    newer_version: false };
  if (readable) Object.assign(panel, {
    checks: { drawn_from: 'ok', rendered_hash: 'ok', svg_hash: 'absent' },
    written_by: { name: label }, schema_version: 1, schema_revision: 0,
    counts: { sources: 1, embedded_source_channels: 1, lanes: 0, rows: 0, bands: 0, markers: 0, quantifications: 0 },
    tables: { views, drawing: [], roi: null, orientation: null, crop: null, output_bit_depth: 8,
      sources: [], quantifications: [], lanes: [], rows: [], bands: [], markers: [], conditions: [],
      annotations: {}, json: JSON.stringify({ name: label }), redrawable: true },
  });
  return { is_document: true, document_notices: [], assemblies: [], panels: [panel],
    converted: converted ? { svg: Uint8Array.of(2), panels: [{ schema_version: 6, notes: [] }] } : null };
}

async function open(page, name, data = result(name)) {
  const opening = page.context.openFile(file(name));
  await tick();
  const request = page.requests('open').at(-1);
  page.worker.reply(request, data);
  await opening;
  return request;
}

module.exports = { root, tick, deferred, Element, descendants, button, file, page, result, open };
