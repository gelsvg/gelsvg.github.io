"""What the viewer asks of the gelsvg library, returned as plain data (dicts,
lists, strings, numbers, bytes) for the page to show.

It runs inside Pyodide in a Web Worker, and under CPython for the tests.
"""

from __future__ import annotations

import json
import sys

import gelsvg
from gelsvg import Kind, _encode, _svghash, legacy

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
        "lanes": [{"lane": lane_name[lane["id"]], "point": "number" in lane, "x": lane.get("x"), "y": lane.get("y"),
                   "details": lane.get("details"), "values": lane.get("values", {})} for lane in lanes],
        "bands": [{**where(b), "shape": b["shape"], "x": b["x"], "y": b["y"], "w": b.get("w"), "h": b.get("h"),
                   "detection": b.get("detection")} for b in core.get("bands", [])],
        "markers": [{"label": m["label"], "size": m.get("size"), "x": m["x"], "y": m["y"]} for m in core.get("markers", [])],
        "quantifications": quantifications,
        "sources": sources,
        "annotation": core.get("annotation"),
        "note": core.get("note"),
        "json": json.dumps(panel.raw, indent=2, ensure_ascii=False),
        "roi": core.get("roi"),
        "crop": panel.figure.get("crop"),
        "views": _views(panel, core),
    }


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
    out = []
    for key, element, label in items:
        hashes = _channels_of(core, element)
        source = next((s for s in core.get("sources", []) if s["id"] == element["source"]), {})
        out.append({"element": key, "label": f"{label} ({element['source_channel']})",
                    "available": all(h in panel.channel_images for h in hashes),
                    "saveable": element["source_channel"] != "average" and hashes[0] in panel.channel_images,
                    "contrast": element["contrast"], "invert": element["invert"], "dtype": source.get("dtype")})
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
