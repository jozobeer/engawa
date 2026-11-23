// Today 欄の分割表示 (Chrome の split view)。sidepanel.js の後、today.js の前に読み込む (互いの関数は呼び出し時に参照するだけ)。
//
// Chrome 155 の chrome.tabs.createSplit([a, b]) / chrome.tabs.unsplit(splitViewId) と Tab.splitViewId を使う。Chrome の分割は
// ちょうど 2 枚で、隣り合い、固定タブかどうかとタブグループが同じもの同士だけ。ペインを (ペアごとでも) chrome.tabs.move で
// 動かすと分割が解ける。
// Today 欄ではペアを 1 行にまとめる (Arc と同じく 1 つのまとまり)。左端のつまみでペアごと動かし、ペインをつかむとその 1 枚だけを
// 分割から引き出せる (Arc ではできなかった)。行を別の行の真ん中に重ねると分割になる。
// 行のつくりはペインの数に依存させない (Arc のように 3 枚以上を Chrome が許すようになっても、ペインが増えるだけで済むように)。

const NO_SPLIT = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1;

// 分割表示のペインか。Chrome 140 より前は splitViewId が無い
function inSplit(tab) {
  return (tab.splitViewId ?? NO_SPLIT) !== NO_SPLIT;
}

// 同じ分割の相方 (自分以外のペイン)
function splitPartners(tab) {
  return inSplit(tab) ? openTabs.filter((x) => x.splitViewId === tab.splitViewId && x.id !== tab.id) : [];
}

// Today 欄の行の単位 (tabs は並び順)。分割のペアは 1 行 (キー "split:<splitViewId>")。
// ペインの片方が担当タブで Today に出ないときは、残りを普通の 1 行にする
function todayItems(tabs) {
  const groups = tabs.reduce((acc, tab) => {
    const last = acc.at(-1);
    if (inSplit(tab) && last && last[0].splitViewId === tab.splitViewId) last.push(tab);
    else acc.push([tab]);
    return acc;
  }, []);
  return groups.map((group) => ({ key: group.length > 1 ? `split:${group[0].splitViewId}` : `tab:${group[0].id}`, tabs: group }));
}

// ---------- 分割行 ----------
// [つまみ][ペイン][ペイン]。ペインはクリックでそのタブへ切り替え、× か中クリックでそのタブだけ閉じる (残りは普通のタブに戻る)
function createSplitRow() {
  const row = document.createElement("div");
  row.className = "tab-row split-row";
  const grip = document.createElement("span");
  grip.className = "split-grip";
  grip.title = t("splitGripTitle");
  grip.appendChild(uiIcon("grip", 14));
  row.appendChild(grip);
  // つまみや隙間のクリックは、表示中のペイン (無ければ左) へ切り替える
  row.addEventListener("click", (e) => {
    if (e.target.closest(".tab-close")) return;
    const pane = e.target.closest(".split-pane") || row.querySelector(":scope > .split-pane.focused") || row.querySelector(":scope > .split-pane");
    if (!pane) return;
    activateTab(Number(pane.dataset.tabId));
  });
  return row;
}

function createSplitPane() {
  const pane = document.createElement("div");
  pane.className = "split-pane";
  pane.append(...tabParts(pane));
  return pane;
}

// ペインを左から tabs に合わせる (要素は使い回す)。行の active は「この分割が表示中」、ペインの focused は「操作の対象になっているペイン」
function updateSplitRow(row, tabs) {
  const panes = [...row.querySelectorAll(":scope > .split-pane")];
  while (panes.length < tabs.length) panes.push(row.appendChild(createSplitPane()));
  panes.splice(tabs.length).forEach((pane) => pane.remove());
  tabs.forEach((tab, i) => {
    const pane = panes[i];
    pane.dataset.tabId = String(tab.id);
    pane.classList.remove("pulled");
    fillTabParts(pane, tab);
    pane.classList.toggle("focused", !!tab.active);
  });
  row.classList.toggle("active", tabs.some((tab) => tab.active));
  row.classList.toggle("chrome-pinned", !!tabs[0].pinned);
}

// ---------- ドラッグ (reorder.js の detach / combineTarget / onDrop、today.js の commitTodayOrder から) ----------

// 分割行のペインをつかんだとき: ドラッグが始まったら、そのタブの普通の行を分割行のすぐ下に作って動かす。元のペインは薄く残す。
// 分割を解くのは離したとき (commitTodayOrder / dropTodayRow / splitTodayRows)。取り消せば描き直しで元どおり
function todayDetach(e, row) {
  const pane = e.target.closest(".split-pane");
  if (!pane || !row.classList.contains("split-row")) return null;
  return () => {
    const tabId = Number(pane.dataset.tabId);
    const el = createTabRow({ id: tabId });
    updateTabRow(el, openTabs.find((tab) => tab.id === tabId) || { id: tabId, title: pane.title });
    pane.classList.add("pulled");
    row.after(el);
    return el;
  };
}

// 行を別の行の真ん中に重ねたときの「分割にする」先。左半分に重ねれば重ねた行が左、右半分なら右 (Arc と同じく落とす位置で並びを選ぶ)。
// 組めるのは 1 枚の行同士で、固定タブかどうかとタブグループが同じもの (createSplit の条件)。組めなければ null (普通の並べ替え)
function todaySplitTarget(dragEl, overEl, x) {
  if (!chrome.tabs.createSplit) return null;
  if (dragEl.classList.contains("split-row") || overEl.classList.contains("split-row")) return null;
  const a = openTabs.find((tab) => tab.id === Number(dragEl.dataset.tabId));
  const b = openTabs.find((tab) => tab.id === Number(overEl.dataset.tabId));
  if (!a || !b || a.id === b.id || inSplit(b) || a.pinned !== b.pinned || a.groupId !== b.groupId) return null;
  const r = overEl.getBoundingClientRect();
  const side = x < r.left + r.width / 2 ? "left" : "right";
  return { el: overEl, cls: `drop-split-${side}`, kind: "split", side, tabId: b.id };
}

// 行を別の行の真ん中に落としたとき: 重ねた側 (左 / 右) に並べてから分割にして、落としたタブを表示する (Arc と同じ)。
// 別の分割から引き出したペインなら、元の分割を解いてから
async function splitTodayRows(target, rowEl) {
  const tabId = Number(rowEl.dataset.tabId);
  await holdingToday(async () => {
    await unsplitTab(tabId);
    await moveTabTo(tabId, { where: target.side === "left" ? "before" : "after", tabId: target.tabId });
    try {
      await chrome.tabs.createSplit([tabId, target.tabId]);
    } catch {
      return; // 組めない組み合わせに変わっていた (直前に固定された、閉じられたなど)。並びの移動だけが残る
    }
    await activateTab(tabId);
  });
}

// tabId が分割のペインなら分割を解く (タブの位置と表示中のタブは変わらない)
async function unsplitTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !inSplit(tab)) return;
  await chrome.tabs.unsplit(tab.splitViewId).catch(() => { /* 既に解けている */ });
}

// 分割のペア (ids、左から) を target の位置へ動かす。Chrome はペインを (ペアごとでも) 動かすと分割を解くので、解いてから 1 枚ずつ
// 動かして作り直す。下へ動かすときは右のペインから、上へは左から動かすと、2 枚が隣り合ったまま行き先に並ぶ (順に待つ必要がある)。
// 固定タブと通常タブの境界をまたぐ移動は Chrome が受け付けないので、そのときは動かさない (分割も解かない)。
// target.where が "end" (Today 欄の空白に落とした。基準のタブが無い) なら、このウィンドウの末尾へ
async function moveSplitTo(ids, target) {
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id))).catch(() => null);
  const { ref, at } = await (target.where === "end" ? todayEndBoundary(ids) : todayDropBoundary(target)).catch(() => ({}));
  if (!tabs || at === undefined || (ref && ref.pinned !== tabs[0].pinned)) return;
  const down = tabs[0].index < at;
  const first = at - (down ? tabs.length : 0); // 抜いた分だけ境目が前にずれる
  await chrome.tabs.unsplit(tabs[0].splitViewId).catch(() => { /* 既に解けている */ });
  const order = down ? [...tabs.keys()].reverse() : [...tabs.keys()];
  try {
    for (const k of order) await chrome.tabs.move(tabs[k].id, { index: first + k });
  } catch {
    // 途中で閉じられた。残りで作り直せるか下で試す
  }
  await chrome.tabs.createSplit(ids).catch(() => { /* 隣り合わなかった (タブグループの境目など)。分割は解けたまま、並びは動かした位置 */ });
}

// このウィンドウの末尾の境目 (動かすペア ids を含めたタブ数)。ref は ids 以外の最後のタブ (無ければ undefined)
async function todayEndBoundary(ids) {
  const all = await chrome.tabs.query({ windowId: myWindowId });
  return { ref: all.filter((tab) => !ids.includes(tab.id)).sort((a, b) => a.index - b.index).at(-1), at: all.length };
}
