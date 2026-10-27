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


def a_full_panel() -> bytes:
    from gelsvg import _hashes

    pixels = (np.arange(48, dtype=np.uint16).reshape(6, 8) * 900)
    buf = io.BytesIO()
    Image.fromarray(pixels).save(buf, format="TIFF", tiffinfo={271: "ChemiDoc", 305: "Image Lab 6.1"})
    source = gelsvg.read_source(buf.getvalue(), file_name="blot.tif")
    core = {"sources": [source.to_json("s1")],
            "blot": [{"id": "c1", "source": "s1", "source_channel": "gray", "invert": True, "contrast": [0, 65535]}],
            "orientation": {"turn": 0, "flip": False, "rotation": 0}, "output_bit_depth": 16,
            "samples": {"conditions": [{"id": "t1", "name": "Genotype"}],
                        "lanes": [{"id": "1", "number": 1, "x": 2, "y": 1, "details": "WT", "values": {"t1": "WT"}},
                                  {"id": "n1"}]},
            "rows": [{"id": "r1", "name": "p-ERK"}],
            "bands": [{"lane": "1", "row": "r1", "shape": "rect", "x": 1, "y": 2, "w": 2, "h": 1},
                      {"lane": "n1", "row": "r1", "shape": "point", "x": 6, "y": 2.5,
                       "detection": {"by": "detector 1", "score": 0.93}}],
            "markers": [{"id": "m1", "x": 0.5, "y": 3, "label": "50", "size": {"value": 50, "unit": "kDa"}}],
            "note": "checked"}
    quant = [{"mode": "band", "pixels": "aligned", "method": {"name": "sum", "by": "test 1"}, "inverted": False,
              "computed_on": _hashes.quant_core_hash(core),
              "values": [{"lane": "1", "row": "r1", "region": {"shape": "rect", "x": 1, "y": 2, "w": 2, "h": 1},
                          "raw": 1200.5, "signal": 1000}]}]
    crop = gelsvg.default_crop(core)
    rendered = gelsvg.render(core, {gelsvg.pixel_hash(i): i for i in source.channel_images}, crop)
    return gelsvg.new_panel(gelsvg.Content({"core": core, "quantifications": quant, "figure": {"crop": crop}},
                                           rendered=rendered, channel_images=source.channel_images,
                                           source_metadata=source.source_metadata), TOOL)


def test_the_tables():
    (panel,) = bridge.open_document(svg_of(a_full_panel()), "x")["panels"]
    assert panel["notices"] == []
    t = panel["tables"]
    assert t["conditions"] == [{"id": "t1", "name": "Genotype"}]
    assert t["lanes"][0] == {"lane": "1", "point": True, "x": 2, "y": 1, "details": "WT", "values": {"t1": "WT"}}
    assert t["lanes"][1]["lane"] == "n1" and t["lanes"][1]["point"] is False
    assert [(b["lane"], b["row"], b["shape"]) for b in t["bands"]] == [("1", "p-ERK", "rect"), ("n1", "p-ERK", "point")]
    assert t["bands"][1]["detection"] == {"by": "detector 1", "score": 0.93}
    assert t["markers"] == [{"label": "50", "size": {"value": 50, "unit": "kDa"}, "x": 0.5, "y": 3}]
    (q,) = t["quantifications"]
    assert q["stale"] == "current" and q["values"][0]["lane"] == "1" and q["values"][0]["row"] == "p-ERK"
    (source,) = t["sources"]
    assert source["file_name"] == "blot.tif" and source["channels"][0]["embedded"] is True
    assert source["uses"] == ["blot element 1 (gray)"]
    rows = {r["name"]: r["value"] for r in source["metadata"]["rows"]}
    assert rows["Make"] == "ChemiDoc" and rows["Software"] == "Image Lab 6.1" and rows["ImageWidth"] == "8"
    assert '"format": "https://mybioapps.com/gelsvg/panel"' in t["json"] and t["note"] == "checked"


def test_metadata_rows_of_other_formats():
    import viewer_metadata

    png = io.BytesIO()
    from PIL import PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "hello")
    info.add_itxt("Title", "blot", zip=True)
    Image.fromarray(np.zeros((2, 3), dtype=np.uint8)).save(png, format="PNG", pnginfo=info)
    entry, payload = gelsvg.read_source(png.getvalue()).metadata
    from gelsvg._metadata import check_formal
    rows = viewer_metadata.rows("png", check_formal("png", payload)[0], payload)
    assert ("IHDR", "3 × 2, 8-bit, colour type 0") in [(r["name"], r["value"]) for r in rows]
    assert "Comment: hello" in [r["value"] for r in rows] and "Title: blot" in [r["value"] for r in rows]
    jpeg = io.BytesIO()
    Image.fromarray(np.zeros((8, 8, 3), dtype=np.uint8)).save(jpeg, format="JPEG", comment=b"a note")
    entry, payload = gelsvg.read_source(jpeg.getvalue()).metadata
    rows = viewer_metadata.rows("jpeg", check_formal("jpeg", payload)[0], payload)
    assert [r["value"].split(" (")[0] for r in rows] == ["JFIF", "a note"]


def test_aligned_images_and_saves():
    result = bridge.open_document(svg_of(a_full_panel()), "x")
    (panel,) = result["panels"]
    (view,) = panel["tables"]["views"]
    assert view["available"] and view["saveable"] and view["contrast"] == [0, 65535] and view["invert"] is True
    got = bridge.aligned(0, 0)
    pixels = np.frombuffer(got["pixels"], dtype="<u2").reshape(got["shape"])
    assert got["dtype"] == "uint16" and np.array_equal(pixels, np.arange(48, dtype=np.uint16).reshape(6, 8) * 900)
    assert panel["tables"]["crop"] == {"x": 0, "y": 0, "w": 8, "h": 6}
    picture = bridge.save(0, "picture")
    assert picture["name"] == "panel-1-picture.png" and b"GelSVG" not in picture["bytes"] and b"geLs" not in picture["bytes"]
    assert Image.open(io.BytesIO(picture["bytes"])).size == (8, 6)
    channel = bridge.save(0, "channel", 0)
    from gelsvg._embedded import decode_channel_png
    assert np.array_equal(decode_channel_png(channel["bytes"])[0], pixels)
    aligned_png = bridge.save(0, "aligned", 0)
    assert np.array_equal(decode_channel_png(aligned_png["bytes"])[0], pixels) and aligned_png["name"].endswith("-blot-1-aligned.png")


def test_a_view_without_embedded_pixels():
    result = bridge.open_document(old_document(), "old.mywb.svg")
    (view,) = result["panels"][0]["tables"]["views"]
    assert view["available"] is False and view["saveable"] is False
