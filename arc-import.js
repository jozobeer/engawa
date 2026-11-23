// Arc の StorableSidebar.json を解析して、インポート候補 (お気に入り / 各スペースのピン留め) を取り出す。
// 副作用なしの純粋関数。sidepanel からはグローバル parseArcSidebar として、Node からは module.exports として使う。
//
// Arc の形式 (macOS, ~/Library/Application Support/Arc/StorableSidebar.json):
//   sidebar.containers[] のうち items を持つものがプロファイルごとのサイドバー。
//   items は「ID 文字列, 項目オブジェクト」が交互に並ぶ配列。
//   項目の data は tab / list (フォルダ) / itemContainer / splitView / easel / arcDocument のいずれか 1 キー。
//   itemContainer.containerType が topApps ならお気に入り (トップのグリッド)、spaceItems ならスペースの pinned/unpinned 領域。
//   spaces も items と同じく「ID 文字列, スペースオブジェクト」が交互に並ぶ。ピン留め領域の ID は
//   spaces[].newContainerIDs ([{unpinned: {...}}, <id>, {pinned: {}}, <id>]、マーカーがオブジェクト) を優先し、
//   無ければ旧来の spaces[].containerIDs (["pinned", <id>, "unpinned", <id>]、マーカーが文字列) を見る。
//   spaces[].title は未変更なら存在しない。
//
// 第 2 引数 { untitledFolder } で無題フォルダの表示名を差し替えられる (既定 "Folder")。
// 同じグループ内の URL 重複だけを除く。グループ間 (お気に入りとスペースなど) の重複は Arc の表示どおり残す。
//
// 戻り値:
//   favorites: [{ id, url, title, folder }]
//   spaces: [{ id, name, index, pins: [{ id, url, title, folder }], tree: [node] }]
//     node = { type: "tab", id, url, title } | { type: "folder", id, title, children: [node] }
//   pins はツリーを深さ優先でたどった平らな一覧 (folder は "親 / 子" のパス文字列)。プレビュー表示用。

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== "undefined" ? self : globalThis, function () {
  const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

  // マーカーは旧形式では文字列 "pinned"、新形式では { pinned: {...} } のようなオブジェクト
  const isMarker = (m, name) =>
    m === name || (m !== null && typeof m === "object" && Object.prototype.hasOwnProperty.call(m, name));

  function containerIdAfter(containerIDs, marker) {
    if (!Array.isArray(containerIDs)) return null;
    const i = containerIDs.findIndex((m) => isMarker(m, marker));
    return i >= 0 && typeof containerIDs[i + 1] === "string" ? containerIDs[i + 1] : null;
  }

  function parseArcSidebar(json, { untitledFolder = "Folder" } = {}) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    const containers = data?.sidebar?.containers;
    if (!Array.isArray(containers)) {
      throw new Error("not-arc-sidebar");
    }

    const favorites = [];
    const spaces = [];
    let spaceCounter = 0;

    for (const container of containers) {
      if (!container || !Array.isArray(container.items)) continue;
      const byId = new Map();
      for (const it of container.items) {
        if (it && typeof it === "object" && typeof it.id === "string") byId.set(it.id, it);
      }

      // 子を再帰的にたどってツリーを作る。フォルダ (list) はフォルダに、分割表示 (splitView) などの入れ物は
      // 中身を親に展開する。
      const toNodes = (ids, seen) => {
        const out = [];
        for (const id of ids || []) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const item = byId.get(id);
          if (!item) continue;
          const d = item.data || {};
          if (d.tab) {
            const url = d.tab.savedURL;
            if (!isHttp(url)) continue;
            const title = (item.title || d.tab.savedTitle || "").trim() || url;
            out.push({ type: "tab", id: item.id, url, title });
          } else if (d.list) {
            const children = toNodes(item.childrenIds, seen);
            if (children.length) out.push({ type: "folder", id: item.id, title: (item.title || "").trim() || untitledFolder, children });
          } else {
            out.push(...toNodes(item.childrenIds, seen));
          }
        }
        return out;
      };
      // ツリーを平らにする (プレビュー用)
      const flatten = (nodes, path, out) => {
        for (const n of nodes) {
          if (n.type === "tab") out.push({ id: n.id, url: n.url, title: n.title, folder: path.join(" / ") || null });
          else flatten(n.children, [...path, n.title], out);
        }
        return out;
      };
      // 同じツリー内の URL の重複を除き、空になったフォルダも除く
      const dedupeTree = (nodes, seenUrls) => nodes.flatMap((n) => {
        if (n.type === "tab") {
          if (seenUrls.has(n.url)) return [];
          seenUrls.add(n.url);
          return [n];
        }
        const children = dedupeTree(n.children, seenUrls);
        return children.length ? [{ ...n, children }] : [];
      });
      const collect = (id, folderPath, out, seen) => {
        const item = byId.get(id);
        if (!item) return;
        const nodes = toNodes([id], seen);
        flatten(nodes, folderPath, out);
      };

      // お気に入り (topApps)
      for (const item of byId.values()) {
        const ct = item.data?.itemContainer?.containerType;
        if (ct && Object.prototype.hasOwnProperty.call(ct, "topApps")) {
          const seen = new Set([item.id]);
          for (const child of item.childrenIds || []) collect(child, [], favorites, seen);
        }
      }

      // 各スペースの pinned 領域
      for (const space of container.spaces || []) {
        if (!space || typeof space !== "object") continue;
        spaceCounter += 1;
        const pinnedId = containerIdAfter(space.newContainerIDs, "pinned") ?? containerIdAfter(space.containerIDs, "pinned");
        if (!pinnedId) continue;
        const pins = [];
        const seen = new Set([pinnedId]);
        const pinnedContainer = byId.get(pinnedId);
        const tree = dedupeTree(toNodes(pinnedContainer?.childrenIds, seen), new Set());
        flatten(tree, [], pins);
        const name = (typeof space.title === "string" && space.title.trim()) || null;
        spaces.push({ id: space.id || `space-${spaceCounter}`, name, index: spaceCounter, pins, tree });
      }
    }

    // お気に入り内の URL の重複だけを除く (スペースのツリーは作るときに除いている)
    const dedupe = (list) => {
      const seen = new Set();
      return list.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
    };
    return { favorites: dedupe(favorites), spaces };
  }

  // ---- Arc のアイコンキャッシュ ----
  // ~/Library/Application Support/Arc/SidebarItemsFaviconCache/<md5(サイドバー項目 ID)> に 32x32 の PNG がある。
  // Web Crypto には MD5 が無いので最小実装を持つ (UTF-8 バイト列に対する RFC 1321)。
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  function md5Hex(str) {
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const nBlocks = ((len + 8) >>> 6) + 1;
    const w = new Uint32Array(nBlocks * 16);
    for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
    w[len >> 2] |= 0x80 << ((len % 4) * 8);
    w[nBlocks * 16 - 2] = (len * 8) >>> 0;
    w[nBlocks * 16 - 1] = Math.floor(len / 0x20000000) >>> 0;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let blk = 0; blk < nBlocks; blk++) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const s = MD5_S[(i >> 4) * 4 + (i % 4)];
        const x = (A + F + MD5_K[i] + w[blk * 16 + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((x << s) | (x >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const hex = (n) => [0, 8, 16, 24].map((sh) => ((n >>> sh) & 0xff).toString(16).padStart(2, "0")).join("");
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  // サイドバー項目 ID から、Arc のアイコンキャッシュのファイル名を求める
  function arcFaviconFileName(itemId) {
    return md5Hex(String(itemId));
  }

  return { parseArcSidebar, md5Hex, arcFaviconFileName };
});
