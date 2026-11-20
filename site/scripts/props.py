"""Draws the home page's section props as small pixel-art PNGs (public/props/).

Every prop is drawn at the gardeners' sprite scale with the island's palette and a dark
outline, so it sits in the same world. Edit a shape here and run:  python3 scripts/props.py
"""
import math
from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "props"

P = {
    "K": (43, 29, 20),      # outline
    "w": (196, 148, 98),    # wood light
    "W": (146, 100, 62),    # wood
    "d": (96, 64, 40),      # wood dark
    "y": (222, 184, 128),   # cut wood
    "g": (246, 214, 112),   # gold light
    "G": (214, 158, 52),    # gold
    "o": (150, 104, 34),    # gold dark
    "e": (160, 186, 104),   # leaf light
    "E": (112, 138, 69),    # leaf
    "n": (72, 95, 46),      # leaf dark
    "r": (184, 84, 60),     # red
    "R": (128, 52, 38),     # red dark
    "c": (240, 228, 200),   # cream
    "C": (205, 189, 152),   # cream shade
    "b": (186, 216, 214),   # glass
    "B": (120, 160, 162),   # glass dark
    "m": (107, 74, 50),     # soil
    "h": (255, 250, 236),   # highlight
}


class Sprite:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [[None] * w for _ in range(h)]

    def set(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < self.w and 0 <= y < self.h else None

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def ellipse(self, cx, cy, rx, ry, c):
        for y in range(self.h):
            for x in range(self.w):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                    self.px[y][x] = c

    def disc_line(self, x0, y0, x1, y1, r, c):
        n = int(max(abs(x1 - x0), abs(y1 - y0)) * 3) + 1
        for i in range(n + 1):
            t = i / n
            cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            for y in range(self.h):
                for x in range(self.w):
                    if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                        self.px[y][x] = c

    def recolor(self, test, c):
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] is not None and test(x, y):
                    self.px[y][x] = c

    def outline(self, c="K"):
        edge = []
        for y in range(self.h):
            for x in range(self.w):
                if self.px[y][x] is None and any(self.get(x + dx, y + dy) not in (None, c) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                    edge.append((x, y))
        for x, y in edge:
            self.px[y][x] = c

    def save(self, name):
        im = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        for y in range(self.h):
            for x in range(self.w):
                k = self.px[y][x]
                if k:
                    im.putpixel((x, y), P[k] + (255,))
        OUT.mkdir(parents=True, exist_ok=True)
        im.save(OUT / f"{name}.png")
        return im


def chest(band, band_light, name):
    s = Sprite(30, 26)
    s.rect(4, 4, 25, 5, "w")          # lid, rounded top
    s.rect(3, 6, 26, 10, "W")
    s.rect(3, 6, 26, 6, "w")
    s.rect(3, 11, 26, 11, "K")         # lid lip
    s.rect(3, 12, 26, 22, "W")         # body
    s.rect(3, 17, 26, 17, "d")         # plank
    s.rect(3, 22, 26, 22, "d")
    s.rect(26, 6, 26, 22, "d")         # shaded side
    s.rect(3, 6, 3, 22, "w")
    for bx in (6, 22):                 # metal bands
        s.rect(bx, 4, bx + 1, 22, band)
        s.rect(bx, 4, bx, 22, band_light)
    s.rect(13, 9, 16, 15, "G")         # lock
    s.rect(13, 9, 16, 9, "g")
    s.rect(14, 12, 15, 13, "K")
    s.outline()
    s.save(name)


def jar_on_stump():
    s = Sprite(22, 32)
    s.rect(3, 21, 18, 29, "W")         # stump
    for x in (6, 10, 14):
        s.rect(x, 22, x, 29, "d")
    s.rect(18, 21, 18, 29, "d")
    s.rect(1, 29, 3, 30, "W")
    s.rect(18, 29, 20, 30, "W")
    s.ellipse(10.5, 20.5, 8.2, 2.6, "y")
    s.ellipse(10.5, 20.5, 4.5, 1.2, "w")
    s.rect(7, 9, 14, 19, "b")          # jar
    s.rect(8, 7, 13, 8, "b")
    s.rect(9, 6, 12, 6, "B")
    s.rect(8, 3, 13, 5, "w")           # cork
    s.rect(8, 5, 13, 5, "W")
    s.rect(8, 9, 8, 17, "h")           # glint
    s.rect(14, 9, 14, 19, "B")
    s.rect(7, 19, 14, 19, "B")
    s.rect(10, 12, 13, 17, "c")        # paper tag with a question mark
    for x, y in ((11, 13), (12, 13), (12, 14), (11, 15), (11, 17)):
        s.set(x, y, "K")
    s.outline()
    s.save("jar")


def seedlings():
    s = Sprite(28, 24)
    s.rect(3, 13, 24, 21, "W")         # crate
    s.rect(3, 13, 24, 14, "w")
    s.rect(3, 17, 24, 17, "d")
    s.rect(3, 21, 24, 21, "d")
    s.rect(3, 13, 4, 21, "d")
    s.rect(23, 13, 24, 21, "d")
    s.rect(4, 11, 23, 12, "m")         # soil
    for x, top in ((8, 6), (14, 4), (19, 7)):
        s.rect(x, top, x, 11, "E")
        s.rect(x - 2, top + 2, x - 1, top + 2, "e")
        s.rect(x + 1, top + 1, x + 2, top + 1, "e")
        s.set(x - 2, top + 3, "n")
        s.set(x + 2, top + 2, "n")
    s.ellipse(14, 2.5, 2.2, 2.2, "G")  # a gold coin bud: early backers earn a share
    s.set(13, 2, "g")
    s.outline()
    s.save("seedlings")


def goal_sign():
    s = Sprite(20, 38)
    s.rect(9, 21, 10, 36, "W")         # post
    s.rect(10, 21, 10, 36, "d")
    s.rect(2, 2, 17, 22, "W")          # board
    s.rect(3, 3, 16, 21, "w")
    s.rect(7, 4, 12, 18, "K")          # tube
    s.rect(8, 5, 11, 17, "c")
    s.ellipse(9.5, 19.5, 2.6, 2.4, "K")
    s.ellipse(9.5, 19.5, 1.7, 1.5, "r")
    s.rect(13, 5, 15, 5, "G")          # the goal mark
    s.rect(13, 11, 14, 11, "d")
    s.rect(4, 11, 5, 11, "d")
    s.outline()
    s.save("goal-sign")
    return {"x": 8, "y": 5, "w": 4, "h": 13}  # where the fill goes


def bunting():
    s = Sprite(76, 22)
    colors = ["r", "G", "E", "c"]
    pts = []
    for i, x in enumerate(range(4, 72, 8)):
        t = (x - 2) / 70
        y = 2 + 9 * t + 4 * math.sin(math.pi * t)
        pts.append((x, y))
        c = colors[i % 4]
        for k in range(6):
            half = max(0, 3 - k * 0.55)
            s.rect(int(x - half), int(y + 1 + k), int(x + half), int(y + 1 + k), c)
    s.outline()
    for x in range(2, 74):             # the string, drawn over the outline
        t = (x - 2) / 70
        s.set(x, 2 + 9 * t + 4 * math.sin(math.pi * t), "K")
    s.save("bunting")


def boomerang():
    s = Sprite(26, 18)
    s.disc_line(4, 13, 13, 4, 1.8, "w")
    s.disc_line(13, 4, 22, 13, 1.8, "w")
    s.recolor(lambda x, y: (x - 13) ** 2 + (y - 4.5) ** 2 <= 9, "r")
    s.recolor(lambda x, y: (x - 4) ** 2 + (y - 13) ** 2 <= 4 or (x - 22) ** 2 + (y - 13) ** 2 <= 4, "G")
    s.recolor(lambda x, y: y >= 12 and 6 <= x <= 20 and s.get(x, y) == "w", "W")
    s.outline()
    s.save("boomerang")


def balloon():
    s = Sprite(32, 46)
    s.ellipse(16, 14, 12.5, 12.5, "c")
    for y in range(20, 30):            # taper toward the mouth
        half = 12 - (y - 20) * 0.75
        s.rect(int(16 - half), y, int(16 + half), y, "c")
    s.recolor(lambda x, y: ((x - 2) // 4) % 2 == 0, "r")
    s.recolor(lambda x, y: x >= 22 and s.get(x, y) == "r", "R")
    s.recolor(lambda x, y: x >= 22 and s.get(x, y) == "c", "C")
    s.recolor(lambda x, y: x <= 7 and y <= 14 and s.get(x, y) == "c", "h")
    s.rect(11, 36, 21, 42, "W")        # basket
    s.rect(11, 36, 21, 36, "w")
    s.rect(11, 39, 21, 39, "d")
    s.rect(14, 34, 17, 35, "G")        # coins in the basket
    s.set(15, 34, "g")
    s.outline()
    for y in range(30, 36):            # ropes
        s.set(12 + (y - 30) * 0.15, y, "K")
        s.set(20 - (y - 30) * 0.15, y, "K")
    s.save("balloon")


def signpost():
    s = Sprite(36, 36)
    s.rect(16, 5, 18, 33, "W")         # post
    s.rect(18, 5, 18, 33, "d")
    s.rect(15, 3, 19, 4, "w")
    s.rect(5, 9, 16, 14, "c")          # "back one", pointing left
    s.rect(4, 10, 4, 13, "c")
    s.rect(3, 11, 3, 12, "c")
    s.rect(5, 14, 16, 14, "C")
    s.rect(7, 11, 9, 11, "d"); s.rect(11, 11, 14, 11, "d")
    s.rect(18, 17, 29, 22, "e")        # "start one", pointing right
    s.rect(30, 18, 30, 21, "e")
    s.rect(31, 19, 31, 20, "e")
    s.rect(18, 22, 29, 22, "E")
    s.rect(20, 19, 23, 19, "n"); s.rect(25, 19, 27, 19, "n")
    s.rect(13, 32, 21, 33, "E")        # grass at the foot
    s.set(12, 31, "e"); s.set(22, 31, "e"); s.set(14, 30, "e"); s.set(20, 30, "E")
    s.outline()
    s.save("signpost")


if __name__ == "__main__":
    chest("E", "e", "chest-match")
    chest("G", "g", "chest-bonus")
    jar_on_stump()
    seedlings()
    print("goal fill", goal_sign())
    bunting()
    boomerang()
    balloon()
    signpost()
    print("wrote", sorted(p.name for p in OUT.glob("*.png")))
