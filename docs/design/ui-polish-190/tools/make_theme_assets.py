"""Builds assets/theme/<id>/ for the 11 approved themes.

bg.webp / orn.webp  - Codex-painted backdrop and portrait-accessory ornament (design sources, copied as-is)
head.webp           - 160 px head crop centred between the eyes (faces.py coordinates)
portrait.webp       - the Galgame portrait trimmed and fitted into 300x480, bottom-aligned (overview card)
icon-256.png        - round head on a light tint of the theme accent, for window icons
tray-16/24/32.png   - the same, rendered at tray sizes

The eye coordinates in faces.py were measured on 300x360 previews of each idle still: the
still's opaque bounding box scaled to fit and bottom-aligned. Here they are mapped back onto the
576x624 idle still from the release resources, so heads and icons are cut at full resolution.

Usage: py -3 make_theme_assets.py <release build>/assets <repo>/assets/theme
"""
import json, os, re, shutil, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DESIGN = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(DESIGN, 'ui-design'))
import faces  # noqa: E402

resources, out = sys.argv[1], sys.argv[2]
palettes_src = open(os.path.join(DESIGN, '..', '..', '..', 'src', 'theme-palettes.mjs'), encoding='utf8').read()
palettes = {p['id']: p for p in json.loads(palettes_src[palettes_src.index('Object.freeze([') + len('Object.freeze('):palettes_src.rindex('].map(freeze)') + 1])}
manifest = json.load(open(os.path.join(resources, 'character-sequence-manifest.json'), encoding='utf8'))


def still_of(theme_id):
    frames = manifest[theme_id]['idle']['staticFrames']
    first = frames['0'] if isinstance(frames, dict) else frames[0]
    return Image.open(os.path.join(os.path.dirname(resources), first['file'])).convert('RGBA')


def head_crop(theme_id):
    still = still_of(theme_id)
    x0, y0, x1, y1 = still.getchannel('A').getbbox()
    bw, bh = x1 - x0, y1 - y0
    s = min(300 / bw, 360 / bh)
    left, top = (300 - bw * s) / 2, 360 - bh * s
    cx, cy, d = faces.circle(theme_id)
    sx, sy, sd = x0 + (cx - left) / s, y0 + (cy - top) / s, d / s
    box = tuple(round(v) for v in (sx - sd / 2, sy - sd / 2, sx + sd / 2, sy + sd / 2))
    canvas = Image.new('RGBA', still.size, (0, 0, 0, 0))
    canvas.alpha_composite(still)
    return canvas.crop(box)  # areas outside the still come back transparent


def portrait(theme_id):
    """Same framing as the design preview: alpha-trimmed, contained in 300x480, centred and bottom-aligned."""
    path = os.path.join(resources, 'maid-left.webp') if theme_id == 'deepseek' else os.path.join(resources, 'characters', 'v167', 'gpt' if theme_id == 'chatgpt' else theme_id, 'portrait.png')
    image = Image.open(path).convert('RGBA')
    image = image.crop(image.getchannel('A').getbbox())
    scale = min(300 / image.width, 480 / image.height)
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    canvas = Image.new('RGBA', (300, 480), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((300 - image.width) // 2, 480 - image.height))
    return canvas


def hex_rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def round_icon(head, theme_id, size):
    """Supersampled circle: light accent tint behind the head, a hairline ring, anti-aliased edge."""
    k = 4
    big = size * k
    accent = hex_rgb(palettes[theme_id]['colors']['accent'])
    tint = tuple(round(a * .22 + 255 * .78) for a in accent)
    plate = Image.new('RGBA', (big, big), tint + (255,))
    plate.alpha_composite(head.resize((big, big), Image.LANCZOS))
    ring = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse((k // 2, k // 2, big - k // 2 - 1, big - k // 2 - 1), outline=accent + (110,), width=max(k, big // 64))
    plate.alpha_composite(ring)
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    plate.putalpha(mask)
    return plate.resize((size, size), Image.LANCZOS)


gen = os.path.join(DESIGN, 'ai-theme', 'gen', 'web')
for theme_id in faces.EYES:
    folder = os.path.join(out, theme_id)
    os.makedirs(folder, exist_ok=True)
    shutil.copyfile(os.path.join(gen, theme_id + '-bg.webp'), os.path.join(folder, 'bg.webp'))
    shutil.copyfile(os.path.join(gen, theme_id + '-orn.webp'), os.path.join(folder, 'orn.webp'))
    head = head_crop(theme_id)
    head.resize((160, 160), Image.LANCZOS).save(os.path.join(folder, 'head.webp'), 'WEBP', quality=90, method=6)
    portrait(theme_id).save(os.path.join(folder, 'portrait.webp'), 'WEBP', quality=88, method=6)
    round_icon(head, theme_id, 256).save(os.path.join(folder, 'icon-256.png'), optimize=True)
    for size in (16, 24, 32):
        round_icon(head, theme_id, size).save(os.path.join(folder, 'tray-%d.png' % size), optimize=True)
    print(theme_id, 'head crop', head.size)
