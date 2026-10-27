"""What the viewer asks of the gelsvg library, returned as plain data (dicts,
lists, strings, numbers, bytes) for the page to show.

It runs inside Pyodide in a Web Worker, and under CPython for the tests.
"""

from __future__ import annotations

import json
import sys

import numpy as np

import gelsvg
from gelsvg import Kind, _encode, _png, _svghash, legacy

import viewer_metadata

VIEWER = gelsvg.Tool("GelSVG Viewer", "0.1.0")
_open: dict = {"doc": None, "aligned": {}}
"""The document last opened, and the aligned images worked out for it."""


def versions() -> dict:
    import numpy
    import PIL

    return {"viewer": VIEWER.version, "gelsvg": gelsvg.__version__, "python": sys.version.split()[0],
            "numpy": numpy.__version__, "pillow": PIL.__version__}


def _notice(n) -> dict:
    return {"kind": n.kind.name, "code": n.code, "message": n.message, "where": n.where}


def _state(checks: dict, name: str, recorded: bool = True) -> str:
    """ok (matched), differs, unknown (could not be checked) or absent (not
    recorded, so nothing to check)."""

    if name not in checks:
        return "unknown" if recorded else "absent"
    value = checks[name]
    return "ok" if value is True else "differs" if value is False else "unknown"


def _panel(panel) -> dict:
    out = {"index": panel.index, "readable": panel.readable, "unreadable_reason": panel.unreadable_reason,
           "newer_version": panel.newer_version, "png": panel.carrier.png,
           "notices": [_notice(n) for n in panel.notices if n.kind is not Kind.CHECK]}
    if not panel.readable:
        return out
    view = panel.core
    out.update(
        schema_version=panel.schema_version, schema_revision=panel.schema_revision,
        newer_revision=panel.newer_revision, saved_at=panel.saved_at,
        written_by={k: v for k, v in (panel.written_by or {}).items() if v is not None} or None,
        assembly=panel.assembly,
        checks={
            "drawn_from": _state(panel.checks, "drawn_from"),
            "rendered_hash": _state(panel.checks, "rendered_hash"),
            "svg_hash": _state(panel.checks, "svg_hash", recorded=panel.figure.get("svg_hash") is not None),
        },
        counts={"sources": len(view.sources or ()), "embedded_channels": len(panel.channel_images),
                "lanes": len(view.lanes), "rows": len(view.rows), "bands": len(view.bands),
                "markers": len(view.markers), "quantifications": len(panel.quantifications)},
        tables=_tables(panel),
    )
    return out


def _tables(panel) -> dict:
    """What the panel's tabs show, from the panel as read (what reading
    dropped is not shown; the notices say what it was)."""

    core = panel.to_json()["core"]
    samples = core.get("samples", {})
    lanes = samples.get("lanes", [])
    lane_name = {lane["id"]: str(lane["number"]) if "number" in lane else lane["id"] for lane in lanes}
    rows = core.get("rows", [])
    row_name = {row["id"]: row.get("name") or row["id"] for row in rows}
    blot_name = {element["id"]: f"blot element {i + 1}" for i, element in enumerate(core.get("blot", []))}

    def where(value: dict) -> dict:
        out = {"lane": lane_name.get(value["lane"], value["lane"])}
        if "row" in value:
            out["row"] = row_name.get(value["row"], value["row"])
        return out

    quantifications = []
    for q in panel.quantifications:
        quantifications.append({
            "mode": q["mode"], "pixels": q["pixels"], "method": q["method"], "inverted": q["inverted"],
            "channel": blot_name.get(q.get("channel"), q.get("channel")),
            "stale": "unknown" if q["stale"] is None else "stale" if q["stale"] else "current",
            "values": [{**where(v), **{k: v[k] for k in ("raw", "signal", "background", "peak") if v.get(k) is not None},
                        "region": v["region"]} for v in q["values"]],
        })

    uses: dict[str, list[str]] = {}
    for i, element in enumerate(core.get("blot", [])):
        uses.setdefault(element["source"], []).append(f"blot element {i + 1} ({element['source_channel']})")
    if "marker" in core:
        uses.setdefault(core["marker"]["source"], []).append(f"marker image ({core['marker']['source_channel']})")
    views = _views(panel, core)
    sources = []
    for source in core.get("sources", []):
        item = {k: source.get(k) for k in ("id", "file_name", "file_hash", "dtype", "shape")}
        item["channels"] = [{"name": c["name"], "pixel_hash": c.get("pixel_hash"),
                             "embedded": c.get("pixel_hash") in panel.channel_images} for c in source["channels"]]
        item["uses"] = uses.get(source["id"], [])
        record = panel.core.source_metadata.get(source.get("source_metadata"))
        if record is not None:
            meta = {"format": record["format"], "version": record["version"], "byte_length": record["byte_length"],
                    "readable": record["readable"]}
            if record["readable"] and record.get("index") is not None:
                meta["rows"] = viewer_metadata.rows(record["format"], record["index"], record["payload"])
            item["metadata"] = meta
        sources.append(item)

    return {
        "conditions": [{"id": c["id"], "name": c.get("name")} for c in samples.get("conditions", [])],
        "lanes": [{"id": lane["id"], "lane": lane_name[lane["id"]], "point": "number" in lane, "x": lane.get("x"),
                   "y": lane.get("y"), "details": lane.get("details"), "values": lane.get("values", {})} for lane in lanes],
        "rows": [{"id": row["id"], "name": row.get("name")} for row in rows],
        "bands": [{**where(b), "lane_id": b["lane"], "row_id": b["row"], "shape": b["shape"], "x": b["x"], "y": b["y"],
                   "w": b.get("w"), "h": b.get("h"), "detection": b.get("detection")} for b in core.get("bands", [])],
        "markers": [{"label": m["label"], "size": m.get("size"), "x": m["x"], "y": m["y"]} for m in core.get("markers", [])],
        "quantifications": quantifications,
        "sources": sources,
        "annotation": core.get("annotation"),
        "note": core.get("note"),
        "json": json.dumps(panel.raw, indent=2, ensure_ascii=False),
        "roi": core.get("roi"),
        "crop": panel.figure.get("crop"),
        "views": views,
        "orientation": core.get("orientation"),
        "output_bit_depth": core.get("output_bit_depth"),
        "drawing": _drawing(core),
        "redrawable": panel.rendered is not None and panel.figure.get("crop") is not None
                      and all(v["available"] for v in views if v["element"] != "marker"),
    }


def _drawing(core: dict) -> list[dict]:
    """How each image is drawn: its channel, contrast, inversion and colour,
    and how it is lined up with the reference channel."""

    files = {s["id"]: (s.get("file_name"), s.get("shape")) for s in core.get("sources", [])}
    items = [("blot", i, e) for i, e in enumerate(core.get("blot", []))]
    if "marker" in core:
        items.append(("marker", None, core["marker"]))
    out = []
    for kind, i, e in items:
        file_name, shape = files.get(e["source"], (None, None))
        out.append({"kind": kind, "index": i, "channel": e["source_channel"], "file_name": file_name, "shape": shape,
                    "contrast": e["contrast"], "invert": e["invert"], "color": e.get("color"),
                    "turn": e.get("turn") if kind == "marker" or i else None,
                    "flip": e.get("flip") if kind == "marker" or i else None})
    return out


def _channels_of(core: dict, element: dict) -> list[str | None]:
    source = next((s for s in core.get("sources", []) if s["id"] == element["source"]), None)
    if source is None:
        return [None]
    names = ["red", "green", "blue"] if element["source_channel"] == "average" else [element["source_channel"]]
    hashes = {c["name"]: c.get("pixel_hash") for c in source["channels"]}
    return [hashes.get(n) for n in names]


def _views(panel, core: dict) -> list[dict]:
    """The aligned images the page can show: one per blot element, and the
    marker image."""

    items = [(i, e, f"Blot element {i + 1}") for i, e in enumerate(core.get("blot", []))]
    if "marker" in core:
        items.append(("marker", core["marker"], "Marker image"))
    try:
        size = list(gelsvg.aligned_size(core))
    except ValueError:
        size = None
    out = []
    for key, element, label in items:
        hashes = _channels_of(core, element)
        source = next((s for s in core.get("sources", []) if s["id"] == element["source"]), {})
        out.append({"element": key, "label": f"{label} ({element['source_channel']})",
                    "channel": element["source_channel"], "file_name": source.get("file_name"),
                    "available": all(h in panel.channel_images for h in hashes),
                    "saveable": element["source_channel"] != "average" and hashes[0] in panel.channel_images,
                    "contrast": element["contrast"], "invert": element["invert"], "dtype": source.get("dtype"),
                    "size": size})
    return out


def _element(value):
    return "marker" if value == "marker" else int(value)


def aligned(panel_index: int, element) -> dict:
    """The aligned image (§4.2) of a blot element or the marker image, as
    little-endian samples for a typed array on the page."""

    element = _element(element)
    key = (panel_index, element)
    if key not in _open["aligned"]:
        panel = _open["doc"].panels[panel_index]
        _open["aligned"][key] = gelsvg.aligned_image(panel.to_json()["core"], panel.channel_images, element)
    image = _open["aligned"][key]
    return {"dtype": "uint8" if image.dtype.itemsize == 1 else "uint16", "shape": list(image.shape),
            "pixels": image.astype("<u2" if image.dtype.itemsize == 2 else "u1").tobytes()}


def _png_of(pixels: np.ndarray) -> bytes:
    header, stream = _encode.encode_image(pixels)
    return _png.PNG_SIGNATURE + header + _encode.idat_chunks(stream) + _encode.IEND


def _difference_map(picture: np.ndarray, difference: np.ndarray, largest: int) -> np.ndarray:
    """The picture dimmed in grey, with the pixels that differ in magenta,
    brighter where they differ more."""

    grey = picture if picture.ndim == 2 else picture.mean(axis=2)
    top = 65535 if picture.dtype == np.uint16 else 255
    base = (grey.astype(np.float64) / top * 255 * 0.4).astype(np.uint8)
    out = np.stack([base, base, base], axis=2)
    where = difference > 0
    strength = 0.35 + 0.65 * (difference[where].astype(np.float64) / max(largest, 1))
    out[where] = np.stack([255 * strength, np.zeros_like(strength), 255 * strength], axis=1).astype(np.uint8)
    return out


def compare(panel_index: int) -> dict:
    """Draw the panel's picture again from its embedded pixels with the
    reference method (§6.2) and compare it with the picture in the file."""

    panel = _open["doc"].panels[panel_index]

    def cannot(message: str) -> dict:
        return {"state": "cannot", "message": message, "notes": []}

    if panel.rendered is None:
        return cannot("The panel's picture cannot be decoded, so there is nothing to compare.")
    crop = panel.figure.get("crop")
    if crop is None:
        return cannot("Which part of the panel the picture shows is not known ('crop'), so it cannot be drawn again.")
    try:
        drawn = gelsvg.render(panel.to_json()["core"], panel.channel_images, crop)
    except ValueError as exc:
        text = str(exc)
        if "is not given" in text or "never read" in text or "no 'shape'" in text:
            return cannot("The panel's pixels are not embedded in the file, so it cannot be drawn again here.")
        return cannot(f"The panel cannot be drawn again: {text}")

    notes = []
    if panel.checks.get("drawn_from") is False:
        notes.append("The data changed after the picture was drawn (drawn_from), so a picture drawn from today's data "
                     "is expected to differ.")
    mywb = (panel.extensions.get(legacy.MYWB_EXTENSION) or {}).get("value") or {}
    if "converted_from" in mywb and panel.to_json()["core"]["orientation"]["rotation"] != 0:
        notes.append("This picture was drawn by an older MyWB, whose fine rotation used a different interpolation; "
                     "band edges are expected to differ a little (specification §4.3).")
    top = 65535 if panel.rendered.dtype == np.uint16 else 255
    result = {"top": top, "notes": notes, "redrawn_png": _png_of(drawn)}
    if drawn.shape != panel.rendered.shape or drawn.dtype != panel.rendered.dtype:
        result.update(state="differs", message=(
            f"The picture is {panel.rendered.shape[1]} × {panel.rendered.shape[0]} ({panel.rendered.dtype}); drawn again it "
            f"is {drawn.shape[1]} × {drawn.shape[0]} ({drawn.dtype})."))
        return result
    difference = np.abs(drawn.astype(np.int64) - panel.rendered.astype(np.int64))
    if difference.ndim == 3:
        difference = difference.max(axis=2)
    differing = int((difference > 0).sum())
    result.update(pixels=int(difference.size), differing=differing)
    if not differing:
        result.update(state="same", message="The picture matches the one drawn again from the embedded pixels, pixel for pixel.")
        return result
    largest = int(difference.max())
    result.update(state="differs", largest=largest, mean=float(difference.mean()),
                  difference_png=_png_of(_difference_map(panel.rendered, difference, largest)),
                  message=f"{differing} of {difference.size} pixels differ; the largest difference is {largest} of {top}.")
    return result


def save(panel_index: int, what: str, element=None) -> dict:
    """A file to save: the panel's picture without its data, an embedded
    channel image as it was embedded, or an aligned image; all PNG."""

    panel = _open["doc"].panels[panel_index]
    name = f"panel-{panel_index + 1}"
    if what == "picture":
        return {"bytes": _svghash.png_without_panel_data(panel.carrier.png), "name": f"{name}-picture.png"}
    element = _element(element)
    suffix = "marker" if element == "marker" else f"blot-{element + 1}"
    if what == "aligned":
        aligned(panel_index, element)
        return {"bytes": _encode.channel_png(_open["aligned"][(panel_index, element)]), "name": f"{name}-{suffix}-aligned.png"}
    core = panel.to_json()["core"]
    item = core["marker"] if element == "marker" else core["blot"][element]
    (key,) = _channels_of(core, item)
    return {"bytes": panel.core.channel_images[key]["payload"], "name": f"{name}-{suffix}-channel.png"}


def open_document(data: bytes, file_name: str) -> dict:
    """Read a file. Old MyWB documents in it are converted to GelSVG panels
    first (the converted file can be saved)."""

    data = data.to_bytes() if hasattr(data, "to_bytes") else bytes(data)  # a JS Uint8Array, under Pyodide
    doc = gelsvg.read(data)
    result: dict = {"file_name": file_name, "converted": None}
    if doc.container.tree is not None and (doc.legacy or not doc.is_document):
        try:
            converted = legacy.convert(data, VIEWER)
        except legacy.NoOldDocument:
            pass
        except legacy.LegacyError as exc:
            result["conversion_error"] = str(exc)
        else:
            doc = gelsvg.read(converted.svg)
            result["converted"] = {
                "svg": converted.svg,
                "panels": [{"schema_version": p.schema_version, "notes": list(p.notes)} for p in converted.panels],
            }
    result["is_document"] = doc.is_document
    result["document_notices"] = [_notice(n) for n in doc.notices]
    result["assemblies"] = [{"id": a.id, "members": a.members, "panels": {str(k): v for k, v in a.panels.items()},
                             "missing": a.missing} for a in doc.assemblies]
    result["panels"] = [_panel(p) for p in doc.panels]
    result["legacy_left"] = len(doc.legacy)
    _open["doc"], _open["aligned"] = doc, {}
    return result
