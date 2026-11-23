// color.js の単体テスト。実データ (Arc のアイコン) があれば代表色を計算し、タイルのプレビュー PNG を書き出す。
// 使い方: node scripts/test-color.mjs [プレビューの出力先.png]
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { iconTint, dominantHue, hostHue } = require("../color.js");
const { parseArcSidebar, arcFaviconFileName } = require("../arc-import.js");

// --- 合成データ ---
const px = (n, rgba) => Array.from({ length: n }, () => rgba).flat();
const near = (a, b, tol = 12) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= tol;

assert.equal(dominantHue(Uint8ClampedArray.from(px(100, [0, 0, 0, 255]))), null, "black icon -> null");
assert.equal(dominantHue(Uint8ClampedArray.from(px(100, [255, 255, 255, 255]))), null, "white icon -> null");
assert.equal(dominantHue(Uint8ClampedArray.from(px(100, [128, 128, 128, 255]))), null, "gray icon -> null");
assert.equal(dominantHue(Uint8ClampedArray.from(px(100, [255, 0, 0, 0]))), null, "fully transparent -> null");
let r = dominantHue(Uint8ClampedArray.from(px(100, [220, 30, 30, 255])));
assert.ok(r && near(r.h, 0), `red -> ~0, got ${JSON.stringify(r)}`);
r = dominantHue(Uint8ClampedArray.from([...px(70, [255, 255, 255, 255]), ...px(30, [30, 100, 220, 255])]));
assert.ok(r && near(r.h, 219), `blue logo on white -> ~219, got ${JSON.stringify(r)}`);
// 少量の鮮やかなオレンジ + 大量の黒 (黒は無視されオレンジが選ばれる)
r = dominantHue(Uint8ClampedArray.from([...px(85, [10, 10, 10, 255]), ...px(15, [245, 130, 20, 255])]));
assert.ok(r && near(r.h, 29), `orange accent on black -> ~29, got ${JSON.stringify(r)}`);
// ごく僅かな色 (3% 未満) は無彩色扱い
r = dominantHue(Uint8ClampedArray.from([...px(99, [0, 0, 0, 255]), ...px(1, [0, 200, 0, 255])]));
assert.equal(r, null, "tiny color fraction -> null");
// 色相 0° をまたぐ赤系 (350° と 5°) は円周平均で 0° 付近になる (180° にならない)
r = dominantHue(Uint8ClampedArray.from([...px(50, [230, 30, 70, 255]), ...px(50, [230, 50, 30, 255])]));
assert.ok(r && near(r.h, 0, 15), `reds around 0 -> ~0, got ${JSON.stringify(r)}`);
// 彩度は 35〜90 に収める
r = dominantHue(Uint8ClampedArray.from(px(100, [255, 0, 0, 255])));
assert.ok(r.s <= 90 && r.s >= 35, `saturation clamped, got ${r.s}`);
assert.equal(hostHue("https://www.example.com/"), hostHue("https://example.com/x"), "hostHue ignores www and path");
// 色相は 0〜359 に収まる
for (const c of [[255, 0, 1], [255, 1, 0], [250, 0, 5]]) {
  const t = dominantHue(Uint8ClampedArray.from(px(50, [...c, 255])));
  assert.ok(t.h >= 0 && t.h < 360, `hue in range for ${c}: ${t.h}`);
}
// 無彩色アイコンの明暗
assert.deepEqual(iconTint(Uint8ClampedArray.from([...px(60, [255, 255, 255, 255]), ...px(40, [0, 0, 0, 0])])), { kind: "neutral", tone: "light" }, "white icon -> light");
assert.deepEqual(iconTint(Uint8ClampedArray.from(px(60, [15, 15, 15, 255]))), { kind: "neutral", tone: "dark" }, "black icon -> dark");
assert.deepEqual(iconTint(Uint8ClampedArray.from(px(60, [128, 128, 128, 255]))), { kind: "neutral", tone: "mid" }, "gray icon -> mid");
// 4 色が均等な多色アイコンは無彩色
assert.equal(iconTint(Uint8ClampedArray.from([...px(25, [230, 40, 40, 255]), ...px(25, [40, 200, 60, 255]), ...px(25, [40, 90, 230, 255]), ...px(25, [240, 200, 30, 255])])).kind, "neutral", "evenly multicolor -> neutral");
console.log("color tests passed");

// --- PNG (8-bit RGBA, 非インターレース) の最小デコーダとエンコーダ ---
function decodePng(buf) {
  let off = 8, w = 0, h = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("unsupported PNG");
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(w * h * 4), stride = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0, b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? out[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  return { w, h, data: out };
}
function encodePng(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255].map(Math.round);
}

// --- 実データ: Arc のアイコンで代表色を計算し、ライト / ダークのタイルを並べたプレビューを書き出す ---
const arc = join(homedir(), "Library/Application Support/Arc");
const iconDir = join(arc, "SidebarItemsFaviconCache");
if (existsSync(iconDir)) {
  const files = readdirSync(iconDir);
  let order = files;
  try {
    const p = parseArcSidebar(readFileSync(join(arc, "StorableSidebar.json"), "utf8"));
    const favs = [...p.favorites, ...p.spaces.flatMap((s) => s.pins)].map((x) => arcFaviconFileName(x.id)).filter((n) => files.includes(n));
    order = [...favs, ...files.filter((n) => !favs.includes(n))];
  } catch { /* 並び順は任意 */ }
  // キャッシュには RGB・16bit の PNG や同期中の一時ファイルも混ざるので、8bit RGBA 非インターレースのものだけデコードする
  const isRgba8 = (b) => b.length > 33 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a
    && b.toString("ascii", 12, 16) === "IHDR" && b[24] === 8 && b[25] === 6 && b[28] === 0;
  const icons = order.map((n) => readFileSync(join(iconDir, n))).filter(isRgba8).slice(0, 16).map(decodePng);
  const tints = icons.map((ic) => iconTint(ic.data));
  console.log("real icons:", tints.map((t) => (t.kind === "hue" ? `h${t.h}/s${t.s}` : `neutral-${t.tone}`)).join("  "));

  // タイル 56px、間隔 8px、4 列。上段: ライト、下段: ダーク (sidepanel.css の .pin.tinted と同じ明度)
  const T = 56, G = 8, COLS = 4, rows = Math.ceil(icons.length / COLS);
  const W = COLS * (T + G) + G, H = 2 * (rows * (T + G) + G);
  const img = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, y0, w, h, [r, g, b]) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255; } };
  fill(0, 0, W, H / 2, [238, 240, 246]); fill(0, H / 2, W, H / 2, [28, 30, 38]);
  icons.forEach((ic, i) => {
    for (const dark of [false, true]) {
      const t = tints[i];
      // sidepanel.css の .pin.tinted / .pin.tone-light / .pin.tone-dark と同じ値
      const bg = t.kind === "hue" ? hsl(t.h, dark ? t.s * 0.55 : t.s * 0.85, dark ? 22 : 91)
        : t.tone === "light" && !dark ? hsl(225, 10, 38)
        : t.tone === "dark" && dark ? hsl(225, 12, 82)
        : dark ? hsl(225, 10, 20) : [255, 255, 255];
      const x0 = G + (i % COLS) * (T + G), y0 = (dark ? H / 2 : 0) + G + Math.floor(i / COLS) * (T + G);
      fill(x0, y0, T, T, bg);
      const ox = x0 + (T - 32) / 2, oy = y0 + (T - 32) / 2;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const s = (y * 32 + x) * 4, a = ic.data[s + 3] / 255, d = ((oy + y) * W + ox + x) * 4;
        for (let k = 0; k < 3; k++) img[d + k] = Math.round(ic.data[s + k] * a + img[d + k] * (1 - a));
      }
    }
  });
  const out = process.argv[2];
  if (out) { writeFileSync(out, encodePng(W, H, img)); console.log("preview written:", out); }
}
