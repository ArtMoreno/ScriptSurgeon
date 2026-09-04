"""Build ScriptSurgeon's multi-resolution Windows icon from approved RGBA masters."""

from __future__ import annotations

import argparse
from pathlib import Path
import struct
import sys
from typing import Iterable

from PIL import Image, UnidentifiedImageError


APP_ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = APP_ROOT / "assets"
FULL_MASTER = ASSET_DIR / "scriptcut-icon-master.png"
SMALL_MASTER = ASSET_DIR / "scriptcut-icon-small-master.png"
SIZES = (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256)
SMALL_MASTER_MAX_SIZE = 36


class IconValidationError(ValueError):
    """Raised when an icon source or generated frame violates the contract."""


def _perimeter_alpha(image: Image.Image) -> Iterable[int]:
    alpha = image.getchannel("A")
    width, height = image.size
    yield from alpha.crop((0, 0, width, 1)).get_flattened_data()
    yield from alpha.crop((0, height - 1, width, height)).get_flattened_data()
    if height > 2:
        yield from alpha.crop((0, 1, 1, height - 1)).get_flattened_data()
        yield from alpha.crop((width - 1, 1, width, height - 1)).get_flattened_data()


def _validate_rgba_image(image: Image.Image, label: str, *, expected_size: int | None = None) -> None:
    if image.mode != "RGBA":
        raise IconValidationError(f"{label} must be RGBA, not {image.mode}.")
    width, height = image.size
    if width != height:
        raise IconValidationError(f"{label} must be square, not {width}x{height}.")
    if expected_size is not None and image.size != (expected_size, expected_size):
        raise IconValidationError(
            f"{label} must be {expected_size}x{expected_size}, not {width}x{height}."
        )

    alpha_minimum, alpha_maximum = image.getchannel("A").getextrema()
    if alpha_minimum != 0 or alpha_maximum != 255:
        raise IconValidationError(
            f"{label} must contain both fully transparent and fully opaque pixels."
        )
    if any(_perimeter_alpha(image)):
        raise IconValidationError(f"{label} must have a fully transparent one-pixel perimeter.")


def _load_master(path: Path, label: str) -> Image.Image:
    if not path.is_file():
        raise FileNotFoundError(f"Missing {label}: {path}")
    try:
        with Image.open(path) as source:
            if source.format != "PNG":
                raise IconValidationError(f"{label} must be a PNG file, not {source.format}.")
            source.load()
            if source.mode != "RGBA":
                raise IconValidationError(f"{label} must be stored as RGBA, not {source.mode}.")
            image = source.copy()
    except UnidentifiedImageError as exc:
        raise IconValidationError(f"{label} is not a decodable image: {path}") from exc

    _validate_rgba_image(image, label)
    return image


def _resize_master(master: Image.Image, size: int) -> Image.Image:
    # Resize premultiplied RGBA so color from transparent pixels cannot create
    # an ivory or charcoal fringe around the icon's transparent corners.
    resized = master.convert("RGBa").resize(
        (size, size),
        Image.Resampling.LANCZOS,
        reducing_gap=3.0,
    ).convert("RGBA")
    # Lanczos can spread a trace of alpha into the outermost pixel even when
    # the master has generous transparent padding. Windows taskbar icons need
    # a genuinely transparent perimeter, especially at 16-24px.
    pixels = resized.load()
    for coordinate in range(size):
        pixels[coordinate, 0] = (0, 0, 0, 0)
        pixels[coordinate, size - 1] = (0, 0, 0, 0)
        pixels[0, coordinate] = (0, 0, 0, 0)
        pixels[size - 1, coordinate] = (0, 0, 0, 0)
    _validate_rgba_image(resized, f"generated {size}px frame", expected_size=size)
    return resized


def render_frames(full_master_path: Path = FULL_MASTER, small_master_path: Path = SMALL_MASTER) -> dict[int, Image.Image]:
    full_master = _load_master(full_master_path, "full icon master")
    small_master = _load_master(small_master_path, "small icon master")
    return {
        size: _resize_master(
            small_master if size <= SMALL_MASTER_MAX_SIZE else full_master,
            size,
        )
        for size in SIZES
    }


def _dib(image: Image.Image) -> bytes:
    """Return a 32-bit BGRA DIB frame with an ICO-compatible transparency mask."""
    _validate_rgba_image(image, "DIB input")
    width, height = image.size
    rgba = image.tobytes()

    xor_rows = bytearray()
    for y in range(height - 1, -1, -1):
        row_start = y * width * 4
        for x in range(width):
            offset = row_start + x * 4
            red, green, blue, alpha = rgba[offset : offset + 4]
            xor_rows.extend((blue, green, red, alpha))

    mask_stride = ((width + 31) // 32) * 4
    and_rows = bytearray()
    for y in range(height - 1, -1, -1):
        row = bytearray(mask_stride)
        row_start = y * width * 4
        for x in range(width):
            alpha = rgba[row_start + x * 4 + 3]
            if alpha < 128:
                row[x // 8] |= 0x80 >> (x % 8)
        and_rows.extend(row)

    bitmap_info = struct.pack(
        "<IIIHHIIIIII",
        40,
        width,
        height * 2,
        1,
        32,
        0,
        len(xor_rows),
        0,
        0,
        0,
        0,
    )
    return bitmap_info + bytes(xor_rows) + bytes(and_rows)


def _decode_dib(payload: bytes, expected_size: int) -> Image.Image:
    if len(payload) < 40:
        raise IconValidationError(f"{expected_size}px DIB frame is truncated.")
    (
        header_size,
        width,
        doubled_height,
        planes,
        bit_count,
        compression,
        _image_size,
        _x_pixels_per_meter,
        _y_pixels_per_meter,
        _colors_used,
        _colors_important,
    ) = struct.unpack_from("<IIIHHIIIIII", payload, 0)
    height = doubled_height // 2
    if (
        header_size != 40
        or width != expected_size
        or height != expected_size
        or doubled_height != expected_size * 2
        or planes != 1
        or bit_count != 32
        or compression != 0
    ):
        raise IconValidationError(f"{expected_size}px frame is not an uncompressed 32-bit ICO DIB.")

    pixel_bytes = width * height * 4
    pixel_start = header_size
    pixel_end = pixel_start + pixel_bytes
    if pixel_end > len(payload):
        raise IconValidationError(f"{expected_size}px DIB pixel data is truncated.")

    pixels = bytearray(pixel_bytes)
    bgra = payload[pixel_start:pixel_end]
    for file_y in range(height):
        destination_y = height - 1 - file_y
        for x in range(width):
            source_offset = (file_y * width + x) * 4
            destination_offset = (destination_y * width + x) * 4
            blue, green, red, alpha = bgra[source_offset : source_offset + 4]
            pixels[destination_offset : destination_offset + 4] = (red, green, blue, alpha)
    return Image.frombytes("RGBA", (width, height), bytes(pixels))


def read_ico_frames(path: Path) -> dict[int, Image.Image]:
    data = path.read_bytes()
    if len(data) < 6:
        raise IconValidationError(f"ICO header is truncated: {path}")
    reserved, image_type, image_count = struct.unpack_from("<HHH", data, 0)
    if reserved != 0 or image_type != 1:
        raise IconValidationError(f"Not a Windows ICO file: {path}")
    if image_count != len(SIZES):
        raise IconValidationError(
            f"ICO contains {image_count} frames; expected {len(SIZES)}."
        )

    frames: dict[int, Image.Image] = {}
    directory_end = 6 + image_count * 16
    if directory_end > len(data):
        raise IconValidationError("ICO directory is truncated.")
    for index in range(image_count):
        (
            raw_width,
            raw_height,
            _color_count,
            reserved_byte,
            planes,
            bit_count,
            payload_size,
            payload_offset,
        ) = struct.unpack_from("<BBBBHHII", data, 6 + index * 16)
        width = 256 if raw_width == 0 else raw_width
        height = 256 if raw_height == 0 else raw_height
        if reserved_byte != 0 or width != height or planes != 1 or bit_count != 32:
            raise IconValidationError(f"ICO directory entry {index} is invalid.")
        payload_end = payload_offset + payload_size
        if payload_offset < directory_end or payload_end > len(data):
            raise IconValidationError(f"ICO frame {width}px points outside the file.")
        if width in frames:
            raise IconValidationError(f"ICO contains duplicate {width}px frames.")
        frames[width] = _decode_dib(data[payload_offset:payload_end], width)
    return frames


def validate_ico(path: Path, expected_frames: dict[int, Image.Image] | None = None) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Generated icon was not found: {path}")
    frames = read_ico_frames(path)
    if tuple(sorted(frames)) != tuple(sorted(SIZES)):
        raise IconValidationError(
            f"ICO sizes were {tuple(sorted(frames))}; expected {SIZES}."
        )
    for size, frame in frames.items():
        _validate_rgba_image(frame, f"decoded {size}px frame", expected_size=size)
        if expected_frames is not None and frame.tobytes() != expected_frames[size].tobytes():
            raise IconValidationError(f"Decoded {size}px frame differs from its rendered source.")

    # Exercise Pillow's independent ICO decoder as an additional compatibility check.
    try:
        with Image.open(path) as icon:
            icon.load()
            decoded_sizes = tuple(sorted(width for width, height in icon.ico.sizes() if width == height))
            if decoded_sizes != tuple(sorted(SIZES)):
                raise IconValidationError(
                    f"Pillow decoded ICO sizes {decoded_sizes}; expected {SIZES}."
                )
            for size in SIZES:
                decoded = icon.ico.getimage((size, size)).convert("RGBA")
                _validate_rgba_image(decoded, f"Pillow-decoded {size}px frame", expected_size=size)
    except (OSError, SyntaxError) as exc:
        raise IconValidationError(f"Pillow could not decode generated icon: {path}") from exc


def write_ico(destination: Path) -> None:
    frames = render_frames()
    images = [(size, _dib(frames[size])) for size in SIZES]
    header_size = 6 + 16 * len(images)
    offset = header_size
    entries: list[bytes] = []
    payloads: list[bytes] = []
    for size, payload in images:
        dimension = 0 if size == 256 else size
        entries.append(
            struct.pack(
                "<BBBBHHII",
                dimension,
                dimension,
                0,
                0,
                1,
                32,
                len(payload),
                offset,
            )
        )
        payloads.append(payload)
        offset += len(payload)

    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(
        struct.pack("<HHH", 0, 1, len(images)) + b"".join(entries) + b"".join(payloads)
    )
    validate_ico(destination, frames)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "destination",
        nargs="?",
        type=Path,
        default=ASSET_DIR / "scriptcut.ico",
        help="ICO output path (default: assets/scriptcut.ico)",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="validate the existing destination and approved source masters without rewriting it",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    destination = args.destination.resolve()
    if args.validate_only:
        frames = render_frames()
        validate_ico(destination, frames)
        print(f"Validated {destination} ({len(SIZES)} RGBA DIB frames)")
    else:
        write_ico(destination)
        print(
            f"Generated {destination} ({len(SIZES)} RGBA DIB frames; "
            f"small master through {SMALL_MASTER_MAX_SIZE}px)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
