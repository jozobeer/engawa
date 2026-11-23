// アイコンの画素から、ピンのタイル背景に使う代表色 (色相・彩度) を選ぶ純粋関数。
// sidepanel からはグローバル関数として、Node (テスト) からは module.exports として使う。
//
// 方針 (Arc のお気に入りタイルに近い見た目を狙う):
//  - 半透明・ほぼ白・ほぼ黒・灰色の画素は無視する (背景や輪郭の色を拾わない)
//  - 残った画素を色相 10° ごとに集計し、鮮やかで明るさが中間の画素ほど重く数える
//  - 隣り合う区間と合わせて最も重い色相を選び、その範囲の画素の平均 (円周平均) をとる
//  - 色の付いた画素がごく少ないアイコン (GitHub の猫など) や、どの色も目立たない多色アイコン (Slack など) は
//    無彩色にする。そのとき、アイコン自体が明るいか暗いかも返し、白いアイコンが白いタイルに、
//    黒いアイコンが暗いタイルに埋もれないよう呼び出し側でタイルの明るさを変えられるようにする

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== "undefined" ? self : globalThis, function () {
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  const BUCKETS = 36;

  // rgba: RGBA の並び (Uint8ClampedArray など)。戻り値: { h: 0-359, s: 0-100 } または null
  function dominantHue(rgba) {
    return iconTint(rgba).kind === "hue" ? (({ h, s }) => ({ h, s }))(iconTint(rgba)) : null;
  }

  // 戻り値: { kind: "hue", h, s } または { kind: "neutral", tone: "light" | "dark" | "mid" }
  //  tone: 不透明な画素の平均の明るさ (light: 白っぽいアイコン、dark: 黒っぽいアイコン)
  function iconTint(rgba) {
    const weight = new Float64Array(BUCKETS);
    const sinSum = new Float64Array(BUCKETS);
    const cosSum = new Float64Array(BUCKETS);
    const satSum = new Float64Array(BUCKETS);
    let opaque = 0;
    let colorful = 0;
    let lightSum = 0;
    for (let i = 0; i + 3 < rgba.length; i += 4) {
      if (rgba[i + 3] < 128) continue;
      opaque += 1;
      const [h, s, l] = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2]);
      lightSum += l;
      if (l < 0.12 || l > 0.92 || s < 0.2) continue;
      colorful += 1;
      const w = s * (1 - Math.abs(2 * l - 1)); // 彩度 × 中間の明るさほど重い
      const b = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
      const rad = (h * Math.PI) / 180;
      weight[b] += w;
      sinSum[b] += Math.sin(rad) * w;
      cosSum[b] += Math.cos(rad) * w;
      satSum[b] += s * w;
    }
    const meanL = opaque ? lightSum / opaque : 0.5;
    const neutral = { kind: "neutral", tone: meanL > 0.75 ? "light" : meanL < 0.3 ? "dark" : "mid" };
    if (!opaque || colorful / opaque < 0.03) return neutral;

    let best = -1, bestW = 0, total = 0;
    for (let b = 0; b < BUCKETS; b++) {
      total += weight[b];
      const w = weight[(b + BUCKETS - 1) % BUCKETS] + weight[b] + weight[(b + 1) % BUCKETS];
      if (w > bestW) { bestW = w; best = b; }
    }
    if (best < 0 || bestW <= 0) return neutral;
    // どの色も全体の 4 割に満たない多色アイコンは、色を選ぶと画素のわずかな差で結果が揺れるので無彩色にする
    if (bestW / total < 0.4) return neutral;

    let sn = 0, cs = 0, sat = 0, w = 0;
    for (const b of [(best + BUCKETS - 1) % BUCKETS, best, (best + 1) % BUCKETS]) {
      sn += sinSum[b]; cs += cosSum[b]; sat += satSum[b]; w += weight[b];
    }
    const h = Math.round((Math.atan2(sn, cs) * 180) / Math.PI + 360) % 360;
    const s = Math.round(Math.min(0.9, Math.max(0.35, sat / w)) * 100);
    return { kind: "hue", h, s };
  }

  // ホスト名から決める色相 (アイコンが無いサイトの頭文字タイル用)
  function hostHue(url) {
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
    let h = 0;
    for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  return { iconTint, dominantHue, hostHue, rgbToHsl };
});
