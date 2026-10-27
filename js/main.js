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
  const card = el("article", { class: "panel" }, thumb, body);
  if (panel.tables) card.append(panelTabs(panel));
  return card;
}

// --- the panel's tabs ------------------------------------------------------------------------

function fmt(value) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(parseFloat(value.toPrecision(6)));
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function table(headers, rows) {
  const head = el("tr", {}, ...headers.map((h) => el("th", { scope: "col", text: h })));
  const body = rows.map((cells) => el("tr", {}, ...cells.map((c) => (c instanceof Node ? el("td", {}, c) : el("td", { text: fmt(c) })))));
  return el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...body)));
}

function empty(text) {
  return el("p", { class: "meta", text });
}

function tabs(items) {
  const bar = el("div", { class: "tabs", role: "tablist" });
  const view = el("div", { class: "tab-panel", role: "tabpanel" });
  const buttons = items.map((item, i) => {
    const button = el("button", { type: "button", class: "tab", role: "tab", "aria-selected": "false", text: item.label });
    button.addEventListener("click", () => select(i));
    return button;
  });
  function select(i) {
    buttons.forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
    view.replaceChildren(items[i].build());
  }
  bar.append(...buttons);
  select(0);
  return el("div", { class: "panel-tabs" }, bar, view);
}

function panelTabs(panel) {
  const t = panel.tables;
  const count = (label, n) => (n ? `${label} (${n})` : label);
  return tabs([
    { label: count("Samples", t.lanes.length), build: () => samplesTab(t) },
    { label: count("Bands", t.bands.length), build: () => bandsTab(t) },
    { label: count("Markers", t.markers.length), build: () => markersTab(t) },
    { label: count("Quantifications", t.quantifications.length), build: () => quantificationsTab(t) },
    { label: count("Sources", t.sources.length), build: () => sourcesTab(t) },
    { label: "JSON", build: () => jsonTab(panel) },
  ]);
}

function samplesTab(t) {
  const out = el("div");
  if (t.annotation) out.append(el("p", { class: "text-block" }, el("strong", { text: "Annotation: " }), t.annotation));
  if (t.note) out.append(el("p", { class: "text-block" }, el("strong", { text: "Note: " }), t.note));
  if (!t.lanes.length) {
    out.append(empty("No lanes."));
    return out;
  }
  const conditions = t.conditions;
  out.append(table(
    ["Lane", "x", "y", ...conditions.map((c, i) => c.name || `Condition ${i + 1}`), "Details"],
    t.lanes.map((lane) => [lane.point ? lane.lane : `${lane.lane} (no point)`, lane.x, lane.y,
      ...conditions.map((c) => lane.values[c.id]), lane.details]),
  ));
  return out;
}

function bandsTab(t) {
  if (!t.bands.length) return empty("No bands.");
  return table(["Row", "Lane", "Shape", "x", "y", "w", "h", "Found by"],
    t.bands.map((b) => [b.row, b.lane, b.shape, b.x, b.y, b.w, b.h,
      b.detection ? `${b.detection.by} (score ${fmt(b.detection.score)})` : null]));
}

function markersTab(t) {
  if (!t.markers.length) return empty("No marker labels.");
  return table(["Label", "Size", "x", "y"],
    t.markers.map((m) => [m.label, m.size ? `${fmt(m.size.value)} ${m.size.unit}` : null, m.x, m.y]));
}

const STALE = {
  current: ["ok", "Measured on this data"],
  stale: ["differs", "Out of date: the data changed after it was measured"],
  unknown: ["unknown", "Cannot tell whether it is out of date"],
};

function quantificationsTab(t) {
  if (!t.quantifications.length) return empty("No quantifications.");
  const out = el("div");
  t.quantifications.forEach((q, i) => {
    const [state, words] = STALE[q.stale];
    const parts = [`${q.mode} mode`, `${q.method.name} (${q.method.by})`, q.channel ? `on ${q.channel}` : null,
      q.inverted ? "values inverted" : null].filter(Boolean);
    out.append(el("h5", { class: "q-title", text: `Quantification ${i + 1}: ${parts.join(" · ")}` }),
      el("ul", { class: "checks" }, el("li", { class: state, text: words })));
    if (q.method.parameters) out.append(el("p", { class: "meta", text: `Parameters: ${JSON.stringify(q.method.parameters)}` }));
    const band = q.mode === "band";
    out.append(table(["Lane", ...(band ? ["Row"] : []), "Raw", "Signal", "Background", "Peak", "Region (x, y, w, h)"],
      q.values.map((v) => [v.lane, ...(band ? [v.row] : []), v.raw, v.signal, v.background, v.peak,
        v.region ? [v.region.x, v.region.y, v.region.w, v.region.h].map(fmt).join(", ") : null])));
  });
  return out;
}

function sourcesTab(t) {
  if (!t.sources.length) return empty("No source images.");
  const out = el("div");
  for (const s of t.sources) {
    const facts = [
      ["File", s.file_name || "(no name recorded)"],
      ["File hash", s.file_hash ? el("code", { class: "hash", text: s.file_hash }) : "(not recorded)"],
      ["Pixels", s.dtype && s.shape ? `${s.shape[1]} × ${s.shape[0]}, ${s.dtype}` : "(not recorded)"],
      ["Channels", s.channels.map((c) => `${c.name}${c.embedded ? " (embedded)" : c.pixel_hash ? " (not embedded)" : " (pixels never read)"}`).join(", ")],
      ["Used as", s.uses.join(", ") || "—"],
    ];
    const list = el("dl", { class: "facts" });
    for (const [term, value] of facts) list.append(el("dt", { text: term }), el("dd", {}, value));
    out.append(el("h5", { class: "q-title", text: `Source image ${s.id}` }), list);
    if (s.metadata) {
      const m = s.metadata;
      out.append(el("p", { class: "meta", text: `Metadata: ${m.format} (version ${m.version}), ${m.byte_length} bytes`
        + (m.readable ? "" : " — kept as it is, but not in a form this viewer reads") }));
      if (m.rows) out.append(table(["Where", "Name", "Value"], m.rows.map((r) => [r.where, r.name, r.value])));
    } else {
      out.append(empty("No metadata from the source file."));
    }
  }
  return out;
}

function jsonTab(panel) {
  const save = el("button", { type: "button", text: "Save the JSON" });
  save.addEventListener("click", () => download(new TextEncoder().encode(panel.tables.json),
    `panel-${panel.index + 1}.json`, "application/json"));
  return el("div", {}, el("p", { class: "meta", text: "The panel's JSON, as it is written in the file." }),
    el("pre", { class: "json", text: panel.tables.json }), el("p", {}, save));
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
