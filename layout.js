// ピンのグリッドの列数を決める純粋関数。sidepanel からはグローバル関数、Node (テスト) からは module.exports として使う。
//
// タイルは最小サイズ min 〜 最大サイズ max の正方形。幅 width を間隔 gap で敷き詰めるとき、
// タイルが max を超えない範囲でいちばん大きくなる列数を選ぶ (= 列数はできるだけ少なく)。
// ただし、タイルが min を下回るほど列を増やすことはしない。
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== "undefined" ? self : globalThis, function () {
  function pinColumns(width, min, max, gap) {
    if (!(width > 0) || !(min > 0) || !(max >= min)) return 1;
    const fewestWithinMax = Math.ceil((width + gap) / (max + gap)); // これ以上少ないとタイルが max を超える
    const mostWithinMin = Math.floor((width + gap) / (min + gap));  // これ以上多いとタイルが min を下回る
    return Math.max(1, Math.min(fewestWithinMax, mostWithinMin));
  }

  function tileSize(width, cols, gap) {
    return (width - (cols - 1) * gap) / cols;
  }

  return { pinColumns, tileSize };
});
