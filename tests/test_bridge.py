"""The bridge, under CPython, with the library checked out next to this
repository."""

import io
import json

import numpy as np
from PIL import Image

import gelsvg
import viewer_bridge as bridge

TOOL = gelsvg.Tool("test", "1")


def a_panel(note: str = "") -> bytes:
    pixels = (np.arange(48, dtype=np.uint8).reshape(6, 8) * 5)
    core = {"sources": [{"id": "s1", "dtype": "uint8", "shape": [6, 8],
                         "channels": [{"name": "gray", "pixel_hash": gelsvg.pixel_hash(pixels)}]}],
            "blot": [{"id": "c1", "source": "s1", "source_channel": "gray", "invert": False, "contrast": [0, 255]}],
            "orientation": {"turn": 0, "flip": False, "rotation": 0}, "output_bit_depth": 8,
            "samples": {"lanes": [{"id": "1", "number": 1, "x": 2, "y": 1}]}}
    if note:
        core["note"] = note
    crop = gelsvg.default_crop(core)
    rendered = gelsvg.render(core, {gelsvg.pixel_hash(pixels): pixels}, crop)
    return gelsvg.new_panel(gelsvg.Content({"core": core, "figure": {"crop": crop}}, rendered=rendered,
                                           channel_images=[pixels]), TOOL)


def svg_of(*pngs: bytes, extra: str = "") -> bytes:
    body = "".join(gelsvg.image_element(png, x=20 * i) for i, png in enumerate(pngs))
    return f'<svg xmlns="http://www.w3.org/2000/svg">{body}{extra}</svg>'.encode()


def test_a_gelsvg_document():
    png = a_panel()
    result = bridge.open_document(svg_of(png), "figure.gel.svg")
    assert result["is_document"] and result["converted"] is None and "conversion_error" not in result
    (panel,) = result["panels"]
    assert panel["png"] == png and panel["readable"]
    assert panel["checks"] == {"drawn_from": "ok", "rendered_hash": "ok", "svg_hash": "absent"}
    assert panel["counts"]["lanes"] == 1 and panel["counts"]["embedded_channels"] == 1
    assert panel["written_by"] == {"name": "test", "version": "1"} and panel["notices"] == []


def test_a_signed_document_and_an_edited_one():
    a, b = a_panel(), a_panel("second")
    signed = gelsvg.sign(svg_of(a, b, extra="<text>A</text>"), [a, b]).svg
    assert [p["checks"]["svg_hash"] for p in bridge.open_document(signed, "x")["panels"]] == ["ok", "ok"]
    edited = signed.replace(b"<text>A</text>", b"<text>B</text>")
    assert [p["checks"]["svg_hash"] for p in bridge.open_document(edited, "x")["panels"]] == ["differs", "differs"]


def test_files_that_are_not_documents():
    for data in (b'<svg xmlns="http://www.w3.org/2000/svg"/>', b"<svg", b"\x89PNG not really"):
        result = bridge.open_document(data, "x")
        assert not result["is_document"] and result["panels"] == [] and "conversion_error" not in result
        assert any(n["kind"] == "UNREADABLE" for n in result["document_notices"])


def old_document(flip: int = 0) -> bytes:
    data = {"schema_version": 4, "datetime": "2026-01-01 00:00:00",
            "source_image_info": {"marker_file_name": "", "marker_sha256": "", "blot_file_name": "blot.tif",
                                  "blot_sha256": "ab" * 32, "blot_rgb_channel": ""},
            "filter_data_m": {"rotation_offset": 0, "resize": None, "flip": 0, "rotation": 0, "invert": 0, "contrast": [0, 255]},
            "filter_data_b": {"rotation_offset": 0, "resize": None, "flip": flip, "rotation": 0, "invert": 0, "contrast": [0, 255]},
            "roi_info": {"roi_x": None, "roi_y": None, "roi_w": None, "roi_h": None},
            "misc_info": {"output_bit_depth": "8"}, "sample_label_info": {}, "marker_label_info": {}}
    buf = io.BytesIO()
    Image.fromarray(np.zeros((4, 5), dtype=np.uint8)).save(buf, format="PNG")
    import base64
    uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    text = json.dumps(data).replace("&", "&amp;").replace("<", "&lt;")
    return (f'<svg xmlns="http://www.w3.org/2000/svg"><image href="{uri}"><metadata data-mywb-role="settings">'
            f"{text}</metadata></image></svg>").encode()


def test_an_old_mywb_document_is_converted():
    result = bridge.open_document(old_document(), "blot.mywb.svg")
    assert result["is_document"] and result["converted"]["panels"][0]["schema_version"] == 4
    assert gelsvg.read(result["converted"]["svg"]).is_document
    (panel,) = result["panels"]
    assert panel["checks"]["drawn_from"] == "ok" and panel["written_by"]["name"] == "GelSVG Viewer"


def test_an_old_mywb_document_that_cannot_be_converted():
    result = bridge.open_document(old_document(flip=2), "bad.mywb.svg")
    assert "flip" in result["conversion_error"] and not result["is_document"]


def test_versions():
    assert set(bridge.versions()) == {"viewer", "gelsvg", "python", "numpy", "pillow"}
