"""What the viewer asks of the gelsvg library, returned as plain data (dicts,
lists, strings, numbers, bytes) for the page to show.

It runs inside Pyodide in a Web Worker, and under CPython for the tests.
"""

from __future__ import annotations

import sys

import gelsvg
from gelsvg import Kind, legacy

VIEWER = gelsvg.Tool("GelSVG Viewer", "0.1.0")


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
    )
    return out


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
    return result
