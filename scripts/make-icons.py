# 拡張のアイコンを生成する (依存なし)。使い方: python3 scripts/make-icons.py [プレビュー.png]
# デザイン: 暗い角丸の正方形に、左のサイドバーのパネル、その中に 4 色のお気に入りのタイル、右に弧 (Arc)。
# 4 倍のスーパーサンプリングで縁を滑らかにする。描画関数は make-hero.py からも使う (import してもアイコンは書き出さない)。
import zlib, struct, math, sys, os

def png(size, pixels):  # pixels: RGBA のバイト列 (size*size*4)
    raw = b"".join(b"\x00" + bytes(pixels[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b"")

def rounded_rect(x, y, x0, y0, x1, y1, r):
    # 角丸矩形の内側なら True (座標は 0..1)
    if x < x0 or x > x1 or y < y0 or y > y1: return False
    cx = min(max(x, x0 + r), x1 - r); cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def arc_band(x, y, cx, cy, radius, width, a0, a1):
    # 円弧の帯 (角度は度、画面座標で時計回り)。端は丸める
    d = math.hypot(x - cx, y - cy)
    if abs(d - radius) > width / 2: return False
    ang = math.degrees(math.atan2(y - cy, x - cx)) % 360
    lo, hi = a0 % 360, a1 % 360
    inside = lo <= ang <= hi if lo <= hi else (ang >= lo or ang <= hi)
    if inside: return True
    for a in (a0, a1):  # 丸い端
        ex, ey = cx + radius * math.cos(math.radians(a)), cy + radius * math.sin(math.radians(a))
        if math.hypot(x - ex, y - ey) <= width / 2: return True
    return False

def mix(c, w, a): return [c[i] + (w[i] - c[i]) * a for i in range(3)]

def shade(x, y):
    # デザイン: 暗い地 (藍がかった黒のグラデーション) に、左のサイドバーのパネル、その中に 4 色のお気に入りのタイル、右に弧 (Arc)
    t = (x + y) / 2
    c = [30 + (52 - 30) * t, 33 + (56 - 33) * t, 48 + (80 - 48) * t]
    if rounded_rect(x, y, 0.13, 0.13, 0.87, 0.87, 0.12): c = mix(c, [255, 255, 255], 0.09)   # 内側の面
    if rounded_rect(x, y, 0.13, 0.13, 0.43, 0.87, 0.12): c = mix(c, [255, 255, 255], 0.14)   # サイドバーのパネル
    for i, col in enumerate([(255, 99, 99), (255, 192, 64), (82, 204, 124), (96, 148, 255)]):
        ty = 0.2 + i * 0.165
        if rounded_rect(x, y, 0.195, ty, 0.365, ty + 0.125, 0.04): c = list(col)             # お気に入り (4 色)
    if arc_band(x, y, 0.47, 0.5, 0.27, 0.1, -58, 58): c = [238, 241, 255]                     # 弧 (Arc)
    return c

def render(size, ss=4):
    out = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            acc = [0.0, 0.0, 0.0]; cov = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size; y = (py + (sy + 0.5) / ss) / size
                    if not rounded_rect(x, y, 0.0, 0.0, 1.0, 1.0, 0.225):
                        continue
                    c = shade(x, y)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; cov += 1
            i = (py * size + px) * 4
            if cov:
                for k in range(3): out[i + k] = round(acc[k] / cov)
                out[i + 3] = round(255 * cov / (ss * ss))
    return out

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 32, 48, 128):
        open(os.path.join(here, "..", "icons", f"icon{s}.png"), "wb").write(png(s, render(s)))
    print("icons written: 16, 32, 48, 128")

    # プレビュー: 128 / 48 / 32 / 16 を 4 倍に拡大して横に並べる
    if len(sys.argv) > 1:
        sizes = (128, 48, 32, 16); scale = 4; gap = 24
        W = sum(s * scale for s in sizes) + gap * (len(sizes) + 1); H = 128 * scale + gap * 2
        canvas = bytearray(W * H * 4)
        for i in range(W * H): canvas[i*4:i*4+4] = bytes((238, 240, 246, 255))
        x0 = gap
        for s in sizes:
            img = render(s); y0 = gap + (128 * scale - s * scale) // 2
            for y in range(s * scale):
                for x in range(s * scale):
                    src = ((y // scale) * s + (x // scale)) * 4; a = img[src + 3] / 255
                    dst = ((y0 + y) * W + x0 + x) * 4
                    for k in range(3): canvas[dst + k] = round(img[src + k] * a + canvas[dst + k] * (1 - a))
            x0 += s * scale + gap
        open(sys.argv[1], "wb").write(png(W, canvas) if W == H else b"")
        # 正方形でない場合のために別途書き出し
        raw = b"".join(b"\x00" + bytes(canvas[y * W * 4:(y + 1) * W * 4]) for y in range(H))
        ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b""))
        print("preview:", sys.argv[1])

if __name__ == "__main__":
    main()
