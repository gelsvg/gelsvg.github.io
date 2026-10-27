"""Source metadata (GelSVG §5.4) as rows a person can read: TIFF and EXIF
tags by name, PNG text chunks, the kind of each JPEG segment."""

from __future__ import annotations

import struct
import zlib

TIFF_TAGS = {
    254: "NewSubfileType", 256: "ImageWidth", 257: "ImageLength", 258: "BitsPerSample", 259: "Compression",
    262: "PhotometricInterpretation", 266: "FillOrder", 269: "DocumentName", 270: "ImageDescription", 271: "Make",
    272: "Model", 274: "Orientation", 277: "SamplesPerPixel", 278: "RowsPerStrip", 282: "XResolution",
    283: "YResolution", 284: "PlanarConfiguration", 285: "PageName", 296: "ResolutionUnit", 305: "Software",
    306: "DateTime", 315: "Artist", 316: "HostComputer", 317: "Predictor", 320: "ColorMap", 338: "ExtraSamples",
    339: "SampleFormat", 700: "XMP", 33432: "Copyright", 33434: "ExposureTime", 33437: "FNumber",
    34675: "ICCProfile", 34855: "ISOSpeedRatings", 36864: "ExifVersion", 36867: "DateTimeOriginal",
    36868: "DateTimeDigitized", 37386: "FocalLength", 37510: "UserComment", 42016: "ImageUniqueID",
    42033: "BodySerialNumber", 42036: "LensModel",
}
_FORMATS = {1: "B", 3: "H", 4: "I", 6: "b", 8: "h", 9: "i", 11: "f", 12: "d", 13: "I", 16: "Q", 17: "q", 18: "Q"}
_SHOWN = 8  # values shown before "… N values"
_TEXT = 300  # characters shown before "…"


def _clip(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text if len(text) <= _TEXT else text[:_TEXT] + "…"


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def _size(n: int) -> str:
    return f"{n} byte" + ("" if n == 1 else "s")


def _tiff_value(kind: int, count: int, data: bytes, endian: str) -> str:
    if kind == 2:
        return _clip(_decode(data.rstrip(b"\0")))
    if kind in (5, 10):
        pairs = struct.unpack(f"{endian}{2 * count}{'I' if kind == 5 else 'i'}", data)
        shown = [f"{a}/{b}" for a, b in zip(pairs[::2], pairs[1::2])][:_SHOWN]
    elif kind in _FORMATS:
        values = struct.unpack(f"{endian}{count}{_FORMATS[kind]}", data)
        shown = [f"{v:.6g}" if isinstance(v, float) else str(v) for v in values[:_SHOWN]]
    else:  # UNDEFINED: often text (XMP, comments)
        text = data.rstrip(b"\0")
        if text and all(32 <= b < 127 or b in (9, 10, 13) for b in text[:200]):
            return _clip(_decode(text))
        return _size(len(data))
    more = f" … {count} values" if count > _SHOWN else ""
    return ", ".join(shown) + more


def _png_value(chunk: str, data: bytes) -> str:
    try:
        if chunk == "IHDR" and len(data) == 13:
            w, h, depth, colour = struct.unpack(">IIBB", data[:10])
            return f"{w} × {h}, {depth}-bit, colour type {colour}"
        if chunk in ("tEXt", "zTXt", "iTXt"):
            keyword, _, rest = data.partition(b"\0")
            if chunk == "zTXt":
                rest = zlib.decompress(rest[1:])
            elif chunk == "iTXt":
                flag = rest[0]
                rest = rest[2:].partition(b"\0")[2].partition(b"\0")[2]
                rest = zlib.decompress(rest) if flag else rest
            return f"{_decode(keyword)}: {_clip(_decode(rest))}"
        if chunk == "tIME" and len(data) == 7:
            y, mo, d, h, mi, s = struct.unpack(">HBBBBB", data)
            return f"{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"
        if chunk == "pHYs" and len(data) == 9:
            x, y, unit = struct.unpack(">IIB", data)
            return f"{x} × {y} pixels per {'metre' if unit == 1 else 'unit'}"
    except (zlib.error, struct.error, IndexError):
        pass
    return _size(len(data))


def _jpeg_value(marker: str, data: bytes) -> str:
    for head, name in ((b"JFIF\0", "JFIF"), (b"JFXX\0", "JFXX thumbnail"), (b"Exif\0\0", "EXIF"),
                       (b"http://ns.adobe.com/xap/1.0/\0", "XMP"), (b"ICC_PROFILE\0", "ICC profile"),
                       (b"MPF\0", "MPF"), (b"Photoshop 3.0\0", "Photoshop"), (b"Adobe", "Adobe")):
        if data.startswith(head):
            return f"{name} ({_size(len(data))})"
    if marker == "COM":
        return _clip(_decode(data))
    return _size(len(data))


def rows(fmt: str, index: dict, payload: bytes) -> list[dict]:
    """One row per segment: where it was, its name, and its value as text."""

    data = payload[4 + struct.unpack(">I", payload[:4])[0] :]
    endian = "<" if index.get("byte_order") == "II" else ">"
    out = []
    for segment in index["segments"]:
        part = data[segment["offset"] : segment["offset"] + segment["length"]]
        if fmt == "tiff":
            name = TIFF_TAGS.get(segment["tag"], f"Tag {segment['tag']}") if segment["ifd"] != "gps" else f"GPS tag {segment['tag']}"
            out.append({"where": segment["ifd"], "name": name,
                        "value": _tiff_value(segment["type"], segment["count"], part, endian)})
        elif fmt == "png":
            out.append({"where": "after the pixels" if segment["after_pixels"] else "before the pixels",
                        "name": segment["chunk_type"], "value": _png_value(segment["chunk_type"], part)})
        elif fmt == "jpeg":
            out.append({"where": "", "name": segment["marker"], "value": _jpeg_value(segment["marker"], part)})
        else:
            out.append({"where": "", "name": segment["part"].replace("_", " "), "value": _size(len(part))})
    return out
