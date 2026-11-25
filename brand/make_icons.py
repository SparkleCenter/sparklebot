"""Make the Sparklebot icon set from the Sparkle mark.

Reads the names and sizes of Hermes's own icon files in this checkout and writes a Sparkle
version of each, same name and size, under brand/icons/. brand/apply.mjs then copies them
over the checkout. Placement depends only on a file's size, so running it again after the
overlay was applied gives the same result.

Run from the repository root:  python -I brand/make_icons.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
OUT = BRAND / "icons"
DESKTOP = ROOT / "apps" / "desktop"

# Files Hermes ships that carry its own mark. Each gets a Sparkle file of the same size.
SQUARE_PNGS = [
    "assets/icon.png",
    "assets/icon-dark.png",
    "assets/icon-mac.png",
    "public/apple-touch-icon.png",
    "public/nous-girl.png",
    "public/nous-girl-dark.png",
]
ICOS = ["assets/icon.ico", "assets/icon-dark.ico"]
ICNS = ["assets/icon.icns", "assets/icon-dark.icns"]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
SMALL = 48  # at or below this edge the mark is cropped tighter so it stays readable


def load_mark() -> tuple[Image.Image, Image.Image]:
    config = json.loads((BRAND / "sparklebot.json").read_text(encoding="utf-8"))
    padded = Image.open(ROOT / config["icons"]["source"]).convert("RGBA")
    bbox = padded.getbbox()
    if bbox is None:
        sys.exit("The Sparkle source icon is empty.")
    tight = padded.crop(bbox)
    return padded, tight


def fit(mark: Image.Image, box_w: int, box_h: int, margin: float = 0.0) -> Image.Image:
    """Scale the mark to fit a transparent box, keep its proportions, centre it."""
    canvas = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    inner_w = max(1, round(box_w * (1 - 2 * margin)))
    inner_h = max(1, round(box_h * (1 - 2 * margin)))
    scale = min(inner_w / mark.width, inner_h / mark.height)
    size = (max(1, round(mark.width * scale)), max(1, round(mark.height * scale)))
    scaled = mark.resize(size, Image.LANCZOS)
    canvas.alpha_composite(scaled, ((box_w - size[0]) // 2, (box_h - size[1]) // 2))
    return canvas


def square(padded: Image.Image, tight: Image.Image, edge: int) -> Image.Image:
    if edge <= SMALL:
        return fit(tight, edge, edge, margin=0.06)
    return fit(padded, edge, edge)


def tile(padded: Image.Image, tight: Image.Image, w: int, h: int) -> Image.Image:
    if w == h:
        return square(padded, tight, w)
    # Wide tile: Hermes puts its mark in a square two thirds of the height, centred.
    edge = round(h * 2 / 3)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(square(padded, tight, edge), ((w - edge) // 2, (h - edge) // 2))
    return canvas


def main() -> None:
    padded, tight = load_mark()
    written: list[str] = []

    for rel in SQUARE_PNGS:
        src = DESKTOP / rel
        if not src.exists():
            sys.exit(f"Expected Hermes file is missing: {src}. Hermes moved it; update this list.")
        w, h = Image.open(src).size
        dest = OUT / "apps/desktop" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        tile(padded, tight, w, h).save(dest)
        written.append(rel)

    appx = sorted((DESKTOP / "assets/appx").glob("*.png"))
    if not appx:
        sys.exit("No Windows tile images found in apps/desktop/assets/appx.")
    for src in appx:
        w, h = Image.open(src).size
        rel = f"assets/appx/{src.name}"
        dest = OUT / "apps/desktop" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        tile(padded, tight, w, h).save(dest)
        written.append(rel)

    master = square(padded, tight, 1024)
    for rel in ICOS:
        dest = OUT / "apps/desktop" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        frames = [square(padded, tight, s) for s in ICO_SIZES]
        frames[-1].save(dest, format="ICO", sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
        written.append(rel)

    for rel in ICNS:
        dest = OUT / "apps/desktop" / rel
        try:
            master.save(dest, format="ICNS")
            written.append(rel)
        except Exception as exc:  # macOS only; Windows builds do not use it
            print(f"skipped {rel} (macOS icon, not needed on Windows): {exc}")

    print(f"{len(written)} icon files written under {OUT}")


if __name__ == "__main__":
    main()
