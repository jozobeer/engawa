// ピン留めタブの一覧 (フォルダ付き)。sidepanel.js より前に読み込む (呼び出しは init 以降)。
//
// Arc のスペースのピン留めにあたる、行形式の一覧。お気に入りのグリッド (pins) とは別に 1 つだけ持つ (スペースは無い)。
// 保存先: chrome.storage.sync の pinnedTabs = [node]  (1 項目 8 KB まで)
//   node = { type: "tab", id, url, title } | { type: "folder", id, title, children: [node] }
//        | { type: "split", id, children: [tab, tab] }   (分割項目。split-items.js。担当タブはペインごと、split.id は担当先ではない)
// 端末ごとの状態 (chrome.storage.local): folderCollapsed { folderId: true }
//
// 担当タブはお気に入りと同じ仕組み (ownedTabs のキー = node.id)。ただし Chrome の固定タブにはしない
// (固定タブの帯が溢れないように)。Today 欄には出ず、自動アーカイブの対象にもならない。

let pinnedTabs = [];
let folderCollapsed = {};
let pinnedEditing = false; // ピン留め一覧の編集モード (お気に入りの editing とは別)

function setPinnedEditing(on) {
  pinnedEditing = on;
  $("#btn-pinned-edit").classList.toggle("active", on);
  renderPinned();
}
let legacySpaceKeys = []; // 旧「スペース」方式のキー。移行が 8 KB に収まらず保留のときだけ残り、保存できた時点で消す

// ---------- データ ----------
async function loadPinnedTabs() {
  const all = await chrome.storage.sync.get(null);
  if (Array.isArray(all.pinnedTabs)) {
    pinnedTabs = sanitizedItems(all.pinnedTabs);
  } else if (Array.isArray(all.spaces)) {
    // 以前の「スペース」方式からの移行: スペースが複数あれば、それぞれをスペース名のフォルダにまとめる
    const trees = all.spaces.map((s, i) => ({ name: s.name || t("importUnnamedSpace", i + 1), tree: all[`spacePins:${s.id}`] || [] })).filter((x) => x.tree.length);
    pinnedTabs = trees.length <= 1
      ? (trees[0]?.tree || [])
      : trees.map((x) => ({ type: "folder", id: crypto.randomUUID(), title: x.name, children: x.tree }));
    legacySpaceKeys = ["spaces", ...Object.keys(all).filter((k) => k.startsWith("spacePins:"))];
    // 旧方式はスペースごとに 8 KB だったので、合計が 1 項目 8 KB を超えて set が拒否されうる。
    // その場合は旧キーを残したままメモリ上の一覧で動かし (何も失わず、担当タブも解決できる) 知らせる。
    // 項目を減らして収まった時点で savePinnedTabs が書き、旧キーを消す。init は止めない
    await savePinnedTabs();
  } else {
    pinnedTabs = [];
  }
  const loc = await chrome.storage.local.get("folderCollapsed");
  folderCollapsed = loc.folderCollapsed || {};
}

async function removeLegacySpaceKeys() {
  if (!legacySpaceKeys.length) return;
  await chrome.storage.sync.remove(legacySpaceKeys);
  await chrome.storage.local.remove(["activeSpaceId"]);
  legacySpaceKeys = [];
}

// 保存。容量超過 (1 項目 8 KB) なら元に戻して知らせる
async function savePinnedTabs(prev) {
  try {
    await chrome.storage.sync.set({ pinnedTabs });
  } catch {
    if (prev) pinnedTabs = prev;
    flash(t("pinStorageFull"));
    return false;
  }
  await removeLegacySpaceKeys();
  return true;
}
function pinnedTabsFit(nodes) {
  return new TextEncoder().encode(JSON.stringify(nodes)).length + "pinnedTabs".length <= PINS_ITEM_QUOTA;
}

// ---------- ツリー操作 ----------
function walkTabs(nodes, fn, path = []) {
  for (const n of nodes) {
    if (n.type === "tab") fn(n, path);
    else if (n.type === "split") walkTabs(n.children || [], fn, path); // 分割項目はフォルダではない (path に入れない)。ペインが葉
    else walkTabs(n.children || [], fn, [...path, n]);
  }
}
function allPinnedTabs() {
  const out = [];
  walkTabs(pinnedTabs, (n) => out.push(n));
  return out;
}
// id のノードと、それが入っている配列を返す
function findNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, siblings: nodes, index: i };
    if (n.type === "folder" || n.type === "split") { // 分割項目のペインも id で引ける
      const r = findNode(n.children || [], id);
      if (r) return r;
    }
  }
  return null;
}
function cloneTree(nodes) { return JSON.parse(JSON.stringify(nodes)); }
function treeUrls(nodes) { const s = new Set(); walkTabs(nodes, (n) => s.add(n.url)); return s; }

// ---------- 追加・削除・名前変更 ----------
async function addPinnedTab(url, title, { parentId = null } = {}) {
  return insertPinnedTab(url, title, parentId ? { where: "into", id: parentId } : { where: "end" });
}

// 位置を指定して追加。where: "before" / "after" (id の行の前後)、"into" (id のフォルダの末尾)、"end" (最上位の末尾)
async function insertPinnedTab(url, title, { where = "end", id = null } = {}) {
  if (!/^https?:/.test(url || "")) { flash(t("pinUnsupportedUrl")); return null; }
  if (treeUrls(pinnedTabs).has(url)) { flash(t("pinDuplicate")); return null; }
  return insertPinnedNode({ type: "tab", id: crypto.randomUUID(), url, title: (title || "").trim() || url }, { where, id });
}

// 作ったノード (タブ、分割項目) を位置を指定して挿入・保存する。容量を超えるときは何も変えずに null
async function insertPinnedNode(node, { where = "end", id = null } = {}) {
  if (!pinnedTabsFit([...pinnedTabs, node])) { flash(t("pinStorageFull")); return null; }
  const ref = id ? findNode(pinnedTabs, id) : null;
  if (where !== "end" && !ref) return null; // 置き先がドラッグ中に消えた
  const prev = cloneTree(pinnedTabs);
  if (where === "into" && ref.node.type === "folder") (ref.node.children ||= []).push(node);
  else if (where === "before" || where === "after") ref.siblings.splice(ref.index + (where === "after" ? 1 : 0), 0, node);
  else pinnedTabs.push(node);
  if (!(await savePinnedTabs(prev))) return null;
  renderPinned();
  return node;
}

async function addPinnedFolder(title) {
  const node = { type: "folder", id: crypto.randomUUID(), title: (title || "").trim() || t("importUntitledFolder"), children: [] };
  const prev = cloneTree(pinnedTabs);
  pinnedTabs.push(node);
  if (!(await savePinnedTabs(prev))) return null;
  renderPinned();
  return node;
}

// ---------- お気に入りとの行き来 (ドラッグ) ----------
// 担当タブはそのまま引き継ぐ (タブは増えない)。お気に入りで Chrome の固定タブにしていたものは、ピン留めタブでは固定しないので外れる
async function moveFavoriteToPinned(pinId, target) {
  const p = pinById(pinId);
  if (!p) return;
  const node = await insertPinnedTab(p.url, p.title, target);
  if (!node) return;
  await transferOwnedTab(pinId, node.id); // 担当タブを新しいピン留めタブへ (ピン留めタブは固定しないので Chrome の固定は外す)
  await removePin(pinId); // 担当はもう移したので、ここの releaseOwnedTab と pins 変更の orphan 掃除はどちらも空振り (安全)
  renderPins(); renderPinned(); renderToday();
}
// 逆 (ピン留めタブ → お気に入り)。設定に従って Chrome の固定タブにする
async function movePinnedToFavorite(nodeId, target) {
  const r = findNode(pinnedTabs, nodeId);
  if (!r || r.node.type !== "tab") return;
  const pinId = await insertPin(r.node.url, r.node.title, target);
  if (!pinId) return;
  await transferOwnedTab(nodeId, pinId, { chromePin: true }); // 担当タブを新しいお気に入りへ (設定に従って固定)
  await removePinnedNode(nodeId); // 担当はもう移したので releaseOwnedTab は空振り
  renderPins(); renderPinned(); renderToday();
}

// 項目を消して担当を解放する (分割項目なら 2 枚とも。分割は Chrome に残り、Today 欄に分割行として戻る)。消せたら true。
// release: false は、ペイン id が別の容器 (お気に入り) の項目へ移ったときだけ (担当を解放すると、移した先の担当が外れる)
async function removePinnedNode(id, { release = true } = {}) {
  const r = findNode(pinnedTabs, id);
  if (!r) return false;
  const prev = cloneTree(pinnedTabs);
  const removedTabs = [];
  walkTabs([r.node], (n) => removedTabs.push(n.id));
  r.siblings.splice(r.index, 1);
  if (!(await savePinnedTabs(prev))) return false;
  if (release && isSplitItem(r.node)) await releaseSplitPanes(removedTabs);
  else if (release) for (const tabNodeId of removedTabs) await releaseOwnedTab(tabNodeId);
  renderPinned();
  return true;
}

async function renamePinnedNode(id, title) {
  const r = findNode(pinnedTabs, id);
  if (!r) return;
  const prev = cloneTree(pinnedTabs);
  r.node.title = (title || "").trim() || (r.node.type === "tab" ? r.node.url : t("importUntitledFolder"));
  await savePinnedTabs(prev);
  renderPinned();
}

// タブのノード (分割項目も) をフォルダの中 (末尾) か、フォルダの前後 (その親の階層) へ移す (ドラッグの出し入れ)
async function movePinnedNode(id, { folderId, where }) {
  const r = findNode(pinnedTabs, id), f = findNode(pinnedTabs, folderId);
  if (!r || !f || !(r.node.type === "tab" || isSplitItem(r.node)) || f.node.type !== "folder") return;
  const prev = cloneTree(pinnedTabs);
  r.siblings.splice(r.index, 1);
  if (where === "into") (f.node.children ||= []).push(r.node);
  else f.siblings.splice(f.siblings.indexOf(f.node) + (where === "after" ? 1 : 0), 0, r.node);
  if (JSON.stringify(pinnedTabs) !== JSON.stringify(prev)) await savePinnedTabs(prev); // 既にその位置なら保存しない
  renderPinned();
}

async function toggleFolder(id) {
  if (folderCollapsed[id]) delete folderCollapsed[id]; else folderCollapsed[id] = true;
  await chrome.storage.local.set({ folderCollapsed });
  renderPinned();
}

// ---------- 表示 ----------
const pinnedRows = new Map();   // nodeId -> { el, kids (folder の子コンテナ), type }
const pinnedReorders = [];      // reorder.js のハンドル
let pinnedRenderPending = false;
let pinnedRenaming = null;      // 名前変更中の nodeId (描き直しで入力欄を消さない)

function pinnedIconSrc(node) {
  const tab = ownedTabOf(node.id);
  if (tab && /^(https?:|data:)/.test(tab.favIconUrl || "")) return tab.favIconUrl;
  return iconStore[node.url] || faviconUrl(node.url);
}

// ドラッグ中の「フォルダに入れる / フォルダから出す」先 (reorder.js の dropTarget)。タブの行だけで、フォルダ行は同じ階層の並べ替えのみ。
// フォルダのまとまり (フォルダ行 + 開いている子) に重ねると: 行の上端 25% はフォルダの前、残りはそのフォルダの中 (末尾)。
// 閉じている (または空の) フォルダは行の下端 25% がフォルダの後ろ。reorder.js の詰め替え (行の中心 ±35%) より先に判定するので、
// タブをフォルダ行に重ねても横をすり抜けない。フォルダの中の行は、フォルダ行より上へ持っていくとフォルダの前、
// 子の末尾より下へ持っていくとフォルダの後ろ (親の階層) へ出す
function pinnedDropTarget(x, y, movedEl) {
  if (!movedEl.classList.contains("pinned-row")) return null;
  const parentKids = movedEl.parentElement;
  const target = (row, where, el, cls) => ({ el, cls, folderId: row.dataset.nodeId, where });
  for (const row of [...$("#pinned-list").querySelectorAll(".folder-row")].reverse()) { // 入れ子は内側のフォルダから
    const kids = pinnedRows.get(row.dataset.nodeId)?.kids;
    const open = !!kids && !kids.hidden && kids.childElementCount > 0;
    const r = row.getBoundingClientRect();
    const bottom = open ? kids.getBoundingClientRect().bottom : r.bottom;
    if (x < r.left || x > r.right || y < r.top || y > bottom) continue;
    if (y < r.top + r.height * 0.25) return target(row, "before", row, "drop-before");
    if (!open && y > r.bottom - r.height * 0.25) return target(row, "after", row, "drop-after");
    return parentKids === kids ? null : target(row, "into", row, "drop-into"); // 既にその中なら普通の並べ替え
  }
  if (!parentKids.classList.contains("folder-children")) return null;
  const folderRow = parentKids.previousElementSibling; // 子コンテナはフォルダ行の直後に置かれる
  if (y < folderRow.getBoundingClientRect().top) return target(folderRow, "before", folderRow, "drop-before");
  if (y > parentKids.getBoundingClientRect().bottom) return target(folderRow, "after", parentKids, "drop-after");
  return null;
}

// Today 欄からタブをドラッグしてきたときの差し込み先 (today.js の dropTarget から呼ぶ)。ピン留めタブのセクションの中なら必ず何かを返す:
// フォルダのまとまりは pinnedDropTarget と同じ (行の上端 25% で前、それ以外は中)、タブの行は上半分で前・下半分で後ろ、行の無いところは最上位の末尾
function pinnedInsertTarget(x, y) {
  const sec = $("#pinned-section").getBoundingClientRect();
  if (x < sec.left || x > sec.right || y < sec.top || y > sec.bottom) return null;
  const target = (where, el, cls, id = el.dataset.nodeId) => ({ el, cls, kind: "pinned", where, id });
  for (const row of [...$("#pinned-list").querySelectorAll(".pinned-node")].reverse()) { // 入れ子は内側から
    if (!row.offsetParent) continue; // 閉じたフォルダの中
    const r = row.getBoundingClientRect();
    if (row.classList.contains("folder-row")) {
      const kids = pinnedRows.get(row.dataset.nodeId)?.kids;
      const open = !!kids && !kids.hidden && kids.childElementCount > 0;
      const bottom = open ? kids.getBoundingClientRect().bottom : r.bottom;
      if (x < r.left || x > r.right || y < r.top || y > bottom) continue;
      if (y < r.top + r.height * 0.25) return target("before", row, "drop-before");
      if (!open && y > r.bottom - r.height * 0.25) return target("after", row, "drop-after");
      return target("into", row, "drop-into");
    }
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    return y < r.top + r.height / 2 ? target("before", row, "drop-before") : target("after", row, "drop-after");
  }
  return target("end", $("#pinned-list"), "drop-end", null);
}

// 1 つの階層 (一覧の最上位、またはフォルダの中) の並べ替え (編集モードでなくてもよい)。
// タブの行は Today 欄へドラッグするとピン留めを外せ (today.js の unpinToToday)、お気に入りへドラッグするとそちらへ移る (movePinnedToFavorite)。
// 単独の行を同じ階層の別の単独の行の真ん中に重ねると分割項目になり (combinePinnedRows)、分割行のペインをつかむとその 1 枚だけを引き出せる (pinnedDetach)。
// 分割項目は項目ごとお気に入り (movePinnedSplitToFavorite) や Today 欄 (unpinSplitToToday) へ移せる。
function setupPinnedContainer(container) {
  pinnedReorders.push(setupLiveReorder({
    container,
    itemSelector: ".pinned-node",
    canStart: (e) => !e.target.closest(".tab-close, .chev, input"),
    companion: (el) => pinnedRows.get(el.dataset.nodeId)?.kids || null, // フォルダ行はその子コンテナごと動かす
    // Today 欄・お気に入りへの移動 (タブの行だけ) を先に見る。この 2 つはセクションの外では null を返すので、
    // ポインターが外に出たときだけ横取りする。フォルダの中のタブを Today / お気に入りへ出せるのはこの順のおかげ
    // (pinnedDropTarget を先にすると、フォルダから出す判定がセクション外でも効いて取り違える)
    dropTarget: (x, y, el) => (el.classList.contains("pinned-row") ? todayUnpinTarget(x, y) || favoritesInsertTarget(x, y) : null) || pinnedDropTarget(x, y, el),
    combineTarget: pinnedCombineTarget,
    detach: pinnedDetach,
    onDrop: async (target, movedEl) => {
      const id = movedEl.dataset.nodeId;
      if (target.kind === "split") return combinePinnedRows(target, movedEl);
      // 分割から引き出してきたペインなら、先に引き出しを確定する。移動先が断っても (重複など) 引き出しは確定している
      if (movedEl.dataset.pulledFrom && !(await dissolveSplit(movedEl.dataset.pulledFrom, id))) return;
      const node = findNode(pinnedTabs, id)?.node;
      if (!node) return;
      if (target.kind === "unpin") return isSplitItem(node) ? unpinSplitToToday(node, target) : unpinToToday(id, node.url, target, () => removePinnedNode(id));
      if (target.kind === "favorites") return isSplitItem(node) ? movePinnedSplitToFavorite(id, target) : movePinnedToFavorite(id, target);
      return movePinnedNode(id, target);
    },
    onCommit: async (order, movedEl) => {
      // 分割から引き出したペインなら、先に引き出しを確定する。並びでは、分割行の位置に残ったペインが入る
      const pulledFrom = movedEl.dataset.pulledFrom;
      const remainId = pulledFrom ? await dissolveSplit(pulledFrom, movedEl.dataset.nodeId) : null;
      if (pulledFrom && !remainId) return;
      // 動かした要素の属する配列 (この階層) に並びを反映する
      const r = findNode(pinnedTabs, movedEl.dataset.nodeId);
      if (!r) return;
      const siblings = r.siblings;
      const ids = order.map((el) => (el.dataset.nodeId === pulledFrom ? remainId : el.dataset.nodeId));
      const byId = new Map(siblings.map((n) => [n.id, n]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean);
      for (const n of siblings) if (!ids.includes(n.id)) next.push(n);
      if (next.some((n, i) => n !== siblings[i])) {
        const prev = cloneTree(pinnedTabs);
        siblings.splice(0, siblings.length, ...next);
        await savePinnedTabs(prev);
      }
    },
    onEnd: () => renderPinned(),
  }));
}

function createPinnedRow(node) {
  if (isSplitItem(node)) return createPinnedSplitRow(node);
  const el = document.createElement("div");
  el.className = `tab-row pinned-node ${node.type === "folder" ? "folder-row" : "pinned-row"}`;
  el.dataset.nodeId = node.id;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "tab-close";
  del.textContent = "×";
  del.title = t("removeTitle");
  del.addEventListener("click", (e) => { e.stopPropagation(); if (pinnedEditing) removePinnedNode(el.dataset.nodeId); }); // × は編集モードだけ
  const title = document.createElement("span");
  title.className = "tab-title";

  if (node.type === "folder") {
    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "chev";
    chev.appendChild(uiIcon("chevron", 12));
    chev.addEventListener("click", (e) => { e.stopPropagation(); toggleFolder(el.dataset.nodeId); });
    const count = document.createElement("span");
    count.className = "count";
    el.append(chev, title, count, del);
    // ダブルクリック (名前変更) の 2 回目のクリックでは開閉しない (1 回目の分は dblclick 側で戻す)
    el.addEventListener("click", (e) => { if (!pinnedEditing && e.detail <= 1 && !e.target.closest(".tab-close")) toggleFolder(el.dataset.nodeId); });
    const kids = document.createElement("div");
    kids.className = "folder-children today-list";
    setupPinnedContainer(kids);
    return { el, kids };
  }

  const icon = document.createElement("img");
  icon.className = "tab-icon";
  icon.alt = "";
  icon.addEventListener("error", () => { icon.style.visibility = "hidden"; });
  el.append(icon, title, del);
  // 通常クリック: 担当タブへ (タブは増えない)。⌘クリック / 中クリック: 別の新しいタブで開く
  el.addEventListener("click", (e) => {
    if (pinnedEditing || e.detail > 1 || e.target.closest(".tab-close")) return;
    const r = findNode(pinnedTabs, el.dataset.nodeId);
    if (!r) return;
    if (e.metaKey || e.ctrlKey) chrome.tabs.create({ url: r.node.url, active: false });
    else openOwned(r.node.id, r.node.url, { chromePin: false });
  });
  el.addEventListener("auxclick", (e) => {
    const r = findNode(pinnedTabs, el.dataset.nodeId);
    if (e.button === 1 && r && !pinnedEditing) { e.preventDefault(); chrome.tabs.create({ url: r.node.url, active: false }); }
  });
  return { el, kids: null };
}

// ダブルクリックでその場で名前変更 (編集モードでなくてもよい。Arc と同じで、1 回目のクリックでタブは切り替わる)。
// タイトルの span の中を入力欄にして、Enter で確定、Esc で取消、フォーカスが外れたら確定。ダイアログは出さない
// id は名前を変えるノード (分割項目ではペインの id。el はそのペインの要素)
function startPinnedRename(el, id = el.dataset.nodeId) {
  const r = findNode(pinnedTabs, id);
  if (!r || pinnedRenaming) return;
  pinnedRenaming = r.node.id;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = r.node.title || "";
  input.setAttribute("aria-label", t("renamePrompt"));
  el.querySelector(".tab-title").replaceChildren(input);
  let done = false;
  const refocus = () => { if (!done && input.isConnected) input.focus(); };
  const finish = async (commit) => {
    if (done) return;
    done = true;
    pinnedRenaming = null;
    window.removeEventListener("focus", refocus);
    if (commit && input.value.trim() !== (r.node.title || "")) await renamePinnedNode(r.node.id, input.value);
    else renderPinned(); // 入力欄を外して元のタイトルに戻す
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // Esc で編集モードを抜けたり、ドラッグを取り消したりしない
    if (e.isComposing || e.keyCode === 229) return; // IME の変換確定 / 取消の Enter・Esc は入力欄のまま
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => attachRenameBlur(input, refocus, () => done, finish));
  for (const type of ["pointerdown", "click", "dblclick"]) input.addEventListener(type, (e) => e.stopPropagation());
  input.focus();
  input.select();
}

// 名前変更の入力欄からフォーカスが外れたとき。パネル内の別の場所へ移ったなら確定。パネルの外へ出た (1 回目のクリックで
// 切り替えたタブに Chrome がフォーカスを移した、別のウィンドウを触った、など) なら入力欄を残し、パネルがフォーカスを
// 取り戻したときに入力欄へ戻す。判定は blur の直後では定まらないので、1 ティック待ってから見る
function attachRenameBlur(input, refocus, isDone, finish) {
  setTimeout(() => {
    if (isDone() || document.activeElement === input) return;
    if (document.hasFocus()) finish(true);
    else window.addEventListener("focus", refocus, { once: true });
  }, 0);
}

function attachPinnedRename(el) {
  el.addEventListener("dblclick", (e) => {
    if (e.target.closest(".tab-close, .chev, input")) return;
    if (el.classList.contains("split-row")) { // 分割項目はペインごと (つまみや隙間では何もしない)
      const pane = e.target.closest(".split-pane");
      if (pane) startPinnedRename(pane, pane.dataset.paneId);
      return;
    }
    if (el.classList.contains("folder-row") && !pinnedEditing) toggleFolder(el.dataset.nodeId); // 1 回目のクリックで開閉したのを戻す
    startPinnedRename(el);
  });
}

// 変わった行だけ作り直し、並びの違う要素だけ動かす (チカチカしないように)
function renderPinnedLevel(container, nodes) {
  const wanted = [];
  for (const node of nodes) {
    let entry = pinnedRows.get(node.id);
    if (!entry || entry.type !== node.type) {
      if (entry) { entry.el.remove(); entry.kids?.remove(); }
      const made = createPinnedRow(node);
      entry = { ...made, type: node.type };
      attachPinnedRename(entry.el);
      pinnedRows.set(node.id, entry);
    }
    const { el } = entry;
    if (node.type === "split") { updatePinnedSplitRow(el, node); wanted.push(el); continue; }
    if (node.type === "tab") {
      fillPinnedPane(el, node);
      wanted.push(el);
    } else {
      const titleEl = el.querySelector(".tab-title");
      if (node.id !== pinnedRenaming && titleEl.textContent !== node.title) titleEl.textContent = node.title;
      el.title = node.title;
      const collapsed = !!folderCollapsed[node.id];
      el.classList.toggle("collapsed", collapsed);
      el.querySelector(".chev").classList.toggle("collapsed", collapsed);
      let n = 0;
      walkTabs(node.children || [], () => n++);
      el.querySelector(".count").textContent = String(n);
      entry.kids.hidden = collapsed;
      renderPinnedLevel(entry.kids, node.children || []);
      wanted.push(el, entry.kids);
    }
  }
  for (let i = 0; i < wanted.length; i++) {
    if (container.children[i] !== wanted[i]) container.insertBefore(wanted[i], container.children[i] || null);
  }
  while (container.children.length > wanted.length) container.lastElementChild.remove();
}

function renderPinned() {
  if (pinnedReorders.some((r) => r.isDragging())) { pinnedRenderPending = true; return; }
  pinnedRenderPending = false;
  const list = $("#pinned-list");
  const alive = new Set(); // 行のキー (tab / folder / split の id)。分割項目のペインは行ではなく、行の中の要素
  const mark = (nodes) => { for (const n of nodes) { alive.add(n.id); if (n.type === "folder") mark(n.children || []); } };
  mark(pinnedTabs);
  if (pinnedRenaming && !alive.has(pinnedRenaming) && !allPinnedTabs().some((n) => n.id === pinnedRenaming)) pinnedRenaming = null; // 名前変更中に消された
  for (const [id, entry] of pinnedRows) if (!alive.has(id)) { entry.el.remove(); entry.kids?.remove(); pinnedRows.delete(id); }
  renderPinnedLevel(list, pinnedTabs);
  list.classList.toggle("editing", pinnedEditing); // CSS (.pinned-list.editing) と合わせる
  $("#pinned-empty").hidden = pinnedTabs.length > 0 || pinnedEditing;
}

// ---------- 初期化 ----------
async function initPinned() {
  // loadPinnedTabs は sidepanel.js の init が (担当タブの結び直しより前に) 済ませている
  setupPinnedContainer($("#pinned-list"));
  $("#btn-pinned-add").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    await refreshOpenTabs();
    // いま見ているタブが分割のペアで、2 枚とも担当の無い通常のタブなら、分割項目として追加する (相方の隣は左右の順のまま)
    const partner = splitPartners(tab)[0];
    if (partner && !Object.values(ownedTabs).some((id) => id === tab.id || id === partner.id)) {
      return pinSplitFromTabs([tab, partner].sort((a, b) => a.index - b.index), { where: "end" });
    }
    const node = await addPinnedTab(tab.url || tab.pendingUrl, tab.title);
    // いま見ているタブをそのまま担当タブにする (別の担当になっているタブは奪わない)
    if (node && !Object.values(ownedTabs).includes(tab.id)) {
      await bindOwnedTab(node.id, tab.id);
      await refreshOpenTabs();
      renderPinned();
      renderToday();
    }
  });
  $("#btn-pinned-folder").addEventListener("click", () => addPinnedFolder(t("importUntitledFolder")));
  $("#btn-pinned-edit").addEventListener("click", () => setPinnedEditing(!pinnedEditing));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pinnedEditing) setPinnedEditing(false); });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "sync" && changes.pinnedTabs) {
      pinnedTabs = sanitizedItems(changes.pinnedTabs.newValue || []);
      renderPinned();
      await refreshOpenTabs();
      await pruneOrphanOwners();
    }
    if (area === "session" && changes.ownedTabs) renderPinned();
    if (area === "local" && changes.icons) renderPinned();
  });
  renderPinned();
}
