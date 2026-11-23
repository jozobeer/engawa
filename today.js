// Today 欄 (このウィンドウのタブの縦の一覧) と、アーカイブ画面。sidepanel.js の後に読み込む。
//
// Today 欄にはピンの担当タブ以外のタブを Chrome のタブの並び順で出す (Arc の「ピンと Today」の構成)。
// クリックで切り替え、× か中クリックで閉じ、ドラッグで並べ替え (reorder.js、Chrome のタブの並びにも反映)。
// Chrome の分割表示 (split view) のペアは 1 行にまとめる (split.js)。
// アーカイブの記録 (storage.local "archive") は background.js だけが書き込む。パネルからはメッセージで頼む。

let myWindowId = null;
let todayReorder = null;
let todayRenderPending = false;
let todayHold = 0; // 途中の状態を描かずに、終わってからまとめて描き直したい操作 (分割の作り直しなど) の数
const todayRows = new Map(); // 行のキー ("tab:<tabId>" / "split:<splitViewId>") -> el

function tabIconSrc(tab) {
  const fav = tab.favIconUrl || "";
  if (/^(https?:|data:)/.test(fav)) return fav;
  if (/^https?:/.test(tab.url || tab.pendingUrl || "")) return faviconUrl(tab.url || tab.pendingUrl);
  return null;
}

function todayTabs() {
  const owned = new Set(Object.values(ownedTabs));
  return openTabs
    .filter((tab) => tab.windowId === myWindowId && !owned.has(tab.id))
    .sort((a, b) => a.index - b.index);
}

async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* 閉じられた直後など */ }
}

function closeTab(tabId) {
  chrome.tabs.remove(tabId).catch(() => { /* 既に閉じている */ });
}

// タブ 1 枚分の中身 (アイコン、タイトル、音声、×)。holder は data-tab-id を持つ要素 (Today の行か、分割行のペイン)。
// 行は使い回すので、タブの ID はその時点の holder から読む
function tabParts(holder) {
  const icon = document.createElement("img");
  icon.className = "tab-icon";
  icon.alt = "";
  icon.addEventListener("error", () => { icon.style.visibility = "hidden"; });
  const title = document.createElement("span");
  title.className = "tab-title";
  const audio = document.createElement("span");
  audio.className = "tab-audio";
  audio.appendChild(uiIcon("volume", 12));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tab-close";
  close.textContent = "×";
  close.title = t("closeTabTitle");
  close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(Number(holder.dataset.tabId)); });
  holder.addEventListener("auxclick", (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab(Number(holder.dataset.tabId)); }
  });
  return [icon, title, audio, close];
}

function createTabRow(tab) {
  const row = document.createElement("div");
  row.className = "tab-row";
  row.dataset.tabId = String(tab.id);
  row.append(...tabParts(row));
  row.addEventListener("click", (e) => {
    if (e.target.closest(".tab-close")) return;
    activateTab(Number(row.dataset.tabId));
  });
  return row;
}

// 変わった部分だけ更新する (タブのタイトルや読み込み状態は頻繁に変わるので、作り直すとチカチカする)
function fillTabParts(holder, tab) {
  const title = tab.title || tab.url || tab.pendingUrl || "";
  const titleEl = holder.querySelector(".tab-title");
  if (titleEl.textContent !== title) titleEl.textContent = title;
  holder.title = title;
  const src = tabIconSrc(tab);
  const icon = holder.querySelector(".tab-icon");
  if (src && icon.dataset.src !== src) { icon.dataset.src = src; icon.style.visibility = ""; icon.src = src; }
  if (!src && icon.dataset.src) { delete icon.dataset.src; icon.removeAttribute("src"); icon.style.visibility = "hidden"; }
  holder.classList.toggle("audible", !!tab.audible);
}

// 相方が担当タブ (Today に出ない) の分割ペインは 1 枚の行になる。相方が表示中でも、このペインは見えている
function updateTabRow(row, tab) {
  fillTabParts(row, tab);
  row.classList.toggle("active", !!tab.active || splitPartners(tab).some((x) => x.active));
  row.classList.toggle("chrome-pinned", !!tab.pinned);
}

// 行に入っているタブの ID (左から)。分割行から引き出し中のペインは除く (引き出したタブを基準に位置を決めないため)
function rowTabIds(row) {
  if (!row.classList.contains("split-row")) return [Number(row.dataset.tabId)];
  return [...row.querySelectorAll(":scope > .split-pane:not(.pulled)")].map((pane) => Number(pane.dataset.tabId));
}

// 途中の状態を描かずに fn を実行し、終わってから最新のタブで描き直す
async function holdingToday(fn) {
  todayHold++;
  try {
    return await fn();
  } finally {
    todayHold--;
    if (!todayHold) { await refreshOpenTabs(); renderToday(); }
  }
}

function renderToday() {
  if (todayReorder?.isDragging() || todayHold) { todayRenderPending = true; return; }
  todayRenderPending = false;
  const list = $("#today-list");
  const tabs = todayTabs();
  const items = todayItems(tabs);
  const wanted = items.map((item) => {
    const split = item.tabs.length > 1;
    let row = todayRows.get(item.key);
    if (!row) { row = split ? createSplitRow() : createTabRow(item.tabs[0]); todayRows.set(item.key, row); }
    if (split) updateSplitRow(row, item.tabs); else updateTabRow(row, item.tabs[0]);
    return row;
  });
  const alive = new Set(items.map((item) => item.key));
  for (const [key, row] of todayRows) {
    if (!alive.has(key)) { row.remove(); todayRows.delete(key); }
  }
  for (let i = 0; i < wanted.length; i++) {
    if (list.children[i] !== wanted[i]) list.insertBefore(wanted[i], list.children[i] || null);
  }
  while (list.children.length > wanted.length) list.lastElementChild.remove();
  $("#btn-clear-today").disabled = !tabs.some(isClearable);
}

// Today 欄の行を、ピン留めタブ (pinned.js の pinnedInsertTarget) かお気に入り (sidepanel.js の favoritesInsertTarget) に落としたとき。
// 新しい項目を作り、そのタブをそのまま担当タブにする (Arc と同じで、タブは増えない)。分割行から引き出したペインなら分割を解いてから
async function dropTodayRow(target, rowEl) {
  const tabId = Number(rowEl.dataset.tabId);
  const tab = openTabs.find((x) => x.id === tabId) || await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const url = tab.url || tab.pendingUrl;
  const ownerId = target.kind === "pinned" ? (await insertPinnedTab(url, tab.title, target))?.id : await insertPin(url, tab.title, target);
  if (!ownerId) return;
  await unsplitTab(tabId);
  await adoptTab(ownerId, tabId, { chromePin: target.kind === "favorites" });
  renderPins();
  renderPinned();
  renderToday();
}

// ピン留めタブの行やお気に入りのタイルを Today 欄へドラッグしてきたときの行き先 (= 解除)。pinned.js / sidepanel.js の dropTarget から呼ぶ。
// 行の上半分ならその前、下半分ならその後ろ、行の無いところなら末尾。分割行は左のペインの前か、右のペインの後ろ (ペインの間には入れない)
function todayUnpinTarget(x, y) {
  const list = $("#today-list");
  const sec = list.closest("section").getBoundingClientRect();
  if (x < sec.left || x > sec.right || y < sec.top || y > sec.bottom) return null;
  const target = (where, el, cls, tabId) => ({ el, cls, kind: "unpin", where, tabId });
  for (const row of list.querySelectorAll(".tab-row")) {
    const r = row.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const ids = rowTabIds(row);
    return y < r.top + r.height / 2 ? target("before", row, "drop-before", ids[0]) : target("after", row, "drop-after", ids.at(-1));
  }
  return target("end", list, "drop-unpin", null);
}

// ピン留めタブの行やお気に入りのタイルを Today 欄に落としたとき (解除)。remove() で項目を消し (担当も外れる)、担当タブがあれば
// このウィンドウの落とした位置へ動かし、無ければ (開いていないピン) そこにタブを開く。Arc と同じで、項目が消えるのではなく Today のタブになる
async function unpinToToday(ownerId, url, target, remove) {
  const tab = ownedTabOf(ownerId);
  if (tab) {
    await remove();
    await moveTabTo(tab.id, target);
  } else {
    // 担当タブが無いときは、先にタブを開いてから項目を消す。開けなかったら項目を残す (消えて「戻るタブが無い」状態になるのを防ぐ)
    const index = await todayDropIndex(target, null).catch(() => undefined);
    const created = await chrome.tabs.create({ url, windowId: myWindowId, active: false, ...(index === undefined ? {} : { index }) }).catch(() => null);
    if (!created) return;
    await remove();
  }
  await refreshOpenTabs();
  renderToday();
}

// 落とした位置 (target.where と基準の行の target.tabId) の、今の並びでの境目 (at の index のタブの前)。基準のタブが分割のペインなら
// ペアの外側にする。相方が担当タブ (Today に出ない) の分割は 1 枚の行に見えるので、そのまま隣に入れるとペインの間に入って分割が解ける
async function todayDropBoundary(target) {
  const ref = await chrome.tabs.get(target.tabId);
  const span = [ref, ...(inSplit(ref) ? await chrome.tabs.query({ windowId: ref.windowId, splitViewId: ref.splitViewId }) : [])];
  const indexes = span.map((tab) => tab.index);
  return { ref, at: target.where === "before" ? Math.min(...indexes) : Math.max(...indexes) + 1 };
}

// 落とした位置にあたる Chrome のタブの index。moving は動かすタブ (新しく開くなら null)。末尾なら undefined
async function todayDropIndex(target, moving) {
  if (target.where === "end") return undefined;
  const { ref, at } = await todayDropBoundary(target);
  const above = !!moving && moving.windowId === ref.windowId && moving.index < at; // 抜いた分だけ境目が 1 つ前にずれる
  return above ? at - 1 : at;
}

// タブをこのウィンドウの target の位置へ動かす
async function moveTabTo(tabId, target) {
  try {
    const moving = await chrome.tabs.get(tabId);
    await chrome.tabs.move(tabId, { windowId: myWindowId, index: (await todayDropIndex(target, moving)) ?? -1 });
  } catch {
    // 固定タブと通常タブの境界をまたぐ移動などは Chrome が受け付けない。描き直しで元に戻る
  }
}

// 並べ替えた行の行き先: 次の行 (分割行なら左のペイン) の前、無ければ前の行 (分割行なら右のペイン) の後ろ
function todayOrderTarget(order, movedEl) {
  const i = order.indexOf(movedEl);
  const nextEl = order[i + 1], prevEl = order[i - 1];
  if (nextEl) return { where: "before", tabId: rowTabIds(nextEl)[0] };
  if (prevEl) return { where: "after", tabId: rowTabIds(prevEl).at(-1) };
  return null;
}

// 並べ替えを Chrome のタブの並びに反映する。分割行はペアごと動かす。分割行から引き出したペイン (と、相方が担当タブで 1 行に見えている
// ペイン) は分割を解いてから動かす (Chrome はペインを動かすと分割を解くが、行き先が元の場所だと動かないので、明示的に解く)
async function commitTodayOrder(order, movedEl) {
  const target = todayOrderTarget(order, movedEl);
  if (!target) return;
  await holdingToday(async () => {
    if (movedEl.classList.contains("split-row")) return moveSplitTo(rowTabIds(movedEl), target);
    const tabId = Number(movedEl.dataset.tabId);
    await unsplitTab(tabId);
    await moveTabTo(tabId, target);
  });
}

// 一括アーカイブの対象: 表示中・固定以外で、http(s) のタブか空の新しいタブ (background.js の archiveTabsById と同じ判定)
function tabClearable(tab) {
  const url = tab.url || tab.pendingUrl || "";
  // シークレットウィンドウのタブは対象外 (background.js と同じ判定)
  return !tab.active && !tab.pinned && !tab.incognito && (/^https?:/.test(url) || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(url));
}

// 分割表示のペインは、相方も対象のときだけ (表示中の分割の見えている片方を閉じない。片付けるならペアごと。background.js の wholeSplits と同じ)
function isClearable(tab) {
  const owned = new Set(Object.values(ownedTabs));
  return [tab, ...splitPartners(tab)].every((x) => tabClearable(x) && !owned.has(x.id));
}

async function clearToday() {
  const ids = todayTabs().filter(isClearable).map((tab) => tab.id);
  if (!ids.length) return;
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "archive-tabs", tabIds: ids }); } catch { res = null; }
  if (res?.count) flash(tn("archivedToast", res.count));
}

// ---------- アーカイブ画面 ----------
async function renderArchive() {
  const { archive = [] } = await chrome.storage.local.get("archive");
  const list = $("#archive-list");
  list.innerHTML = "";
  $("#archive-empty").hidden = archive.length > 0;
  $("#btn-archive-clear").disabled = archive.length === 0;
  for (const entry of archive) {
    const row = document.createElement("div");
    row.className = "tab-row archive-row";
    const icon = document.createElement("img");
    icon.className = "tab-icon";
    icon.alt = "";
    icon.src = entry.favIconUrl || faviconUrl(entry.url);
    icon.addEventListener("error", () => { icon.src = faviconUrl(entry.url); }, { once: true });
    const text = document.createElement("div");
    text.className = "archive-text";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = entry.title || entry.url;
    const meta = document.createElement("div");
    meta.className = "archive-meta";
    let host = entry.url;
    try { host = new URL(entry.url).hostname; } catch { /* そのまま */ }
    meta.textContent = `${host} · ${relTime(entry.archivedAt)}`;
    text.append(title, meta);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "tab-close";
    del.textContent = "×";
    del.title = t("archiveDeleteTitle");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "archive-remove", ids: [entry.id] }).catch(() => {});
    });
    row.append(icon, text, del);
    row.title = `${t("archiveRestoreTitle")}: ${entry.url}`;
    row.addEventListener("click", async () => {
      await chrome.tabs.create({ url: entry.url, windowId: myWindowId, active: true });
      chrome.runtime.sendMessage({ type: "archive-remove", ids: [entry.id] }).catch(() => {});
    });
    list.appendChild(row);
  }
}

function showArchive() {
  if (!$("#view-main").hidden) mainScrollY = window.scrollY;
  $("#view-main").hidden = true;
  $("#view-settings").hidden = true;
  $("#view-archive").hidden = false;
  window.scrollTo(0, 0);
  renderArchive();
}

function hideArchive() {
  $("#view-archive").hidden = true;
  showMain();
}

// ---------- 初期化 ----------
async function initToday() {
  myWindowId = (await chrome.windows.getCurrent()).id;
  todayReorder = setupLiveReorder({
    container: $("#today-list"),
    itemSelector: ".tab-row",
    canStart: (e) => !e.target.closest(".tab-close"),
    onCommit: commitTodayOrder,
    onEnd: () => renderToday(),
    // 上のセクションへ持っていくとピン留め / お気に入りに。分割行 (ペアごと) はどちらにも分割項目として入れられる
    dropTarget: (x, y) => pinnedInsertTarget(x, y) || favoritesInsertTarget(x, y),
    detach: todayDetach, // 分割行のペインをつかむと、その 1 枚だけを引き出す
    combineTarget: todaySplitTarget, // 行を別の行の真ん中に重ねると分割表示に
    onDrop: (target, el) => {
      if (target.kind === "split") return splitTodayRows(target, el);
      return el.classList.contains("split-row") ? dropTodaySplitRow(target, el) : dropTodayRow(target, el); // 分割行は dataset.tabId を持たない
    },
  });
  $("#btn-new-tab").addEventListener("click", () => chrome.tabs.create({ windowId: myWindowId }));
  $("#btn-clear-today").addEventListener("click", clearToday);
  $("#btn-archive").addEventListener("click", showArchive);
  $("#btn-archive-back").addEventListener("click", hideArchive);
  $("#btn-archive-clear").addEventListener("click", () => chrome.runtime.sendMessage({ type: "archive-clear" }).catch(() => {}));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#view-archive").hidden) hideArchive();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.archive && !$("#view-archive").hidden) renderArchive();
  });

  // タブの変化を Today 欄とピン (ライブなアイコン) に反映する。短時間にまとめて来るので少し待ってから 1 回だけ
  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { await refreshOpenTabs(); renderToday(); renderPins(); renderPinned(); }, 40); // ピン留めタブのライブなアイコンと「開いている」印も追従
  };
  chrome.tabs.onActivated.addListener(refresh);
  chrome.tabs.onMoved.addListener(refresh);
  chrome.tabs.onAttached.addListener(refresh);
  chrome.tabs.onDetached.addListener(refresh);
  chrome.tabs.onCreated.addListener(refresh);
  chrome.tabs.onRemoved.addListener(refresh);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if ("title" in info || "favIconUrl" in info || "url" in info || "pinned" in info || "audible" in info || "status" in info || "splitViewId" in info) refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.ownedTabs) refresh(); // 担当タブは Today 欄に出さない
  });
  renderToday();
}
