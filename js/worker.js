// Runs Python (Pyodide) and the gelsvg library away from the page, so the
// page stays responsive while a large file is read. Files never leave the
// browser: the only network requests fetch Pyodide and its packages.

import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const STEPS = 4;

function progress(step, text) {
  postMessage({ type: "progress", step, of: STEPS, text });
}

async function fetchText(path) {
  const response = await fetch(new URL(path, import.meta.url), { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
  return response.text();
}

async function start() {
  progress(1, "Loading Python…");
  const pyodide = await loadPyodide({ indexURL: INDEX_URL });

  progress(2, "Loading numpy and Pillow…");
  await pyodide.loadPackage("micropip");
  const manifest = JSON.parse(await fetchText("../wheels/manifest.json"));
  const micropip = pyodide.pyimport("micropip");

  progress(3, "Loading the GelSVG library…");
  await micropip.install(new URL(`../wheels/${manifest.path}`, import.meta.url).href);
  for (const name of ["viewer_metadata.py", "viewer_bridge.py"]) {
    pyodide.FS.writeFile(`/home/pyodide/${name}`, await fetchText(`../py/${name}`));
  }
  pyodide.runPython("import sys\nif '/home/pyodide' not in sys.path: sys.path.insert(0, '/home/pyodide')");
  const bridge = pyodide.pyimport("viewer_bridge");

  progress(4, "Ready.");
  postMessage({ type: "ready", versions: toPlain(bridge.versions()) });
  return bridge;
}

// Python dicts become objects, bytes become Uint8Arrays; the proxies are
// released so nothing leaks between files.
function toPlain(proxy) {
  const value = proxy.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
  proxy.destroy();
  return value;
}

const ready = start();
ready.catch((error) => postMessage({ type: "failed", text: String(error && error.message ? error.message : error) }));

// A selection arrives before the page starts reading the file's bytes.
// Keep it separate from the successfully opened document: a failed open
// must never leave the previous file available under a new selection.
let selectedDocumentId = 0;
let activeDocumentId = null;

onmessage = async (event) => {
  const { id, type, documentId } = event.data;
  if (type === "select") {
    if (Number.isSafeInteger(documentId) && documentId > selectedDocumentId) {
      selectedDocumentId = documentId;
      activeDocumentId = null;
    }
    return;
  }
  try {
    const requireSelected = () => {
      if (!selectedDocumentId || documentId !== selectedDocumentId) throw new Error("This file is no longer open.");
    };
    requireSelected();
    const bridge = await ready;
    requireSelected();  // another file may have been selected while Python started
    let result;
    if (type === "open") {
      activeDocumentId = null;
      result = toPlain(bridge.open_document(new Uint8Array(event.data.bytes), event.data.name));
      activeDocumentId = documentId;
    } else {
      if (documentId !== activeDocumentId) throw new Error("This file has not been opened successfully.");
      if (type === "aligned") result = toPlain(bridge.aligned(event.data.panel, event.data.element));
      else if (type === "save") result = toPlain(bridge.save(event.data.panel, event.data.what, event.data.element ?? null));
      else if (type === "compare") result = toPlain(bridge.compare(event.data.panel));
      else throw new Error(`Unknown request ${type}.`);
    }
    postMessage({ type: "done", id, documentId, result });  // copied, never transferred: no buffer may be Python's memory
  } catch (error) {
    postMessage({ type: "error", id, documentId, text: String(error && error.message ? error.message : error) });
  }
};
