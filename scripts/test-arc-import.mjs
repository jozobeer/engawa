// arc-import.js の単体テスト (合成データ) と、実ファイルがあれば件数だけ表示する簡易チェック。
// 使い方: node scripts/test-arc-import.mjs [path/to/StorableSidebar.json]
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { parseArcSidebar, md5Hex, arcFaviconFileName } = require("../arc-import.js");
const { createHash } = await import("node:crypto");

// --- 合成データ: お気に入り 2 件 (1 件は重複)、スペース 2 つ (1 つは名前付き、フォルダと分割表示を含む) ---
const fixture = {
  sidebar: {
    containers: [
      { global: {} },
      {
        topAppsContainerIDs: [{ default: true }, "TOP"],
        spaces: [
          { id: "S1", containerIDs: ["pinned", "P1", "unpinned", "U1"] },
          { id: "S2", title: "Work", containerIDs: ["pinned", "P2", "unpinned", "U2"] },
        ],
        items: [
          "TOP", { id: "TOP", parentID: null, data: { itemContainer: { containerType: { topApps: {} } } }, childrenIds: ["F1", "F2"] },
          "F1", { id: "F1", parentID: "TOP", title: null, data: { tab: { savedURL: "https://a.example/", savedTitle: "A" } } },
          "F2", { id: "F2", parentID: "TOP", title: "Custom B", data: { tab: { savedURL: "https://b.example/", savedTitle: "B" } } },
          "P1", { id: "P1", parentID: null, data: { itemContainer: { containerType: { spaceItems: {} } } }, childrenIds: ["T1", "T2", "X1"] },
          "T1", { id: "T1", parentID: "P1", data: { tab: { savedURL: "https://a.example/", savedTitle: "A again" } } },
          "T2", { id: "T2", parentID: "P1", data: { tab: { savedURL: "https://c.example/", savedTitle: "C" } } },
          "X1", { id: "X1", parentID: "P1", data: { tab: { savedURL: "chrome://settings", savedTitle: "nope" } } },
          "P2", { id: "P2", parentID: null, data: { itemContainer: { containerType: { spaceItems: {} } } }, childrenIds: ["L1", "SV"] },
          "L1", { id: "L1", parentID: "P2", title: "Docs", data: { list: {} }, childrenIds: ["T3", "L2"] },
          "L2", { id: "L2", parentID: "L1", title: "Deep", data: { list: {} }, childrenIds: ["T4"] },
          "T3", { id: "T3", parentID: "L1", data: { tab: { savedURL: "https://d.example/", savedTitle: "D" } } },
          "T4", { id: "T4", parentID: "L2", data: { tab: { savedURL: "https://e.example/", savedTitle: "  " } } },
          "SV", { id: "SV", parentID: "P2", data: { splitView: {} }, childrenIds: ["T5"] },
          "T5", { id: "T5", parentID: "SV", data: { tab: { savedURL: "https://f.example/", savedTitle: "F" } } },
          "U1", { id: "U1", parentID: null, data: { itemContainer: { containerType: { spaceItems: {} } } }, childrenIds: ["T6"] },
          "T6", { id: "T6", parentID: "U1", data: { tab: { savedURL: "https://unpinned.example/", savedTitle: "not imported" } } },
        ],
      },
    ],
  },
};

const r = parseArcSidebar(fixture);
assert.deepEqual(r.favorites.map((p) => [p.url, p.title]), [["https://a.example/", "A"], ["https://b.example/", "Custom B"]]);
assert.equal(r.spaces.length, 2);
assert.equal(r.spaces[0].name, null);
assert.equal(r.spaces[0].index, 1);
// グループ間の重複 (a.example) は残し、chrome:// は除外される
assert.deepEqual(r.spaces[0].pins.map((p) => p.url), ["https://a.example/", "https://c.example/"]);
assert.equal(r.spaces[1].name, "Work");
assert.deepEqual(r.spaces[1].pins.map((p) => [p.url, p.title, p.folder]), [
  ["https://d.example/", "D", "Docs"],
  ["https://e.example/", "https://e.example/", "Docs / Deep"],
  ["https://f.example/", "F", null],
]);
// 無題フォルダの表示名を差し替えられる
{
  const untitled = structuredClone(fixture);
  const items = untitled.sidebar.containers[1].items;
  items[items.indexOf("L1") + 1].title = null;
  const ru = parseArcSidebar(untitled, { untitledFolder: "無題" });
  assert.equal(ru.spaces[1].pins[0].folder, "無題");
  assert.equal(parseArcSidebar(untitled).spaces[1].pins[0].folder, "Folder");
}

// 新形式 newContainerIDs (マーカーがオブジェクト) を優先し、旧形式が無くても読める
{
  const modern = structuredClone(fixture);
  const sp = modern.sidebar.containers[1].spaces;
  sp[0] = { id: "S1", newContainerIDs: [{ unpinned: { _0: { shared: {} } } }, "U1", { pinned: {} }, "P1"] };
  const rm = parseArcSidebar(modern);
  assert.deepEqual(rm.spaces[0].pins.map((p) => p.url), ["https://a.example/", "https://c.example/"]);
  // 両方ある場合は newContainerIDs を優先する (旧形式が別の ID を指していても)
  sp[0].containerIDs = ["pinned", "U1", "unpinned", "P1"];
  assert.deepEqual(parseArcSidebar(modern).spaces[0].pins.map((p) => p.url), ["https://a.example/", "https://c.example/"]);
}

// 同じグループ内の重複は除く
{
  const dup = structuredClone(fixture);
  const items = dup.sidebar.containers[1].items;
  items[items.indexOf("P1") + 1].childrenIds.push("T2b");
  items.push("T2b", { id: "T2b", parentID: "P1", data: { tab: { savedURL: "https://c.example/", savedTitle: "C dup" } } });
  assert.deepEqual(parseArcSidebar(dup).spaces[0].pins.map((p) => p.url), ["https://a.example/", "https://c.example/"]);
}

// スペースのツリー (フォルダ構造を保つ)。分割表示の中身は親に展開され、空フォルダは出ない
assert.deepEqual(r.spaces[1].tree, [
  { type: "folder", id: "L1", title: "Docs", children: [
    { type: "tab", id: "T3", url: "https://d.example/", title: "D" },
    { type: "folder", id: "L2", title: "Deep", children: [{ type: "tab", id: "T4", url: "https://e.example/", title: "https://e.example/" }] },
  ] },
  { type: "tab", id: "T5", url: "https://f.example/", title: "F" },
]);
assert.deepEqual(r.spaces[0].tree.map((n) => n.id), ["T1", "T2"]);

// 項目 ID が返る (アイコンキャッシュの照合用)
assert.deepEqual(r.favorites.map((p) => p.id), ["F1", "F2"]);

// MD5 は Node の実装と一致する (ブロック境界 55/56/63/64 バイト、マルチバイト文字を含む)
for (const s of ["", "a", "abc", "message digest", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64),
  "x".repeat(1000), "日本語のテキスト", "E3B0C442-98FC-1C14-9AFB-F4C8996FB924"]) {
  assert.equal(md5Hex(s), createHash("md5").update(s, "utf8").digest("hex"), `md5 mismatch for ${JSON.stringify(s.slice(0, 20))}`);
}
assert.equal(arcFaviconFileName("ABC"), createHash("md5").update("ABC").digest("hex"));

// 中身が全部 chrome:// のフォルダは出ない
{
  const emptyF = structuredClone(fixture);
  const items = emptyF.sidebar.containers[1].items;
  items[items.indexOf("P1") + 1].childrenIds.push("LE");
  items.push("LE", { id: "LE", parentID: "P1", title: "Empty", data: { list: {} }, childrenIds: ["XE"] },
             "XE", { id: "XE", parentID: "LE", data: { tab: { savedURL: "chrome://flags", savedTitle: "x" } } });
  assert.ok(!parseArcSidebar(emptyF).spaces[0].tree.some((n) => n.id === "LE"), "empty folder dropped");
}

// 文字列入力、壊れた入力
assert.equal(parseArcSidebar(JSON.stringify(fixture)).favorites.length, 2);
assert.throws(() => parseArcSidebar({ foo: 1 }), /not-arc-sidebar/);
console.log("fixture tests passed");

// --- 実ファイル (あれば件数だけ) ---
const real = process.argv[2] || `${homedir()}/Library/Application Support/Arc/StorableSidebar.json`;
if (existsSync(real)) {
  const rr = parseArcSidebar(readFileSync(real, "utf8"));
  console.log(`real file: favorites=${rr.favorites.length}, spaces=${rr.spaces.length} (${rr.spaces.map((s) => `${s.name || "unnamed"}:${s.pins.length}`).join(", ")})`);
  const iconDir = join(dirname(real), "SidebarItemsFaviconCache");
  if (existsSync(iconDir)) {
    const names = new Set(readdirSync(iconDir));
    const all = [...rr.favorites, ...rr.spaces.flatMap((s) => s.pins)];
    console.log(`real icons: ${all.filter((p) => names.has(arcFaviconFileName(p.id))).length}/${all.length} pins have an Arc icon`);
  }
} else {
  console.log("real file not found, skipped");
}
