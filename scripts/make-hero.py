# README のヒーロー画像 (assets/hero.png) を生成する (依存なし)。使い方: python3 scripts/make-hero.py [出力.png]
# デザイン: アイコンと同じ藍がかった黒のグラデーションに、大きな弧 (Arc) を左右に 1 本ずつうっすら敷き、
# 中央に 288px のアイコンを柔らかい影付きで置く。描画関数は make-icons.py から借りる (アイコンの書き出しは走らない)。
import importlib.util, math, os, struct, sys, zlib

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("make_icons", os.path.join(here, "make-icons.py"))
mi = importlib.util.module_from_spec(spec); spec.loader.exec_module(mi)

W, H, ICON, SS = 1440, 480, 288, 2

def png(w, h, pixels):  # pixels: RGBA のバイト列 (w*h*4)
    raw = b"".join(b"\x00" + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b"")

def shadow(px, py, x0, y0, x1, y1, r, soft):
    # 角丸矩形までの符号付き距離から、柔らかい影の濃さ (0..1) を返す
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2; hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    d = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
    return 1.0 if d <= 0 else max(0.0, 1 - d / soft) ** 2

icon = mi.render(ICON)
ix0, iy0 = (W - ICON) // 2, (H - ICON) // 2
canvas = bytearray(W * H * 4)
for py in range(H):
    for px in range(W):
        t = (px / W) * 0.7 + (py / H) * 0.3
        c = [30 + (52 - 30) * t, 33 + (56 - 33) * t, 48 + (80 - 48) * t]
        cov = 0  # 弧 (Arc) を左右対称に 2 本。2x2 のスーパーサンプリングで縁を滑らかに
        for sy in range(SS):
            for sx in range(SS):
                x, y = px + (sx + 0.5) / SS, py + (sy + 0.5) / SS
                if mi.arc_band(x, y, W / 2, H / 2, H * 0.78, 10, -50, 50) or mi.arc_band(x, y, W / 2, H / 2, H * 0.78, 10, 130, 230): cov += 1
        if cov: c = mi.mix(c, [238, 241, 255], 0.16 * cov / (SS * SS))
        v = math.hypot((px - W / 2) / W, (py - H / 2) / H)                                   # 周辺減光
        c = mi.mix(c, [0, 0, 0], min(1.0, v * 0.9) * 0.35)
        s = shadow(px, py, ix0, iy0 + 10, ix0 + ICON, iy0 + ICON + 10, ICON * 0.225, 36)  # アイコンの影
        if s: c = mi.mix(c, [0, 0, 0], 0.5 * s)
        if ix0 <= px < ix0 + ICON and iy0 <= py < iy0 + ICON:                                # アイコン
            src = ((py - iy0) * ICON + (px - ix0)) * 4; a = icon[src + 3] / 255
            c = [icon[src + k] * a + c[k] * (1 - a) for k in range(3)]
        i = (py * W + px) * 4
        canvas[i:i + 4] = bytes((round(c[0]), round(c[1]), round(c[2]), 255))

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "assets", "hero.png")
open(out, "wb").write(png(W, H, canvas))
print("hero:", out)
