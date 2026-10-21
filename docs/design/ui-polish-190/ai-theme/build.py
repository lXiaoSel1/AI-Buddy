"""Inline every preview asset (art/, now/, gen/web/) into ai-buddy-themes.html as one JSON block."""
import base64, glob, json, os, pathlib

root = pathlib.Path(__file__).parent
os.chdir(root)
src = (root / 'index.html').read_text(encoding='utf-8')
files = sorted(glob.glob('art/*.webp') + glob.glob('now/*.webp') + glob.glob('gen/web/*.webp'))
assets = {f.replace(os.sep, '/'): base64.b64encode(open(f, 'rb').read()).decode() for f in files}
assert src.count('<!--ASSETS-->') == 1
out = src.replace('<!--ASSETS-->', '<script id="assets" type="application/json">' + json.dumps(assets, separators=(',', ':')) + '</script>')
(root / 'ai-buddy-themes.html').write_text(out, encoding='utf-8')
print('built', len(assets), 'assets', os.path.getsize('ai-buddy-themes.html'), 'bytes')
