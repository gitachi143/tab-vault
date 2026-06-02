#!/usr/bin/env python3
"""Generate Tab Vault PNG icons using only stdlib.

Renders a rounded-square indigo→violet gradient with a stylized "V" + bookmark
fold motif. Output: icons/icon{16,32,48,128}.png
"""
import math
import os
import struct
import zlib

SIZES = [16, 32, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def lerp(a, b, t):
    return a + (b - a) * t


def gradient_color(x, y, w, h):
    # Diagonal indigo (#6366f1) -> violet (#a855f7)
    t = max(0.0, min(1.0, (x + y) / (w + h)))
    r = lerp(0x63, 0xa8, t)
    g = lerp(0x66, 0x55, t)
    b = lerp(0xf1, 0xf7, t)
    return (int(r), int(g), int(b), 255)


def alpha_blend(dst, src):
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    a = sa / 255.0
    out_a = sa + da * (1 - a)
    if out_a == 0:
        return (0, 0, 0, 0)
    out_r = (sr * sa + dr * da * (1 - a)) / out_a
    out_g = (sg * sa + dg * da * (1 - a)) / out_a
    out_b = (sb * sa + db * da * (1 - a)) / out_a
    return (int(out_r), int(out_g), int(out_b), int(out_a))


def rounded_rect_alpha(x, y, w, h, radius):
    """Return 0..255 coverage for a rounded square at (x,y) within (w,h)."""
    cx = min(max(x, radius), w - radius - 1)
    cy = min(max(y, radius), h - radius - 1)
    if x < radius and y < radius:
        dx, dy = radius - x, radius - y
    elif x > w - radius - 1 and y < radius:
        dx, dy = x - (w - radius - 1), radius - y
    elif x < radius and y > h - radius - 1:
        dx, dy = radius - x, y - (h - radius - 1)
    elif x > w - radius - 1 and y > h - radius - 1:
        dx, dy = x - (w - radius - 1), y - (h - radius - 1)
    else:
        return 255
    d = math.sqrt(dx * dx + dy * dy)
    if d <= radius - 1:
        return 255
    if d >= radius:
        return 0
    return int(255 * (radius - d))


def draw_v(pixels, size):
    """Stamp a thick white V into the icon."""
    cx = size / 2
    top = size * 0.28
    bottom = size * 0.74
    half_w = size * 0.20
    thickness = max(1.5, size * 0.10)
    for y in range(size):
        for x in range(size):
            t = (y - top) / (bottom - top) if (bottom - top) else 0
            if t < 0 or t > 1:
                continue
            # Two line equations forming a V
            left_x = cx - half_w + t * half_w
            right_x = cx + half_w - t * half_w
            d_left = abs(x - left_x)
            d_right = abs(x - right_x)
            d = min(d_left, d_right)
            if d <= thickness / 2:
                a = 255
            elif d <= thickness / 2 + 1:
                a = int(255 * (1 - (d - thickness / 2)))
            else:
                continue
            # Slight inner shadow toward center for depth
            pixels[y][x] = alpha_blend(pixels[y][x], (255, 255, 255, a))


def render(size):
    radius = max(2, int(size * 0.22))
    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            a = rounded_rect_alpha(x, y, size, size, radius)
            if a == 0:
                continue
            r, g, b, _ = gradient_color(x, y, size, size)
            pixels[y][x] = (r, g, b, a)
    # subtle top-left highlight
    for y in range(size):
        for x in range(size):
            if pixels[y][x][3] == 0:
                continue
            dist = (x + y) / (size * 2)
            hl = max(0, int(40 * (1 - dist)))
            r, g, b, a = pixels[y][x]
            pixels[y][x] = (min(255, r + hl), min(255, g + hl), min(255, b + hl), a)
    draw_v(pixels, size)
    return pixels


def write_png(path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type: None
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT_DIR, f"icon{s}.png")
        write_png(path, render(s))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
