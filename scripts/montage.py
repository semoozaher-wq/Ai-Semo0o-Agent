#!/usr/bin/env python3
"""Build contact sheets from the captured screenshots for quick review."""
import os, sys
from PIL import Image, ImageDraw, ImageFont

SRC = '/workspace/work/screenshots/app'
OUT = '/workspace/work/screenshots'

ROUTES = ['home','chat','projects','tasks','files','agents','integrations','settings','studio','operations','analytics']

def sheet(bp, cols, tile_w, out_name, pad=10, label_h=26):
    tiles = []
    for r in ROUTES:
        p = os.path.join(SRC, f'{bp}_{r}.png')
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert('RGB')
        w, h = im.size
        th = int(h * (tile_w / w))
        im = im.resize((tile_w, th), Image.LANCZOS)
        tiles.append((r, im))
    if not tiles:
        return None
    th = max(t[1].size[1] for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    W = cols * tile_w + (cols + 1) * pad
    H = rows * (th + label_h) + (rows + 1) * pad
    canvas = Image.new('RGB', (W, H), (12, 16, 38))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 16)
    except Exception:
        font = ImageFont.load_default()
    for i, (name, im) in enumerate(tiles):
        c = i % cols
        rr = i // cols
        x = pad + c * (tile_w + pad)
        y = pad + rr * (th + label_h + pad)
        canvas.paste(im, (x, y + label_h))
        draw.text((x + 4, y + 4), f'{bp} · {name}', fill=(180, 200, 255), font=font)
    out = os.path.join(OUT, out_name)
    canvas.save(out)
    print('wrote', out, canvas.size)
    return out

sheet('desktop', 4, 360, 'sheet_desktop.png')
sheet('tablet', 4, 300, 'sheet_tablet.png')
sheet('mobile', 6, 190, 'sheet_mobile.png')
