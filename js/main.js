// The page: opening a file, showing the figure at once, and filling in what
// the gelsvg library found once Python is ready. Every string from a file
// is put on the page as text, never as HTML.

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const $ = (id) => document.getElementById(id);
const pending = new Map();
let nextId = 1;
let urls = [];
let baseName = "gelsvg";

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
  } else if (message.type === "done" || message.type === "error") {
    const job = pending.get(message.id);
    pending.delete(message.id);
    if (!job) return;
    if (message.type === "done") job.resolve(message.result);
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
  baseName = file.name.replace(/(\.gel|\.mywb|\.my_wb)?\.svg$/i, "") || "gelsvg";
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
  const side = el("div", { class: "thumb-side" }, thumb);
  if (panel.readable) side.append(el("p", { class: "saves" }, saveFromPython("Save the picture", { panel: panel.index, what: "picture" })));
  const card = el("article", { class: "panel" }, side, body);
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

// Each tab is built when first opened and then kept, so going back to it
// does not lay it out again; and the tab area keeps the height of the
// tallest tab opened, so switching never moves the page under the reader.
function tabs(items, level = "main") {
  const bar = el("div", { class: `tabs ${level}`, role: "tablist" });
  const view = el("div", { class: "tab-panel", role: "tabpanel" });
  const panes = items.map(() => null);
  let tallest = 0;
  const buttons = items.map((item, i) => {
    const button = el("button", { type: "button", class: "tab", role: "tab", "aria-selected": "false", text: item.label });
    button.addEventListener("click", () => select(i));
    return button;
  });
  function select(i) {
    tallest = Math.max(tallest, view.offsetHeight);
    view.style.minHeight = `${tallest}px`;
    buttons.forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
    if (!panes[i]) {
      panes[i] = el("div", { class: "tab-pane" }, items[i].build());
      view.append(panes[i]);
    }
    panes.forEach((pane, j) => { if (pane) pane.hidden = j !== i; });
  }
  bar.append(...buttons);
  select(0);
  return el("div", { class: "panel-tabs" }, bar, view);
}

function panelTabs(panel) {
  const t = panel.tables;
  const count = (label, n) => (n ? `${label} (${n})` : label);
  const marker = t.views.filter((v) => v.element === "marker");
  const blot = t.views.filter((v) => v.element !== "marker");
  const images = [...marker, ...blot].map((view) => ({
    label: view.element === "marker" ? "Marker image" : blot.length > 1 ? `Blot image ${view.element + 1}` : "Blot image",
    build: () => imageView(panel, view, blot.length),
  }));
  return tabs([
    { label: "Images", build: () => tabs([
      ...images,
      ...(t.redrawable ? [{ label: "Redraw", build: () => redrawTab(panel) }] : []),
      { label: "ROI and orientation", build: () => roiTab(t) },
    ], "sub") },
    { label: "Labels and bands", build: () => labelsAndBands(t) },
    { label: count("Quantifications", t.quantifications.length), build: () => quantificationsTab(t) },
    { label: "File", build: () => tabs([
      { label: count("Source files", t.sources.length), build: () => sourcesTab(t) },
      { label: "JSON", build: () => jsonTab(panel) },
    ], "sub") },
  ]);
}

function facts(pairs) {
  const list = el("dl", { class: "facts" });
  for (const [term, value] of pairs) list.append(el("dt", { text: term }), el("dd", {}, value));
  return list;
}

function roiTab(t) {
  const out = el("div");
  const blots = t.drawing.filter((d) => d.kind === "blot").length;
  out.append(el("h5", { class: "q-title", text: "ROI" }), t.roi
    ? facts([["Left, top", `${fmt(t.roi.x)}, ${fmt(t.roi.y)}`], ["Width × height", `${fmt(t.roi.w)} × ${fmt(t.roi.h)}`]])
    : empty("No ROI: the whole aligned image is the figure."));
  const o = t.orientation;
  out.append(el("h5", { class: "q-title", text: "Orientation" }), o
    ? facts([
      ["Quarter turn", o.turn ? `${o.turn}° clockwise` : "none"],
      ["Flip", o.flip ? "left to right" : "none"],
      ["Fine rotation", o.rotation ? `${fmt(Math.abs(o.rotation))}° ${o.rotation > 0 ? "clockwise" : "anticlockwise"}` : "none"],
      ["In this order", "turned, then flipped, then rotated (GelSVG §4.2)"],
    ])
    : empty("The orientation cannot be read."));
  const size = t.views.find((v) => v.size)?.size;
  const crop = t.crop;
  const isRoi = crop && t.roi && ["x", "y", "w", "h"].every((k) => crop[k] === t.roi[k]);
  out.append(el("h5", { class: "q-title", text: "Picture" }), facts([
    ["Aligned image", size ? `${size[1]} × ${size[0]} pixels` : "not known"],
    ["Picture's range", crop ? `${fmt(crop.x)}, ${fmt(crop.y)}, ${fmt(crop.w)} × ${fmt(crop.h)}${isRoi ? " (the ROI)" : ""}` : "not known"],
    ["Bit depth", t.output_bit_depth ? `${t.output_bit_depth}-bit` : "not known"],
  ]));
  const name = (d) => d.kind === "marker" ? "Marker image"
    : blots > 1 ? `Blot image ${d.index + 1}${d.index === 0 ? " (reference)" : ""}` : "Blot image";
  const colour = (c) => {
    if (!c) return "grey";
    const swatch = el("span", { class: "swatch" });
    swatch.style.setProperty("background", `rgb(${c.map((v) => Math.round(v * 255)).join(", ")})`);
    return el("span", {}, swatch, ` ${c.map(fmt).join(", ")}`);
  };
  const lined = (d) => d.turn === null || d.turn === undefined ? "the reference channel"
    : `${d.turn ? `${d.turn}° clockwise` : "no turn"}${d.flip ? ", flipped" : ""}, then sized to the reference channel`;
  out.append(el("h5", { class: "q-title", text: "How each image is drawn" }),
    table(["Image", "Channel", "Source file", "Black, white at", "Inverted", "Colour", "Lined up as"],
      t.drawing.map((d) => [name(d), d.channel, d.file_name, `${fmt(d.contrast[0])}, ${fmt(d.contrast[1])}`, d.invert,
        colour(d.color), lined(d)])));
  return out;
}

// --- labels and bands ------------------------------------------------------------------------

// What is "in the ROI", the same way for the band table and the lists: a
// band whose centre is in it; a lane with a band in it, or with no bands and
// its point within the ROI across (sample labels sit above or below it); a
// marker label within the ROI's height (they sit beside it).
function roiFilters(t) {
  const roi = t.roi;
  const centre = (b) => (b.shape === "rect" ? [b.x + b.w / 2, b.y + b.h / 2] : [b.x, b.y]);
  const band = (b) => {
    if (!roi) return true;
    const [x, y] = centre(b);
    return roi.x <= x && x <= roi.x + roi.w && roi.y <= y && y <= roi.y + roi.h;
  };
  const lane = (l) => {
    if (!roi) return true;
    const own = t.bands.filter((b) => b.lane_id === l.id);
    return own.length ? own.some(band) : l.point && roi.x <= l.x && l.x <= roi.x + roi.w;
  };
  const row = (r) => {
    if (!roi) return true;
    const own = t.bands.filter((b) => b.row_id === r.id);
    return !own.length || own.some(band);
  };
  const marker = (m) => !roi || (roi.y <= m.y && m.y <= roi.y + roi.h);
  return { centre, band, lane, row, marker };
}

function labelsAndBands(t) {
  const filters = roiFilters(t);
  const state = { only: Boolean(t.roi) };
  const renderers = [];
  const live = (render) => {
    const box = el("div");
    const draw = () => box.replaceChildren(render(state.only, filters));
    renderers.push(draw);
    draw();
    return box;
  };
  const box = el("input", { type: "checkbox" });
  box.checked = state.only;
  box.disabled = !t.roi;
  box.addEventListener("change", () => { state.only = box.checked; renderers.forEach((draw) => draw()); });
  const hint = t.roi
    ? "When ticked: bands whose centre is in the ROI, the lanes they are in (or whose sample label is above or below the ROI), and marker labels beside it. Bands outside the ROI are grey in the table either way."
    : "This panel has no ROI, so everything is shown.";
  return el("div", {},
    el("p", { class: "toggles" }, el("label", {}, box, " Only what is in the ROI")),
    el("p", { class: "meta", text: hint }),
    live((only) => bandTable(t, only, filters)),
    tabs([
      { label: "Bands", build: () => live((only) => bandsList(t, only, filters)) },
      { label: "Sample labels", build: () => live((only) => samplesList(t, only, filters)) },
      { label: "Marker labels", build: () => live((only) => markersList(t, only, filters)) },
    ], "sub"));
}

function shown(kept, all, noun) {
  return el("p", { class: "meta", text: kept === all ? plural(all, noun) : `${kept} of ${plural(all, noun)}, those in the ROI` });
}

function samplesList(t, only, f) {
  const out = el("div");
  if (t.annotation) out.append(el("p", { class: "text-block" }, el("strong", { text: "Annotation: " }), t.annotation));
  if (t.note) out.append(el("p", { class: "text-block" }, el("strong", { text: "Note: " }), t.note));
  if (!t.lanes.length) {
    out.append(empty("No lanes."));
    return out;
  }
  const lanes = only ? t.lanes.filter(f.lane) : t.lanes;
  const conditions = t.conditions;
  out.append(shown(lanes.length, t.lanes.length, "lane"), table(
    ["Lane", "x", "y", ...conditions.map((c, i) => c.name || `Condition ${i + 1}`), "Details"],
    lanes.map((lane) => [lane.point ? lane.lane : `${lane.lane} (no point)`, lane.x, lane.y,
      ...conditions.map((c) => lane.values[c.id]), lane.details]),
  ));
  return out;
}

function bandsList(t, only, f) {
  if (!t.bands.length) return empty("No bands.");
  const bands = only ? t.bands.filter(f.band) : t.bands;
  return el("div", {}, shown(bands.length, t.bands.length, "band"),
    table(["Row", "Lane", "Shape", "x", "y", "w", "h", "Found by"],
      bands.map((b) => [b.row, b.lane, b.shape, b.x, b.y, b.w, b.h,
        b.detection ? `${b.detection.by} (score ${fmt(b.detection.score)})` : null])));
}

function markersList(t, only, f) {
  if (!t.markers.length) return empty("No marker labels.");
  const markers = only ? t.markers.filter(f.marker) : t.markers;
  return el("div", {}, shown(markers.length, t.markers.length, "marker label"),
    table(["Label", "Size", "x", "y"],
      markers.map((m) => [m.label, m.size ? `${fmt(m.size.value)} ${m.size.unit}` : null, m.x, m.y])));
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

// A file is opened when it is dropped on the drop area, and nowhere else.
// Dropped anywhere else it is not opened, nor does the browser open it in
// place of the page.
const dropArea = $("drop");
for (const type of ["dragenter", "dragover"]) {
  dropArea.addEventListener(type, (event) => {
    event.preventDefault();
    dropArea.classList.add("over");
  });
}
dropArea.addEventListener("dragleave", (event) => {
  if (!dropArea.contains(event.relatedTarget)) dropArea.classList.remove("over");
});
dropArea.addEventListener("drop", (event) => {
  event.preventDefault();
  dropArea.classList.remove("over");
  const [file] = event.dataTransfer.files;
  if (file) openFile(file);
});
const carriesFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
window.addEventListener("dragover", (event) => {
  if (carriesFiles(event) && !dropArea.contains(event.target)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  }
});
window.addEventListener("drop", (event) => {
  if (carriesFiles(event) && !dropArea.contains(event.target)) event.preventDefault();
});

// --- the image tabs --------------------------------------------------------------------------

// MyWB's colours for the same marks (its canvas).
const SVG_NS = "http://www.w3.org/2000/svg";
const overlays = { markers: true, bands: true, boxes: false, lanes: true, roi: true, crop: false };
// The switches are the legend too, as in MyWB's Auto Detect: each mark's
// shape and colour beside its name. Marker labels and bands share a colour
// and are told apart by shape, as there.
const OVERLAYS = [
  ["markers", "□", "Marker labels", "marker"],
  ["bands", "●", "Bands", "band"],
  ["boxes", "▭", "Band boxes", "band"],
  ["lanes", "□", "Sample labels", "lane"],
  ["roi", "▭", "ROI", "roi"],
  ["crop", "┅", "Picture's range", "crop"],
];
const OVERLAY_INFO = [
  ["Marker labels", "Each ladder band a marker label marks, with its text (\"50 kDa\"…) on the side away from the ROI."],
  ["Bands", "The centre of each band. Bands and marker labels share a colour; bands are dots, marker labels squares."],
  ["Band boxes", "The box of each band measured as a box. Bands placed as points have none."],
  ["Sample labels", "The point of each lane's sample label, with its lane number on the side away from the ROI."],
  ["ROI", "The rectangle the figure is made of."],
  ["Picture's range", "The part of this image the panel's picture shows (figure.crop in the file). It is usually the ROI, cut to the image, and drawn over it; it differs when the ROI was moved after the picture was drawn, or when the picture is of the whole image."],
  ["Contrast", "Black at and White at say which values (after inversion) are drawn black and white. They change only this view; The panel's contrast goes back to what the file records."],
  ["Coordinates", "This is the aligned image: the source image turned, flipped and rotated as the panel says. Every mark is in its coordinates, which are the panel's."],
];

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function saveFromPython(text, request) {
  const button = el("button", { type: "button", text });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const file = await ask("save", request);
      download(file.bytes, `${baseName}-${file.name}`, "image/png");
    } catch (error) {
      button.title = `Could not save: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

// The marks over an aligned image of `width` × `height`, in the panel's
// coordinates, with room around it for labels that sit outside.
function overlay(t, width, height, margin) {
  const svg = svgEl("svg", { class: "overlay", viewBox: `${-margin} ${-margin} ${width + 2 * margin} ${height + 2 * margin}`,
    preserveAspectRatio: "none" });
  const unit = Math.max(width, height) / 120;
  const centre = t.roi ? [t.roi.x + t.roi.w / 2, t.roi.y + t.roi.h / 2] : [width / 2, height / 2];
  const square = (x, y, cls) => svgEl("rect", { x: x - unit * 0.8, y: y - unit * 0.8, width: unit * 1.6, height: unit * 1.6, class: cls });
  const text = (x, y, words, anchor, cls) => {
    const node = svgEl("text", { x, y, "font-size": unit * 1.9, "text-anchor": anchor, class: cls });
    node.textContent = words;
    return node;
  };
  if (overlays.roi && t.roi) svg.append(svgEl("rect", { x: t.roi.x, y: t.roi.y, width: t.roi.w, height: t.roi.h, class: "ov-roi" }));
  // Over the ROI, dashed: where the two coincide both still show.
  if (overlays.crop && t.crop) svg.append(svgEl("rect", { x: t.crop.x, y: t.crop.y, width: t.crop.w, height: t.crop.h, class: "ov-crop" }));
  if (overlays.boxes) {
    for (const b of t.bands) {
      if (b.shape === "rect") svg.append(svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, class: "ov-band" }));
    }
  }
  if (overlays.bands) {
    for (const b of t.bands) {
      const [x, y] = b.shape === "rect" ? [b.x + b.w / 2, b.y + b.h / 2] : [b.x, b.y];
      svg.append(svgEl("circle", { cx: x, cy: y, r: unit * 0.8, class: "ov-band-dot" }));
    }
  }
  if (overlays.lanes) {
    for (const lane of t.lanes) {
      if (!lane.point) continue;
      const above = lane.y <= centre[1];  // the side away from the ROI
      svg.append(square(lane.x, lane.y, "ov-lane"),
        text(lane.x, above ? lane.y - unit * 1.6 : lane.y + unit * 3.2, lane.lane, "middle", "ov-lane-text"));
    }
  }
  if (overlays.markers) {
    for (const m of t.markers) {
      const left = m.x <= centre[0];
      svg.append(square(m.x, m.y, "ov-marker"),
        text(left ? m.x - unit * 1.6 : m.x + unit * 1.6, m.y + unit * 0.65, m.label, left ? "end" : "start", "ov-marker-text"));
    }
  }
  return svg;
}

function paint(canvas, image, lo, hi, invert) {
  const [h, w] = image.shape;
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  const frame = context.createImageData(w, h);
  const out = frame.data;
  const values = image.values;
  const top = image.dtype === "uint16" ? 65535 : 255;
  const span = hi - lo;
  for (let i = 0, j = 0; i < values.length; i++, j += 4) {
    let v = values[i];
    if (invert) v = top - v;
    let n = span === 0 ? (v > lo ? 1 : 0) : (v - lo) / span;  // §4.5
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    out[j] = out[j + 1] = out[j + 2] = Math.floor(n * 255);
    out[j + 3] = 255;
  }
  context.putImageData(frame, 0, 0);
}

function imageView(panel, view, blotCount) {
  const t = panel.tables;
  const root = el("div", { class: "image-tab" });
  const what = view.element === "marker" ? "The marker image" : blotCount > 1
    ? `Blot image ${view.element + 1}${view.element === 0 ? " (the reference channel)" : ""}` : "The blot image";
  root.append(el("p", { class: "meta", text:
    `${what}: channel ${view.channel}${view.file_name ? ` of ${view.file_name}` : ""}, turned and resized the way the panel lines it up.` }));
  if (!view.available) {
    root.append(el("div", { class: "banner" }, el("p", { text:
      "Its pixels are not embedded in the file, so it cannot be shown here. The panel's own picture is beside its card." })));
    return root;
  }
  const status = el("p", { class: "meta", role: "status", text: "Working out the aligned image… large images can take a few seconds." });
  const stage = el("div", { class: "stage" });
  const controls = el("div", { class: "contrast" });
  const toggles = el("div", { class: "legend" });
  const saves = el("div", { class: "saves" });
  const info = el("details", { class: "info" }, el("summary", { title: "What this view shows", "aria-label": "What this view shows", text: "i" }),
    el("dl", { class: "info-body" }, ...OVERLAY_INFO.flatMap(([term, text]) => [el("dt", { text: term }), el("dd", { text })])));
  const side = el("div", { class: "image-side" },
    el("div", { class: "side-head" }, el("span", { class: "side-title", text: "Marks" }), info), toggles,
    el("div", { class: "side-head" }, el("span", { class: "side-title", text: "Contrast" })), controls, status, saves);
  root.append(el("div", { class: "image-grid" }, el("div", { class: "stage-wrap" }, stage), side));
  let image = null;
  const frame = (w, h) => {
    const margin = Math.round(Math.max(w, h) / 120 * 8);  // room for labels outside the image
    stage.dataset.margin = margin;
    stage.style.setProperty("--pad", `${(100 * margin) / (w + 2 * margin)}%`);  // % of the width, on every side
  };
  if (view.size) {
    // The image's own shape from the start, so nothing moves when it comes.
    const [h, w] = view.size;
    frame(w, h);
    const keep = el("div", { class: "placeholder" });
    keep.style.setProperty("aspect-ratio", `${w} / ${h}`);
    stage.append(keep);
  }

  const redrawOverlay = () => {
    stage.querySelector(".overlay")?.remove();
    if (image) stage.append(overlay(t, image.shape[1], image.shape[0], stage.dataset.margin * 1));
  };
  for (const [key, glyph, label, kind] of OVERLAYS) {
    if (key === "boxes" && !t.bands.some((b) => b.shape === "rect")) continue;
    if ((key === "roi" && !t.roi) || (key === "crop" && !t.crop)) continue;
    const box = el("input", { type: "checkbox" });
    box.checked = overlays[key];
    box.addEventListener("change", () => { overlays[key] = box.checked; redrawOverlay(); });
    toggles.append(el("label", {}, box, el("span", { class: `glyph mark-${kind}`, text: glyph }), el("span", { class: `mark-${kind}`, text: label })));
  }

  async function load() {
    let data;
    try {
      data = await ask("aligned", { panel: panel.index, element: view.element });
    } catch (error) {
      status.textContent = `The aligned image could not be made: ${error.message}`;
      return;
    }
    const bytes = data.pixels.byteOffset % 2 ? data.pixels.slice() : data.pixels;
    const values = data.dtype === "uint16" ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2) : bytes;
    image = { shape: data.shape, dtype: data.dtype, values };
    const [h, w] = data.shape;
    frame(w, h);
    const canvas = el("canvas", { class: "channel" });
    stage.replaceChildren(canvas);
    status.textContent = `${w} × ${h} pixels, ${data.dtype}. Contrast and inversion here change only this view.`;
    buildContrast(canvas, data.dtype);
    redrawOverlay();
    if (view.saveable) saves.append(saveFromPython("Save the channel image", { panel: panel.index, what: "channel", element: view.element }));
    saves.append(saveFromPython("Save the aligned image", { panel: panel.index, what: "aligned", element: view.element }));
  }

  function buildContrast(canvas, dtype) {
    const top = dtype === "uint16" ? 65535 : 255;
    const state = { lo: view.contrast[0], hi: view.contrast[1], invert: view.invert };
    let queued = false;
    const repaint = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; paint(canvas, image, state.lo, state.hi, state.invert); });
    };
    const slider = (key) => {
      const range = el("input", { type: "range", min: Math.min(0, state[key]), max: Math.max(top, state[key]), step: 1 });
      const number = el("input", { type: "number", step: 1, class: "num" });
      const sync = () => { range.value = state[key]; number.value = state[key]; };
      const set = (value) => {
        state[key] = Math.round(Number(value));
        if (state.lo > state.hi) state[key === "lo" ? "hi" : "lo"] = state[key];
        lo.sync(); hi.sync(); repaint();
      };
      range.addEventListener("input", () => set(range.value));
      number.addEventListener("change", () => set(number.value));
      return { node: el("label", {}, el("span", { text: key === "lo" ? "Black at" : "White at" }), number, range), sync };
    };
    const lo = slider("lo");
    const hi = slider("hi");
    const invert = el("input", { type: "checkbox" });
    invert.checked = state.invert;
    invert.addEventListener("change", () => { state.invert = invert.checked; repaint(); });
    const reset = el("button", { type: "button", text: "The panel's contrast" });
    reset.addEventListener("click", () => {
      Object.assign(state, { lo: view.contrast[0], hi: view.contrast[1], invert: view.invert });
      invert.checked = state.invert; lo.sync(); hi.sync(); repaint();
    });
    const full = el("button", { type: "button", text: "Full range" });
    full.addEventListener("click", () => { Object.assign(state, { lo: 0, hi: top }); lo.sync(); hi.sync(); repaint(); });
    controls.append(lo.node, hi.node, el("label", { class: "check" }, invert, " Invert"), reset, full);
    lo.sync(); hi.sync();
    paint(canvas, image, state.lo, state.hi, state.invert);
  }

  // Only when the tab can be seen: a figure of many panels does not make
  // every aligned image at once.
  const watcher = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      watcher.disconnect();
      load();
    }
  });
  watcher.observe(stage);
  return root;
}

// --- the redraw tab --------------------------------------------------------------------------

const REDRAWN = {
  same: ["ok", "Matches pixel for pixel"],
  differs: ["differs", "Differs"],
  cannot: ["unknown", "Cannot be drawn again"],
};

function redrawTab(panel) {
  const out = el("div", { class: "redraw" });
  const button = el("button", { type: "button", text: "Redraw and compare" });
  button.addEventListener("click", async () => {
    button.disabled = true;
    out.replaceChildren(el("p", { class: "meta", role: "status", text: "Drawing the picture again…" }));
    try {
      out.replaceChildren(redrawResult(panel, await ask("compare", { panel: panel.index })));
    } catch (error) {
      out.replaceChildren(el("div", { class: "banner bad" }, el("p", { text: `It could not be drawn again: ${error.message}` })));
    } finally {
      button.disabled = false;
    }
  });
  return el("div", {},
    el("p", { class: "meta", text: "Draws the panel's picture again from its embedded pixels and recorded settings, "
      + "by the reference method of the GelSVG specification, and compares it with the picture in the file. "
      + "A picture changed after it was drawn shows up here even if its recorded hash was changed with it." }),
    el("p", {}, button), out);
}

function redrawResult(panel, r) {
  const [state, word] = REDRAWN[r.state];
  const out = el("div");
  out.append(el("ul", { class: "checks" }, el("li", { class: state, text: word })), el("p", { text: r.message }));
  if (r.differing) {
    out.append(el("p", { class: "meta", text:
      `${(100 * r.differing / r.pixels).toFixed(2)}% of the pixels differ; the average difference over all pixels is ${fmt(r.mean)} of ${r.top}.` }));
  }
  if (r.notes.length) out.append(el("ul", { class: "redraw-notes" }, ...r.notes.map((n) => el("li", { text: n }))));
  if (!r.redrawn_png) return out;
  const pictures = [["In the file", panel.png], ["Drawn again", r.redrawn_png]];
  if (r.difference_png) pictures.push(["Where they differ (magenta, brighter where more)", r.difference_png]);
  out.append(el("div", { class: "compare" }, ...pictures.map(([caption, bytes]) =>
    el("figure", {}, el("img", { src: blobUrl(bytes, "image/png"), alt: caption }), el("figcaption", { text: caption })))));
  const saves = el("p", { class: "saves" });
  const saveAs = (text, bytes, suffix) => {
    const button = el("button", { type: "button", text });
    button.addEventListener("click", () => download(bytes, `${baseName}-panel-${panel.index + 1}-${suffix}.png`, "image/png"));
    return button;
  };
  saves.append(saveAs("Save the picture drawn again", r.redrawn_png, "redrawn"));
  if (r.difference_png) saves.append(saveAs("Save the difference map", r.difference_png, "differences"));
  out.append(saves);
  return out;
}

// --- the band table ---------------------------------------------------------------------------

// Lanes across, rows down, as MyWB's band table: a band is in the ROI if its
// centre is; rows not yet named are called as MyWB calls them.
function rowLetters(number) {
  let letters = "";
  for (number += 1; number; ) {
    const rest = (number - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return letters;
}

function bandTable(t, only, f) {
  if (!t.bands.length && !t.rows.length) return empty("No bands.");
  const across = new Map(t.lanes.map((lane) => {
    if (lane.point) return [lane.id, lane.x];
    const xs = t.bands.filter((b) => b.lane_id === lane.id).map((b) => f.centre(b)[0]);
    return [lane.id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity];
  }));
  const lanes = [...t.lanes].sort((a, b) => across.get(a.id) - across.get(b.id)).filter((l) => !only || f.lane(l));
  const rows = t.rows.filter((r) => !only || f.row(r));
  const cells = new Map(t.bands.map((b) => [`${b.lane_id}\u0000${b.row_id}`, b]));

  const counted = new Set(t.bands.filter(f.band).map((b) => b.row_id));
  let numbered = 0;
  let lettered = 0;
  const heading = new Map(t.rows.map((row) => {
    const standIn = !t.roi || counted.has(row.id) ? `Band ${++numbered}` : `Band ${rowLetters(lettered++)}`;
    const named = row.name && row.name.trim();
    return [row.id, { text: named ? row.name : standIn, named: Boolean(named) }];
  }));
  if (!lanes.length || !rows.length) return empty("Nothing is in the ROI.");
  const head = el("tr", {}, el("th", { scope: "col", text: "" }),
    ...lanes.map((lane) => el("th", { scope: "col", class: "lane-head", text: lane.point ? lane.lane : "—",
      title: lane.point ? `Lane ${lane.lane}` : "A lane with no sample label" })));
  const body = rows.map((row) => {
    const name = heading.get(row.id);
    return el("tr", {}, el("th", { scope: "row", class: name.named ? "row-head" : "row-head unnamed", text: name.text }),
      ...lanes.map((lane) => {
        const band = cells.get(`${lane.id}\u0000${row.id}`);
        if (!band) return el("td", { class: "cell" });
        const [x, y] = f.centre(band);
        const where = band.shape === "rect" ? `${fmt(band.w)} × ${fmt(band.h)} box centred at (${fmt(x)}, ${fmt(y)})`
          : `point at (${fmt(x)}, ${fmt(y)})`;
        const found = band.detection ? `; found by ${band.detection.by} (score ${fmt(band.detection.score)})` : "";
        return el("td", { class: f.band(band) ? "cell band" : "cell band outside", title: where + found, text: "●" });
      }));
  });
  return el("div", { class: "band-table-box" },
    el("p", { class: "meta", text: "Lanes in their order across the image, rows from the top; rows not yet named are numbered as MyWB numbers them." }),
    el("div", { class: "table-wrap" }, el("table", { class: "band-table" }, el("thead", {}, head), el("tbody", {}, ...body))));
}
