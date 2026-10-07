"""生成 Highland Note 的应用图标源图（1024x1024，带透明圆角）。

图形沿用标题栏那个山形标记，配色用应用主题的紫色。
"""
from PIL import Image, ImageDraw

SIZE = 1024
RADIUS = 232
OUT = r"E:\Program\rs\highland_note\src-tauri\icon-source.png"

# ---- 背景：圆角方块 + 斜向渐变 ----
gradient = Image.new("RGBA", (SIZE, SIZE))
top = (167, 139, 250)      # --accent #a78bfa
bottom = (109, 40, 217)    # 深一档的紫
for y in range(SIZE):
    for_x = y / (SIZE - 1)
    t = for_x ** 0.85
    color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    for x in range(0, SIZE, 8):          # 横向分块写入，够用且快
        pass
    gradient.paste(color + (255,), (0, y, SIZE, y + 1))

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=255)

icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
icon.paste(gradient, (0, 0), mask)

draw = ImageDraw.Draw(icon)

# ---- 山形：和顶栏 logo 同一条折线，等比放大居中 ----
path = [(2.5, 19.5), (9.0, 8.0), (13.0, 14.5), (15.5, 11.0), (21.5, 19.5)]
scale = 30.0
offset_x = (SIZE - 24 * scale) / 2
offset_y = (SIZE - 24 * scale) / 2 + 12
points = [(offset_x + x * scale, offset_y + y * scale) for x, y in path]

draw.line(points, fill=(255, 255, 255, 255), width=54, joint="curve")
for point in points:
    r = 27
    draw.ellipse((point[0] - r, point[1] - r, point[0] + r, point[1] + r), fill=(255, 255, 255, 255))

# ---- 右上角一轮小月亮，呼应配色 ----
moon = (760, 300, 880, 420)
draw.ellipse(moon, fill=(253, 230, 138, 255))

icon.save(OUT)
print("saved", OUT, icon.size)
