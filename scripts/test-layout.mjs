// layout.js の単体テスト。使い方: node scripts/test-layout.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { pinColumns, tileSize } = require("../layout.js");

const MIN = 44, MAX = 56, GAP = 8; // sidepanel.css の --pin-min / --pin-max / --pin-gap と同じ
// 幅 200〜800px のどこでも、タイルは min 以上、かつ (min を割らずに済む限り) max 以下
for (let w = 200; w <= 800; w++) {
  const n = pinColumns(w, MIN, MAX, GAP);
  const s = tileSize(w, n, GAP);
  assert.ok(s >= MIN - 1e-9, `width ${w}: tile ${s} below min with ${n} cols`);
  // max を守るには min を割る列数が必要な幅では、min を優先して max を少し超えるのを許す (超過は 1 列分の余りまで)
  const conflict = tileSize(w, n + 1, GAP) < MIN;
  assert.ok(s <= MAX + 1e-9 || conflict, `width ${w}: tile ${s} exceeds max with ${n} cols although ${n + 1} cols would fit`);
  assert.ok(s < MAX + MIN, `width ${w}: tile ${s} far above max`);
  // 1 列減らすと max を超える (= できるだけ大きいタイル)
  if (n > 1) assert.ok(tileSize(w, n - 1, GAP) > MAX, `width ${w}: ${n - 1} cols would still fit`);
}
// 典型的なパネル幅 (中身の幅)
const table = [226, 296, 376, 456].map((w) => [w, pinColumns(w, MIN, MAX, GAP), Math.round(tileSize(w, pinColumns(w, MIN, MAX, GAP), GAP))]);
console.log("width -> cols, tile:", table.map(([w, n, s]) => `${w}px -> ${n} x ${s}px`).join(", "));
// 幅が min に満たないときは 1 列
assert.equal(pinColumns(30, MIN, MAX, GAP), 1);
// 不正な入力でも 1 列
assert.equal(pinColumns(0, MIN, MAX, GAP), 1);
assert.equal(pinColumns(300, 60, 50, GAP), 1);
console.log("layout tests passed");
