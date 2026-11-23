// 分割項目の見た目と、ピン留めタブの一覧のドラッグまわり (split-items.js のデータ・Chrome 側の組み立てに対する UI)。pinned.js の後に読み込む。
//
// ピン留めの分割行は Today 欄の分割行 (split.js) と同じつくり: [つまみ][ペイン][ペイン][×]。つまみはペアごと動かし、ペインをつかむとその 1 枚だけを
// 引き出す。ペインのクリックでその側を前面にして 2 枚を分割表示で開く (足りない側だけ開く。openSplit)。名前変更はペインごと。
// × は行末に 1 つで編集モードだけ (項目ごと削除。担当は解放され、2 枚は分割のまま Today 欄に戻る)。
// 行は .pinned-row を保つので、フォルダへの出し入れ (pinnedDropTarget) や Today 欄への解除 (todayUnpinTarget) はそのまま使える。
// お気に入りのタイル (グリッド) の分割項目は末尾の節 (1 マスに 2 ペイン)。

// ペイン (分割行の 1 枚) も、通常のピン留め行も、アイコン + タイトルを持つ要素 (holder) に同じ中身を入れる。タイトルは名前変更中なら触らない
function fillPinnedPane(holder, node) {
  const titleEl = holder.querySelector(".tab-title");
  if (node.id !== pinnedRenaming && titleEl.textContent !== node.title) titleEl.textContent = node.title;
  holder.title = `${node.title}\n${node.url}`;
  const src = pinnedIconSrc(node);
  const icon = holder.querySelector(".tab-icon");
  if (icon.dataset.src !== src) { icon.dataset.src = src; icon.style.visibility = ""; icon.src = src; }
  holder.classList.toggle("open", !!ownedTabOf(node.id));
}

function createPinnedPane() {
  const pane = document.createElement("div");
  pane.className = "split-pane";
  const icon = document.createElement("img");
  icon.className = "tab-icon";
  icon.alt = "";
  icon.addEventListener("error", () => { icon.style.visibility = "hidden"; });
  const title = document.createElement("span");
  title.className = "tab-title";
  pane.append(icon, title);
  return pane;
}

function createPinnedSplitRow(node) {
  const el = document.createElement("div");
  el.className = "tab-row pinned-node pinned-row split-row";
  el.dataset.nodeId = node.id;
  const grip = document.createElement("span");
  grip.className = "split-grip";
  grip.title = t("splitGripTitle");
  grip.appendChild(uiIcon("grip", 14));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "tab-close";
  del.textContent = "×";
  del.title = t("removeTitle");
  del.addEventListener("click", (e) => { e.stopPropagation(); if (pinnedEditing) removePinnedNode(el.dataset.nodeId); }); // × は編集モードだけ
  el.append(grip, createPinnedPane(), createPinnedPane(), del);
  // 通常クリック: 押したペインを前面に 2 枚を分割表示で開く (つまみ / 隙間は表示中のペイン、無ければ左)。⌘クリック / 中クリック: 押したペイン (つまみは左) の URL を別の新しいタブで開く
  const paneNodeAt = (e) => {
    const item = findNode(pinnedTabs, el.dataset.nodeId)?.node;
    return item && isSplitItem(item) ? item.children.find((p) => p.id === e.target.closest(".split-pane")?.dataset.paneId) || item.children[0] : null;
  };
  el.addEventListener("click", (e) => {
    if (pinnedEditing || e.detail > 1 || e.target.closest(".tab-close")) return;
    if (e.metaKey || e.ctrlKey) { const p = paneNodeAt(e); if (p) chrome.tabs.create({ url: p.url, active: false }); return; }
    openSplit(el.dataset.nodeId, e.target.closest(".split-pane")?.dataset.paneId);
  });
  el.addEventListener("auxclick", (e) => {
    const p = e.button === 1 && !pinnedEditing ? paneNodeAt(e) : null;
    if (p) { e.preventDefault(); chrome.tabs.create({ url: p.url, active: false }); }
  });
  return { el, kids: null };
}

// 行を node に合わせる (要素は使い回す)。ペインの focused は「その担当タブが表示中」、行の active はどちらかが表示中
function updatePinnedSplitRow(el, node) {
  const panes = [...el.querySelectorAll(":scope > .split-pane")];
  node.children.forEach((child, i) => {
    const pane = panes[i];
    pane.dataset.paneId = child.id;
    pane.classList.remove("pulled");
    fillPinnedPane(pane, child);
    pane.classList.toggle("focused", !!ownedTabOf(child.id)?.active);
  });
  el.classList.toggle("active", panes.some((pane) => pane.classList.contains("focused")));
  el.setAttribute("aria-label", t("splitItemTitle", node.children.map((p) => p.title)));
}

// ---------- ドラッグ (setupPinnedContainer の detach / combineTarget から) ----------

// 分割行のペインをつかんだとき (つまみ / 隙間は null = 項目ごと動かす): ドラッグが始まったら、そのペインの通常の行を分割行のすぐ下に作って動かす。
// 元のペインは薄く残す。分割を解くのは離したとき (pulledFrom を見て dissolveSplit)。取り消せば描き直しで元どおり (余った行は renderPinnedLevel が消す)
function pinnedDetach(e, row) {
  const pane = e.target.closest(".split-pane");
  if (!pane || !row.classList.contains("split-row")) return null;
  return () => {
    const node = findNode(pinnedTabs, pane.dataset.paneId)?.node;
    if (!node) return row;
    const { el } = createPinnedRow(node);
    el.dataset.pulledFrom = row.dataset.nodeId;
    fillPinnedPane(el, node);
    pane.classList.add("pulled");
    row.after(el);
    return el;
  };
}

// 単独の行を別の単独の行の真ん中に重ねたときの「分割にする」先。左半分に重ねればつかんだ行が左、右半分なら右 (Today 欄と同じ。落とす位置で左右を選ぶ)。
// フォルダ行・分割行とは組まない。同じ階層の行同士だけ (reorder.js は同じ container の兄弟しか相手にしない)。Chrome に分割 API が無ければ null
function pinnedCombineTarget(dragEl, overEl, x) {
  if (!chrome.tabs.createSplit) return null;
  const plain = (el) => el.classList.contains("pinned-row") && !el.classList.contains("split-row");
  if (!plain(dragEl) || !plain(overEl) || dragEl.dataset.nodeId === overEl.dataset.nodeId) return null;
  const r = overEl.getBoundingClientRect();
  const side = x < r.left + r.width / 2 ? "left" : "right";
  return { el: overEl, cls: `drop-split-${side}`, kind: "split", side, id: overEl.dataset.nodeId };
}

// ---------- お気に入りのタイル (グリッド) ----------
// 分割項目は 1 マス: [ペイン][ペイン] を横に並べたタイル (.pin.split-tile)。タイルの data-id は項目 (split.id)、ペインの data-pane-id は担当先 (ペイン id)。
// クリックは押したペインを前面に 2 枚を分割表示で開く、ダブルクリックの名前変更はペインごと、× はタイルに 1 つ (編集モードだけ。項目ごと削除)。
// 色味 (pinTint) は付けない。Option を押しながらペインをつかむと、その 1 枚だけをタイルから引き出す (pinDetach)

function createSplitTile(item) {
  const el = document.createElement("div");
  el.className = "pin split-tile";
  el.dataset.id = item.id;
  item.children.forEach((child) => {
    const pane = document.createElement("div");
    pane.className = "pin-pane";
    pane.dataset.paneId = child.id;
    pane.appendChild(iconElement(child.url));
    el.appendChild(pane);
  });
  const rm = document.createElement("button");
  rm.className = "remove";
  rm.textContent = "×";
  rm.title = t("removeTitle");
  rm.addEventListener("click", (e) => { e.stopPropagation(); removePin(el.dataset.id); });
  el.appendChild(rm);
  const paneOf = (e) => {
    const cur = pinById(el.dataset.id);
    return isSplitItem(cur) ? cur.children.find((p) => p.id === e.target.closest(".pin-pane")?.dataset.paneId) || cur.children[0] : null;
  };
  el.addEventListener("click", (e) => {
    if (editing || e.detail > 1 || e.target.closest(".remove")) return;
    const p = paneOf(e);
    if (!p) return;
    if (e.metaKey || e.ctrlKey) chrome.tabs.create({ url: p.url, active: false });
    else openSplit(el.dataset.id, e.target.closest(".pin-pane")?.dataset.paneId);
  });
  el.addEventListener("auxclick", (e) => {
    const p = e.button === 1 && !editing ? paneOf(e) : null;
    if (p) { e.preventDefault(); chrome.tabs.create({ url: p.url, active: false }); }
  });
  el.addEventListener("dblclick", (e) => {
    const p = e.target.closest(".remove") ? null : paneOf(e);
    if (p) startPinRename(el, p.id);
  });
  return el;
}

// タイルを item に合わせる (要素は使い回す)。「開いている」印とライブなアイコンはペインごと
function updateSplitTile(el, item) {
  const panes = [...el.querySelectorAll(":scope > .pin-pane")];
  item.children.forEach((child, i) => {
    const pane = panes[i];
    if (!pane) return;
    pane.dataset.paneId = child.id;
    pane.classList.remove("pulled");
    pane.classList.toggle("open", !!ownedTabOf(child.id));
    applyLiveIcon(pane, child);
  });
  el.title = [...item.children.map((p) => p.title || p.url), t("splitPullHint")].join("\n");
  el.setAttribute("aria-label", t("splitItemTitle", item.children.map((p) => p.title || p.url)));
}

// Option を押しながら分割タイルのペインをつかんだとき: ドラッグが始まったら、そのペインの通常のタイルをタイルのすぐ後ろに作って動かす。
// 元のペインは薄く残す。分割を解くのは離したとき (pulledFrom を見て dissolvePinSplit)。取り消せば描き直しで元どおり
function pinDetach(e, tile) {
  const pane = e.target.closest(".pin-pane");
  if (!e.altKey || !pane || !tile.classList.contains("split-tile")) return null;
  return () => {
    const leaf = pinLeaf(pane.dataset.paneId);
    if (!leaf) return tile;
    const el = createPinTile(leaf);
    el.dataset.pulledFrom = tile.dataset.id;
    pane.classList.add("pulled");
    tile.after(el);
    return el;
  };
}

// 単独のタイルを別の単独のタイルの真ん中に重ねたときの「分割にする」先 (reorder.js の combineGrid)。左半分ならつかんだタイルが左、右半分なら右。
// 分割タイルとは組まない。Chrome に分割 API が無ければ null
function pinCombineTarget(dragEl, overEl, x) {
  if (!chrome.tabs.createSplit) return null;
  const plain = (el) => el.classList.contains("pin") && !el.classList.contains("split-tile") && !el.classList.contains("add");
  if (!plain(dragEl) || !plain(overEl) || dragEl.dataset.id === overEl.dataset.id) return null;
  const r = overEl.getBoundingClientRect();
  const side = x < r.left + r.width / 2 ? "left" : "right";
  return { el: overEl, cls: `drop-split-${side}`, kind: "split", side, id: overEl.dataset.id };
}
