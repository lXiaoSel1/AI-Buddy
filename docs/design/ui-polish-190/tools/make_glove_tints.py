"""Builds assets/pet-glove-tint/<id>/ for the 11 approved themes (design surface 5.4).

Each file is the matching assets/pet-glove-v2 cursor frame with only the cuff recoloured to the
theme accent. The v2 artwork itself is never changed. The glove always points up-left, so the
cuff is the far end of the opaque shape along the forearm (about 35 degrees below horizontal);
the last 11 px of a 64 px frame (5.5 px at 32 px) are blended towards the accent with a short
feather. Dark outline pixels keep their colour, and the ring's light/shade steps keep their
relative brightness.

Usage: py -3 make_glove_tints.py <repo>
"""
import json, math, os, sys
from PIL import Image

repo = sys.argv[1]
source = os.path.join(repo, 'assets', 'pet-glove-v2')
out_root = os.path.join(repo, 'assets', 'pet-glove-tint')
palettes_src = open(os.path.join(repo, 'src', 'theme-palettes.mjs'), encoding='utf8').read()
palettes = json.loads(palettes_src[palettes_src.index('Object.freeze([') + len('Object.freeze('):palettes_src.rindex('].map(freeze)') + 1])
ANGLE, DEPTH, FEATHER = math.radians(35), 11, 2


def smooth(edge0, edge1, x):
    t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def tint(image, accent):
    image = image.convert('RGBA')
    w, h = image.size
    scale = w / 64
    ca, sa = math.cos(ANGLE), math.sin(ANGLE)
    px = image.load()
    far = max(x * ca + y * sa for y in range(h) for x in range(w) if px[x, y][3] > 40)
    edge, half = far - DEPTH * scale, FEATHER * scale / 2
    out = image.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not a:
                continue
            weight = smooth(edge - half, edge + half, x * ca + y * sa)
            light = max(r, g, b) / 255
            weight *= smooth(.45, .75, light)
            if weight <= 0:
                continue
            shade = .62 + .38 * min(1, max(0, (light - .6) / .4))
            target = [c * shade for c in accent]
            op[x, y] = tuple(round(o + (t - o) * weight) for o, t in zip((r, g, b), target)) + (a,)
    return out


def hex_rgb(value):
    value = value.lstrip('#')
    return [int(value[i:i + 2], 16) for i in (0, 2, 4)]


names = sorted(n for n in os.listdir(source) if n.endswith('.png'))
for palette in palettes:
    accent = hex_rgb(palette['colors']['accent'])
    folder = os.path.join(out_root, palette['id'])
    os.makedirs(folder, exist_ok=True)
    for name in names:
        tint(Image.open(os.path.join(source, name)), accent).save(os.path.join(folder, name), optimize=True)
    print(palette['id'], palette['colors']['accent'], len(names))
