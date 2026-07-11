#!/usr/bin/env python3
"""Generate menu-bar tray ring icons (16px + 32px @2x).

Each icon is a circular progress ring:
  - full-circle track in neutral gray (visible on light AND dark menu bars)
  - progress arc in a status color, starting at 12 o'clock, clockwise

Output: assets/tray/{status}-{pct}.png and {status}-{pct}@2x.png
"""
from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'tray')

# Status colors chosen for visibility on both light and dark menu bars
COLORS = {
    'allowed':      (52, 199, 89, 255),    # bright green
    'soft':         (255, 159, 10, 255),   # bright orange
    'hard':         (255, 69, 58, 255),    # bright red
    'disconnected': (152, 152, 157, 255),  # neutral gray
}
TRACK = (128, 128, 128, 110)  # semi-transparent gray full ring

SS = 8  # supersampling factor for smooth antialiasing


def draw_ring(size: int, pct: int, color) -> Image.Image:
    big = size * SS
    im = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    stroke = int(size * 0.14) * SS  # ~2.2px at 16
    margin = stroke // 2 + SS
    box = [margin, margin, big - margin, big - margin]

    # Track (full circle)
    d.arc(box, start=0, end=360, fill=TRACK, width=stroke)

    # Progress arc, from 12 o'clock clockwise
    if pct > 0:
        sweep = 360 * (pct / 100.0)
        d.arc(box, start=-90, end=-90 + sweep, fill=color, width=stroke)

    return im.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for status, color in COLORS.items():
        for pct in range(0, 101, 10):
            draw_ring(16, pct, color).save(os.path.join(OUT_DIR, f'{status}-{pct}.png'))
            draw_ring(32, pct, color).save(os.path.join(OUT_DIR, f'{status}-{pct}@2x.png'))
    print(f'Generated {len(COLORS) * 11 * 2} icons in {OUT_DIR}')


if __name__ == '__main__':
    main()
