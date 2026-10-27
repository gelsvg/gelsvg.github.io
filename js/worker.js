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
  pyodide.FS.writeFile("/home/pyodide/viewer_bridge.py", await fetchText("../py/viewer_bridge.py"));
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

onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    const bridge = await ready;
    if (type === "open") {
      const result = toPlain(bridge.open_document(new Uint8Array(event.data.bytes), event.data.name));
      postMessage({ type: "opened", id, result });  // copied, never transferred: no buffer may be Python's memory
    }
  } catch (error) {
    postMessage({ type: "error", id, text: String(error && error.message ? error.message : error) });
  }
};
