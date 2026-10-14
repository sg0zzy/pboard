"""Generate Android-only launcher assets from the unchanged repository logo.

Requires Pillow only when regenerating; normal app builds use the generated PNGs.
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageOps

app = Path(__file__).resolve().parents[1]
source = app.parents[1] / 'icons' / 'logo.png'
output = app / 'android/app/src/main/res/drawable-nodpi'
output.mkdir(parents=True, exist_ok=True)
logo = Image.open(source).convert('RGBA')
# 108dp adaptive layer at xxxhdpi. Padding keeps the artwork inside launcher masks.
size, artwork_size = 432, 256
artwork = logo.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
foreground = Image.new('RGBA', (size, size))
foreground.alpha_composite(artwork, ((size - artwork_size) // 2,) * 2)
foreground.save(output / 'pboard_logo_image.png', optimize=True, compress_level=9)

# Keep the dark outlines and green check readable when Android supplies one tint.
# Remove pale fills from the mask so the check remains distinct from the P's center.
ink = ImageOps.grayscale(logo).point(lambda value: max(0, min(255, round((230 - value) * 255 / 100))))
alpha = ImageChops.multiply(logo.getchannel('A'), ink)
monochrome = Image.new('RGBA', logo.size, 'white')
monochrome.putalpha(alpha)
monochrome = monochrome.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
mask = Image.new('RGBA', (size, size))
mask.alpha_composite(monochrome, ((size - artwork_size) // 2,) * 2)
mask.save(output / 'pboard_logo_monochrome_image.png', optimize=True, compress_level=9)
for path in sorted(output.glob('pboard_logo*')):
    print(f'{path.name}: {size} × {size}, {path.stat().st_size:,} bytes')
