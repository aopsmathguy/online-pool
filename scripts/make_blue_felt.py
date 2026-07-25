#!/usr/bin/env python3
"""Create a blue felt texture from the scanned green baize.

The cloth colour lives in assets/felt/color.jpg (green). 9-ball is played on
blue cloth, so we HUE-ROTATE the green to blue in HSV: shift every pixel's hue
by a constant so the cloth's average hue lands on a tournament blue, leaving
saturation and value (the weave's tone and shading) untouched. Output:
assets/felt/color2.jpg.
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "assets", "felt", "color.jpg")
DST = os.path.join(HERE, "assets", "felt", "color2.jpg")

# Target hue for the blue cloth, in degrees (0=red, 120=green, 240=blue).
TARGET_HUE_DEG = 220          # a slightly cyan tournament blue
to255 = lambda deg: round(deg / 360 * 255) % 256

img = Image.open(SRC).convert("RGB")
h, s, v = img.convert("HSV").split()

# Mean hue of the source, weighted by saturation so near-grey pixels (whose hue
# is meaningless noise) don't drag the average around.
hist = h.histogram()
sat = s.histogram()  # not hue-weighted; use hue histogram weighted by pixel count
px = list(h.getdata())
sd = list(s.getdata())
num = sum(hp * sp for hp, sp in zip(px, sd))
den = sum(sd) or 1
mean_h = num / den

delta = (to255(TARGET_HUE_DEG) - mean_h) % 256
h_shifted = h.point(lambda p: (p + round(delta)) % 256)

blue = Image.merge("HSV", (h_shifted, s, v)).convert("RGB")
blue.save(DST, quality=95)

print(f"source mean hue = {mean_h/255*360:.1f} deg,  shift {delta/255*360:.1f} deg "
      f"-> {TARGET_HUE_DEG} deg")
print(f"wrote {DST}  ({img.size[0]}x{img.size[1]}, {os.path.getsize(DST)} bytes)")
