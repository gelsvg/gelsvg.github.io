// The page: opening a file, showing the figure at once, and filling in what
// the gelsvg library found once Python is ready. Every string from a file
// is put on the page as text, never as HTML.

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const $ = (id) => document.getElementById(id);
const pending = new Map();
let nextId = 1;
let urls = [];

const KINDS = [
  ["UNREADABLE", "Unreadable"],
  ["DAMAGED", "Damaged after it was written"],
  ["BROKEN", "Written wrongly"],
  ["UNKNOWN", "Not known to this reader"],
  ["UNHANDLED", "Not handled"],
  ["REINTERPRETED", "Read differently"],
  ["ASSEMBLY", "Assembly"],
];

const CHECKS = {
  drawn_from: {
    ok: "Figure matches the data",
    differs: "Figure is older than the data",
    unknown: "Cannot tell whether the figure matches the data",
    title: "Whether the data changed after the figure was drawn (drawn_from).",
  },
  rendered_hash: {
    ok: "Picture unchanged since drawn",
    differs: "Picture changed after it was drawn",
    unknown: "Cannot check the picture",
    title: "Whether the panel's picture was changed after it was drawn (rendered_hash).",
  },
  svg_hash: {
    ok: "SVG as its writer left it",
    differs: "SVG changed since this panel was written",
    unknown: "Cannot check the SVG",
    absent: "No SVG hash recorded",
    title: "Whether the figure's SVG is as the writer of this panel left it (svg_hash). Moving a panel into another figure also changes it.",
  },
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function blobUrl(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  urls.push(url);
  return url;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- the engine ------------------------------------------------------------------------------

worker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "progress") {
    $("engine-progress").value = message.step;
    $("engine-text").textContent = message.text;
  } else if (message.type === "ready") {
    $("engine").classList.add("ready");
    $("engine-text").textContent = "Ready.";
    const v = message.versions;
    $("versions").textContent =
      `Viewer ${v.viewer} · gelsvg ${v.gelsvg} · Python ${v.python} · numpy ${v.numpy} · Pillow ${v.pillow}`;
  } else if (message.type === "failed") {
    $("engine").classList.add("failed");
    $("engine-text").textContent = `Python could not be started: ${message.text}`;
    for (const { reject } of pending.values()) reject(new Error(message.text));
    pending.clear();
  } else if (message.type === "opened" || message.type === "error") {
    const job = pending.get(message.id);
    pending.delete(message.id);
    if (!job) return;
    if (message.type === "opened") job.resolve(message.result);
    else job.reject(new Error(message.text));
  }
};

function ask(type, payload, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

// --- opening a file --------------------------------------------------------------------------

async function openFile(file) {
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
  const bytes = new Uint8Array(await file.arrayBuffer());
  $("document").hidden = false;
  $("doc-title").textContent = file.name;
  $("doc-banners").replaceChildren();
  $("doc-notices").replaceChildren();
  $("panels").replaceChildren();
  $("panels-title").hidden = true;
  $("figure-img").src = blobUrl(bytes, "image/svg+xml");
  $("doc-status").replaceChildren(el("p", { class: "meta", text: "Reading the data in the file…" }));

  try {
    const copy = bytes.slice();  // the page keeps `bytes` for the figure
    const result = await ask("open", { bytes: copy.buffer, name: file.name }, [copy.buffer]);
    showResult(result, file.name);
  } catch (error) {
    $("doc-status").replaceChildren(el("div", { class: "banner bad" },
      el("p", { text: `The file could not be read: ${error.message}` })));
  }
}

function showResult(result, fileName) {
  $("doc-status").replaceChildren();
  const banners = $("doc-banners");

  if (result.converted) {
    const versions = [...new Set(result.converted.panels.map((p) => p.schema_version))].join(", ");
    const notes = result.converted.panels.flatMap((p) => p.notes);
    const save = el("button", { type: "button", text: "Save as .gel.svg" });
    save.addEventListener("click", () => download(result.converted.svg, gelName(fileName), "image/svg+xml"));
    banners.append(el("div", { class: "banner warn" },
      el("p", { text: `This is an old MyWB document (schema ${versions}). It was converted to GelSVG to be shown here; the file itself was not changed.` }),
      notes.length ? el("ul", {}, ...notes.map((n) => el("li", { text: n }))) : null,
      el("p", {}, save)));
    $("figure-img").src = blobUrl(result.converted.svg, "image/svg+xml");
  }
  if (result.conversion_error) {
    banners.append(el("div", { class: "banner bad" },
      el("p", { text: `An old MyWB document in this file could not be converted: ${result.conversion_error}` })));
  }
  if (!result.is_document) {
    const reason = result.document_notices.find((n) => n.kind === "UNREADABLE");
    banners.append(el("div", { class: "banner bad" },
      el("p", { text: reason ? reason.message : "This file is not a GelSVG document." })));
  }

  const docNotices = result.document_notices.filter((n) => result.is_document || n.kind !== "UNREADABLE");
  if (docNotices.length) $("doc-notices").append(noticeList(docNotices, "About the document"));
  if (result.assemblies.length) {
    $("doc-notices").append(el("p", { class: "meta",
      text: `${plural(result.assemblies.length, "assembly")}: ` + result.assemblies.map((a) =>
        `${Object.keys(a.panels).length} of ${a.members} panels${a.missing.length ? " (some missing)" : ""}`).join("; ") }));
  }
  if (result.panels.length) {
    $("panels-title").hidden = false;
    $("panels-title").textContent = plural(result.panels.length, "panel");
    $("panels").append(...result.panels.map(panelCard));
  }
}

function gelName(name) {
  return name.replace(/(\.mywb|\.my_wb)?\.svg$/i, "") + ".gel.svg";
}

function download(bytes, name, type) {
  const link = el("a", { href: blobUrl(bytes, type), download: name });
  document.body.append(link);
  link.click();
  link.remove();
}

// --- panels ----------------------------------------------------------------------------------

function panelCard(panel) {
  const body = el("div");
  const title = el("h4", { text: `Panel ${panel.index + 1}` });
  if (panel.assembly) title.append(el("small", { text: `member ${panel.assembly.member} of ${panel.assembly.members}` }));
  body.append(title);

  if (!panel.readable) {
    const text = panel.newer_version
      ? "Written in a newer version of the GelSVG format; this viewer does not read it."
      : `This panel cannot be read: ${panel.unreadable_reason}.`;
    body.append(el("div", { class: "banner " + (panel.newer_version ? "warn" : "bad") }, el("p", { text })));
  } else {
    body.append(el("ul", { class: "checks" }, ...Object.entries(CHECKS).map(([name, words]) => {
      const state = panel.checks[name];
      return el("li", { class: state, title: words.title, text: words[state] });
    })));
    const meta = [];
    if (panel.written_by) meta.push(`Written by ${[panel.written_by.name, panel.written_by.version].filter(Boolean).join(" ")}`);
    if (panel.saved_at) meta.push(`saved ${panel.saved_at}`);
    meta.push(`format ${panel.schema_version}.${panel.schema_revision ?? "?"}`);
    body.append(el("p", { class: "meta", text: meta.join(" · ") }));
    const c = panel.counts;
    body.append(el("p", { class: "counts", text: [
      plural(c.sources, "source image"), `${c.embedded_channels} embedded`, plural(c.lanes, "lane"),
      plural(c.rows, "row"), plural(c.bands, "band"), plural(c.markers, "marker label"),
      plural(c.quantifications, "quantification")].join(" · ") }));
    if (panel.newer_revision) {
      body.append(el("p", { class: "meta", text: "Written by a newer revision of the format: some of it may not be shown." }));
    }
  }
  if (panel.notices.length) body.append(noticeList(panel.notices, null));

  const thumb = el("img", { class: "thumb", src: blobUrl(panel.png, "image/png"), alt: `Panel ${panel.index + 1}'s picture` });
  return el("article", { class: "panel" }, thumb, body);
}

function noticeList(notices, heading) {
  const details = el("details");
  details.append(el("summary", { text: heading ? `${heading}: ${plural(notices.length, "note")}` : plural(notices.length, "note") }));
  for (const [kind, label] of KINDS) {
    const group = notices.filter((n) => n.kind === kind);
    if (!group.length) continue;
    details.append(el("div", { class: `notice-group kind-${kind}` },
      el("h5", { text: `${label} (${group.length})` }),
      el("ul", {}, ...group.map((n) => el("li", {}, n.message, n.where ? " " : null,
        n.where ? el("span", { class: "where", text: n.where }) : null)))));
  }
  if (notices.some((n) => n.kind === "UNREADABLE" || n.kind === "DAMAGED" || n.kind === "BROKEN")) details.open = true;
  return details;
}

// --- dropping and choosing -------------------------------------------------------------------

$("figure-img").addEventListener("error", () => { $("figure-img").closest("figure").hidden = true; });
$("figure-img").addEventListener("load", () => { $("figure-img").closest("figure").hidden = false; });

$("file").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) openFile(file);
  event.target.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    $("drop").classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === "drop" || event.target === document.documentElement) $("drop").classList.remove("over");
  });
}
window.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) openFile(file);
});
