// サイドパネル UI: ピン留めグリッドと GitHub ライブフォルダ

const $ = (sel) => document.querySelector(sel);
// settings は chrome.storage.sync (端末間で同期)。token (GitHub PAT) だけは同期しない約束
// (README) なので、chrome.storage.local の githubToken に分け、読み込みでここに合流させる
const DEFAULT_SETTINGS = {
  host: "github.com", token: "", intervalMin: 3,
  showMine: true, showReviews: true, includeTeamRequests: true, maxPins: 20,
  pinOwnedTabs: true,    // 担当タブを Chrome の固定タブにする
  pinTint: true,         // ピンの背景をアイコンの色にする
  pinHints: true,        // タイルの下端に短い名前をうっすら出す (収まる最初の数文字だけ)
  autoArchiveHours: 12,  // 見ていないタブを自動でアーカイブするまでの時間 (0 でしない)
  ghDedicatedTab: true,  // PR は PR ごとの専用タブで開く (タブを使い回す)
  // 見た目 (appearance.js。値の一覧と、壊れた値を既定に戻す appearanceOf もそちら)
  theme: "auto",         // auto (OS に従う) / light / dark
  tint: "neutral",       // サイドバー全体の色味 (カラーテーマ。面の色)。アクセント色 (強調) とは独立
  accent: "indigo",      // アクセント色
  bgTransparency: 60,    // 背景画像の透明度 (%)。0 で画像そのまま、100 で見えない。画像は storage.local の backgroundImage
  bgPosition: "center center",
  bgRepeat: "no-repeat",
  bgSize: "cover",       // cover (全体を覆う) / width (幅に合わせる) / auto (原寸)
  bgScale: 100,          // 原寸 (auto) の拡大率 (%)。繰り返しの有無にかかわらず効く
  bgNoise: true,         // 背景のグラデーションに重ねるザラザラした質感
};

let pins = [];
let settings = { ...DEFAULT_SETTINGS };
let editing = false;
let openTabs = [];
let pinCurrentTitle = ""; // 「現在のタブをピン留め」+ 実際のショートカット (applyShortcutLabels で設定)

// ---------- 共通 ----------
// 旧版の local.settings からの一度きりの移行: sync が空なら local を seed (token 抜き)、
// 両方あれば sync を正とする。移したあと local.settings は消す。何度呼んでもよい
// (background.js にも同じものがある。SW は別コンテキストなので複製)
async function migrateSettings() {
  const [{ settings: synced }, local] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get(["settings", "githubToken"]),
  ]);
  const legacy = local.settings;
  if (!legacy) return;
  if (synced === undefined) {
    const seeded = { ...legacy };
    delete seeded.token;
    await chrome.storage.sync.set({ settings: seeded });
  }
  if (legacy.token && local.githubToken === undefined) {
    await chrome.storage.local.set({ githubToken: legacy.token });
  }
  await chrome.storage.local.remove("settings");
}

async function loadSettings() {
  await migrateSettings();
  const [{ settings: s }, { githubToken }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("githubToken"),
  ]);
  settings = { ...DEFAULT_SETTINGS, ...(s || {}), token: githubToken || "" };
}

// sync に書く settings (token は同期しないので外す)
function syncedSettings() {
  const { token: _token, ...rest } = settings;
  return rest;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function refreshOpenTabs() {
  openTabs = await chrome.tabs.query({});
}

function findTabForUrl(url, { exact = false } = {}) {
  const origin = originOf(url);
  const exactHit = openTabs.find((t) => t.url === url);
  if (exactHit || exact) return exactHit || null;
  return openTabs.find((t) => originOf(t.url) === origin) || null;
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function openOrFocus(url, { exact = false } = {}) {
  const tab = findTabForUrl(url, { exact });
  if (tab) return focusTab(tab);
  await chrome.tabs.create({ url });
}

// 末尾スラッシュとハッシュの違いは同じページとみなす
function sameUrl(a, b) {
  const norm = (u) => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return u; } };
  return norm(a) === norm(b);
}

// tabUrl が PR ページそのもの、またはそのサブページ (/files, /commits, /checks …) なら true。クエリとハッシュは無視
function inPr(tabUrl, prUrl) {
  try {
    const a = new URL(tabUrl), b = new URL(prUrl);
    const base = b.pathname.replace(/\/$/, "");
    return a.origin === b.origin && (a.pathname.replace(/\/$/, "") === base || a.pathname.startsWith(base + "/"));
  } catch { return false; }
}

// ---------- 担当タブ (Arc のお気に入り / ライブフォルダの挙動) ----------
// ピンごと、および GitHub の PR ごとに「担当タブ」を 1 枚ずつ持ち、クリックは常にそのタブに戻る。
// タブが増えないのが狙い。
//  - 対応表 ownedTabs { owner: tabId } は chrome.storage.session (タブ ID はブラウザ再起動で変わるため)
//  - 各担当タブの最終 URL ownedUrls { owner: url } は background.js が storage.local に記録する。
//    再起動後、閲覧先へ移動したまま復元された担当タブもこれで結び直す
//  - 拡張が固定したタブ ownedPinned { owner: true } は storage.local。固定解除はこれに載っているタブだけにして、
//    ユーザーが自分で固定していたタブは触らない
//  - 自動で結び付けるのは URL が一致するタブだけ。同じサイトの別ページのタブは推測で奪わない。単独の項目は分割表示のペインも奪わない (分割項目は自分の 2 URL と一致する生きたペアだけ採用)
// GitHub の PR の担当 ID は "gh:<PR の URL>"。固定タブにはしない (ピン留めタブの一覧と同じ扱い)
const GH_PREFIX = "gh:";
const ghOwnerId = (prUrl) => GH_PREFIX + prUrl;
const isGhOwner = (ownerId) => ownerId.startsWith(GH_PREFIX);
let ghData = {}; // storage.local の github (担当先の一覧に使うので、同期で引けるよう写しを持つ)
let ownedTabs = {}; // { [ownerId]: tabId }

async function getOwnedPinned() {
  const { ownedPinned } = await chrome.storage.local.get("ownedPinned");
  return ownedPinned || {};
}
async function setOwnedPinned(ownerId, value) {
  const op = await getOwnedPinned();
  if (value) op[ownerId] = true; else delete op[ownerId];
  await chrome.storage.local.set({ ownedPinned: op });
}
// 担当タブを固定する (固定したことを記録)
async function pinOwnedTab(ownerId, tab, chromePin = settings.pinOwnedTabs) {
  if (!chromePin || !tab || tab.pinned) return;
  try {
    await chrome.tabs.update(tab.id, { pinned: true });
    await setOwnedPinned(ownerId, true);
  } catch { /* 閉じられた等 */ }
}

async function loadOwnedTabs() {
  const { ownedTabs: o } = await chrome.storage.session.get("ownedTabs");
  ownedTabs = o || {};
}
async function bindOwnedTab(ownerId, tabId) {
  ownedTabs = { ...ownedTabs, [ownerId]: tabId };
  await chrome.storage.session.set({ ownedTabs });
}
// 開いているタブをそのまま ownerId の担当タブにする (いま見ているタブのピン留め、Today 欄からのドラッグ、お気に入り ⇄ ピン留めタブの移動)。
// 別の担当になっているタブは奪わない。chromePin なら設定に従って Chrome の固定タブにする (お気に入りだけ)
async function adoptTab(ownerId, tabId, { chromePin = false } = {}) {
  if (Object.values(ownedTabs).includes(tabId)) return;
  await bindOwnedTab(ownerId, tabId);
  await refreshOpenTabs();
  if (chromePin) await pinOwnedTab(ownerId, openTabs.find((tab) => tab.id === tabId));
  await refreshOpenTabs();
}
// 担当タブ (owned tab) を別の持ち主へそのまま移す (お気に入り ⇄ ピン留めタブの移動)。タブは増やさない。
// 旧持ち主を先に外して新持ち主に結び、そのあとで旧エントリ (お気に入り / ピン留めタブ) を消す。こうすると、消すことで走る
// orphan 掃除 (storage 変更 → pruneOrphanOwners) と removePin 側の releaseOwnedTab がどちらも旧持ち主を空振りする
// (二重に releaseOwnedTab が走って固定解除を取りこぼす不具合を防ぐ)。Chrome の固定は移動先に合わせる
// (ピン留めタブは固定しない = 外す、お気に入りは設定に従って付ける)。
async function transferOwnedTab(fromOwner, toOwner, { chromePin = false } = {}) {
  const tabId = ownedTabs[fromOwner];
  if (tabId === undefined) return;
  const wasPinnedByUs = !!(await getOwnedPinned())[fromOwner];
  const { [fromOwner]: _drop, ...rest } = ownedTabs;
  ownedTabs = { ...rest, [toOwner]: tabId };
  await chrome.storage.session.set({ ownedTabs });
  if (wasPinnedByUs) await setOwnedPinned(fromOwner, false);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (chromePin) await pinOwnedTab(toOwner, tab); // お気に入り: 設定に従って固定 (ownedPinned[toOwner] も立てる)
  else if (wasPinnedByUs && tab.pinned) { try { await chrome.tabs.update(tabId, { pinned: false }); } catch { /* 既に閉じている */ } } // ピン留めタブ: 固定を外す
}
async function unbindOwnedTab(ownerId) {
  if (!(ownerId in ownedTabs)) return;
  const { [ownerId]: _removed, ...rest } = ownedTabs;
  ownedTabs = rest;
  await chrome.storage.session.set({ ownedTabs });
}
function ownedTabOf(ownerId) {
  const id = ownedTabs[ownerId];
  return id === undefined ? null : openTabs.find((tab) => tab.id === id) || null;
}
// 閉じられたタブへの対応を掃除する。openTabs は (破棄で ID が変わった直後などに) 古いことがあるので、タブ一覧を取り直してから判定する
async function pruneOwnedTabs() {
  await refreshOpenTabs();
  const alive = new Set(openTabs.map((tab) => tab.id));
  const living = (o) => Object.fromEntries(Object.entries(o).filter(([, id]) => alive.has(id)));
  if (Object.keys(living(ownedTabs)).length === Object.keys(ownedTabs).length) return;
  ownedTabs = living(ownedTabs);
  const { ownedTabs: latest = {} } = await chrome.storage.session.get("ownedTabs"); // 保存済みの最新値から、閉じたものだけを外す
  await chrome.storage.session.set({ ownedTabs: living(latest) });
}

// 破棄 (メモリセーバー / chrome.tabs.discard) でタブ ID が変わったときの担当の付け替え。旧 ID を持つ担当を全部、保存済みの最新値から付け替える
// (分割項目のペアを破棄すると 2 回続けて来るので、get → set を直列化して、後の書き込みが先の付け替えを上書きしないようにする。
// 背景の onReplaced も同じ付け替えをする。どちらも冪等で、結果は同じになる)
let repointQueue = Promise.resolve();
function repointOwnedTab(addedTabId, removedTabId) {
  repointQueue = repointQueue.catch(() => {}).then(async () => {
    const { ownedTabs: latest = {} } = await chrome.storage.session.get("ownedTabs");
    const owners = Object.keys(latest).filter((k) => latest[k] === removedTabId);
    if (!owners.length) return;
    ownedTabs = { ...latest, ...Object.fromEntries(owners.map((k) => [k, addedTabId])) };
    await chrome.storage.session.set({ ownedTabs });
  });
  return repointQueue;
}

// 担当タブで開く。
//  - 担当タブがあればそこへ切り替える。すでにそのタブを見ていて登録 URL から離れていれば、登録 URL に戻す (Arc と同じ)
//  - なければ、URL が一致する既存タブ (GitHub は同じ PR のサブページも含む) を担当にする
//  - それも無ければ新しいタブを作って担当にする
//  navigate=true (GitHub 用) のときは、担当タブが PR 以外へ移っていれば指定の PR へ戻す
//  (同じ PR の Files changed などを見ているときは移動しない)
const ownedInFlight = new Map(); // ownerId -> Promise (連打でタブが重複しないよう直列化)
function openOwned(ownerId, url, opts = {}) {
  const prev = ownedInFlight.get(ownerId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => openOwnedNow(ownerId, url, opts));
  ownedInFlight.set(ownerId, next);
  next.finally(() => { if (ownedInFlight.get(ownerId) === next) ownedInFlight.delete(ownerId); });
  return next;
}

// ピンの担当タブを登録 URL で開いた/戻したタブ。読み込み完了時に、リダイレクト先 (別ドメインでも) のアイコンを
// そのピンのアイコンとして保存する (未保存のときだけ)。tabId -> pinUrl
const freshPinTabs = new Map();
function markFresh(ownerId, tabId, url) {
  if (!isGhOwner(ownerId)) freshPinTabs.set(tabId, url);
}

async function openOwnedNow(ownerId, url, { navigate = false, chromePin = settings.pinOwnedTabs } = {}) {
  await refreshOpenTabs();
  await pruneOwnedTabs();
  let tab = ownedTabOf(ownerId);
  if (tab) {
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const lookingAtIt = !!current && current.id === tab.id;
    if (!sameUrl(tab.url, url) && (lookingAtIt || (navigate && !inPr(tab.url, url)))) {
      await chrome.tabs.update(tab.id, { url });
      markFresh(ownerId, tab.id, url);
    }
    return focusTab(tab);
  }

  // URL が一致する空きタブを担当にする。await より前に対応表へ載せ、並行するクリックに奪われないようにする。
  // 分割表示のペインは奪わない (固定すると分割が解け、Today 欄でも分割の片方だけが消える)
  const taken = new Set(Object.values(ownedTabs));
  tab = openTabs.find((t) => !taken.has(t.id) && !inSplit(t) && /^https?:/.test(t.url || "")
    && (navigate ? inPr(t.url, url) : sameUrl(t.url, url)));
  if (tab) {
    await bindOwnedTab(ownerId, tab.id);
    await pinOwnedTab(ownerId, tab, chromePin);
    return focusTab(tab);
  }

  tab = await chrome.tabs.create({ url, pinned: !!chromePin, active: true });
  markFresh(ownerId, tab.id, url);
  await bindOwnedTab(ownerId, tab.id);
  if (chromePin) await setOwnedPinned(ownerId, true);
}

// 担当タブを持ちうるもの全部: お気に入り (pins)、ピン留めタブの一覧 (pinned.js)、GitHub の PR (一覧に出ているもの)。
//  list: Chrome の固定タブにしない担当先 (ピン留めタブ・PR)  gh: PR (アイコンの保存・掃除の対象にはしない)
function allOwnerTargets() {
  return [
    ...flatPins().map((p) => ({ id: p.id, url: p.url })), // 分割項目はペインごと
    ...allPinnedTabs().map((n) => ({ id: n.id, url: n.url, list: true })),
    ...ghPrTargets(),
  ];
}
// 一覧に見えている PR (専用タブの設定がオン、トークンあり、フォルダの表示がオン)。同じ PR が両方のフォルダにあっても 1 件
function ghPrTargets() {
  if (!settings.ghDedicatedTab || !settings.token) return [];
  const prs = [...(settings.showMine ? ghData.mine || [] : []), ...(settings.showReviews ? ghData.reviews || [] : [])];
  return [...new Map(prs.map((pr) => [ghOwnerId(pr.url), { id: ghOwnerId(pr.url), url: pr.url, list: true, gh: true }])).values()];
}
const listOwnerIds = () => new Set(allOwnerTargets().filter((p) => p.list).map((p) => p.id)); // 固定タブでなくてよい担当先

// タブの読み込みが終わったら、関係するピンのアイコンを保存する
//  - そのピンの担当タブで、登録 URL と同じサイトにいる: 上書き保存 (サイトのアイコン変更に追従)
//  - 登録 URL と同じページ: 上書き保存
//  - 同じサイトでアイコン未保存のピン: 保存
//  - ピンから開いた直後の読み込み (リダイレクト先が別ドメインでも): 未保存のときだけ保存
function captureIconsOnLoad(tab) {
  if (!/^https?:/.test(tab.url || "")) return;
  const origin = originOf(tab.url);
  const targets = [];
  for (const pin of allOwnerTargets().filter((p) => !p.gh)) {
    const sameSite = originOf(pin.url) === origin;
    if ((ownedTabs[pin.id] === tab.id && sameSite) || sameUrl(pin.url, tab.url)) targets.push({ url: pin.url, overwrite: true });
    else if (sameSite && !iconStore[pin.url]) targets.push({ url: pin.url, overwrite: false });
  }
  const freshUrl = freshPinTabs.get(tab.id);
  if (freshUrl) {
    freshPinTabs.delete(tab.id);
    if (!targets.some((tg) => tg.url === freshUrl)) targets.push({ url: freshUrl, overwrite: false });
  }
  captureIconForTab(tab, targets);
}

// 担当タブを持たない担当先を、固定タブに結び直す (ブラウザ再起動や拡張の再読み込みの直後)。
//  1) 最後に表示していた URL (background.js が記録) と一致する固定タブ
//  2) 登録 URL と一致する固定タブ
// 同じサイトの別ページまでは推測しない (ユーザーが自分で固定したタブや別ピンのタブを奪わないため)。
// お気に入り・GitHub は「固定タブにする」設定がオンなら固定タブだけを候補にする。ピン留めタブの一覧は
// Chrome の固定タブにしない (pinned.js) ので通常のタブも候補にする (クリック時の openOwnedNow と同じ基準)。
// 同じ規則を background.js の reconcileOwnedTabsIfWiped も持つ (パネルが開かれる前の自動アーカイブ対策)。
async function reconcileOwnedTabs() {
  const { ownedUrls = {} } = await chrome.storage.local.get("ownedUrls");
  const taken = new Set(Object.values(ownedTabs));
  const listOwned = listOwnerIds();
  const owners = allOwnerTargets().map((p) => [p.id, p.url]);
  let changed = false;
  const tryBind = (id, url) => {
    if (!url || ownedTabs[id] !== undefined) return;
    const mustBePinned = settings.pinOwnedTabs && !listOwned.has(id);
    const tab = openTabs.find((t) => (!mustBePinned || t.pinned) && !taken.has(t.id) && /^https?:/.test(t.url || "") && sameUrl(t.url, url));
    if (tab) { ownedTabs[id] = tab.id; taken.add(tab.id); changed = true; }
  };
  for (const [id] of owners) tryBind(id, ownedUrls[id]);
  for (const [id, url] of owners) tryBind(id, url);
  if (changed) {
    ownedTabs = { ...ownedTabs };
    await chrome.storage.session.set({ ownedTabs });
  }
}

// 担当をやめる (ピン削除時など): 結び付きを外し、拡張が固定したタブなら通常のタブに戻す (Arc で Today に戻るのと同じ)
async function releaseOwnedTab(ownerId) {
  const tabId = ownedTabs[ownerId]; // 対応表から直接取る。ownedTabOf (openTabs のキャッシュ) は担当の付け替えと前後して古く、null を返すことがある
  await unbindOwnedTab(ownerId);
  const op = await getOwnedPinned();
  const pinnedByUs = !!op[ownerId];
  if (pinnedByUs) await setOwnedPinned(ownerId, false);
  // 拡張が固定したタブ (pinnedByUs が正。都度 storage から読む) は通常タブに戻す。既に固定が無い / 閉じている場合も update は無害。
  // tab.pinned (キャッシュ) では判定しない。お気に入り → ピン留めタブの移動で openTabs が古く、固定解除を取りこぼしていた
  if (pinnedByUs && tabId !== undefined && !Object.values(ownedTabs).includes(tabId)) {
    try { await chrome.tabs.update(tabId, { pinned: false }); } catch { /* 既に閉じている */ }
  }
}

// 担当先がもう存在しない対応を外す (別の端末でピンが削除された / PR が一覧から消えた / GitHub 専用タブをオフにした)
async function pruneOrphanOwners() {
  const valid = new Set(allOwnerTargets().map((p) => p.id)); // 旧 "github" 担当もここで外れる
  for (const ownerId of Object.keys(ownedTabs)) {
    if (!valid.has(ownerId)) await releaseOwnedTab(ownerId);
  }
}

// 設定「固定タブにする」の切り替えを、いま生きている担当タブに反映する。
// オンにしたときはお気に入りの担当タブを固定し (ピン留めタブの一覧と PR は固定しない)、
// オフにしたときは拡張が固定したタブだけ固定を外す (以前に固定されてしまった一覧のタブも ownedPinned にあれば外す)。
// お気に入りの分割項目のペインは 1 枚ずつ付け外すと分割が解けるので、ループから除き、あとで組まれていたものだけ組み直す (setPanePinned + assembleSplit)
async function applyPinnedSetting(pinned) {
  await holdingToday(async () => {
    await refreshOpenTabs();
    const op = await getOwnedPinned();
    const listOwned = listOwnerIds();
    const splits = pins.filter(isSplitItem);
    const splitPanes = new Set(splits.flatMap((p) => p.children.map((c) => c.id)));
    const wasSplit = new Set(splits.filter((p) => {
      const [a, b] = p.children.map((c) => ownedTabOf(c.id));
      return a && b && inSplit(a) && a.splitViewId === b.splitViewId;
    }).map((p) => p.id));
    for (const [ownerId, id] of Object.entries(ownedTabs)) {
      const tab = openTabs.find((t) => t.id === id);
      if (!tab || splitPanes.has(ownerId)) continue;
      if (pinned && !tab.pinned && !listOwned.has(ownerId)) {
        try { await chrome.tabs.update(tab.id, { pinned: true }); op[ownerId] = true; } catch { /* ignore */ }
      } else if (!pinned && tab.pinned && op[ownerId]) {
        try { await chrome.tabs.update(tab.id, { pinned: false }); } catch { /* ignore */ }
        delete op[ownerId];
      }
    }
    await chrome.storage.local.set({ ownedPinned: op });
    for (const item of splits) {
      const tabs = item.children.map((c) => ownedTabOf(c.id));
      if (wasSplit.has(item.id)) await assembleSplit(tabs.map((tab) => tab.id), { pinned });
      else await setPanePinned(item.children.map((c, i) => [c.id, tabs[i]?.id]), pinned);
    }
  });
}

// Chrome が実際に割り当てているショートカットをツールチップに付ける (環境ごとの表記、再割り当てにも追従)
async function applyShortcutLabels() {
  const label = t("cmdPinCurrentTab");
  pinCurrentTitle = label;
  try {
    const cmds = await chrome.commands.getAll();
    const sc = cmds.find((c) => c.name === "pin-current-tab")?.shortcut;
    if (sc) pinCurrentTitle = t("withShortcut", [label, sc]);
  } catch {
    // ショートカット無しの表記のまま
  }
  $("#btn-pin-current").title = pinCurrentTitle;
}

function relTime(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - new Date(ts).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return t("timeJustNow");
  if (m < 60) return tn("timeMinutesAgo", m);
  const h = Math.floor(m / 60);
  if (h < 24) return tn("timeHoursAgo", h);
  const d = Math.floor(h / 24);
  return tn("timeDaysAgo", d);
}

// ---------- ピン留め ----------
async function loadPins() {
  const { pins: p = [] } = await chrome.storage.sync.get("pins");
  pins = sanitizedPins(p); // 壊れた分割項目は平らな項目へ (split-items.js)
}

async function savePins() {
  await chrome.storage.sync.set({ pins });
}

// 保存に失敗したら (同期ストレージの容量超過など) 元に戻して知らせる
async function persistPins(prev) {
  try {
    await savePins();
    return true;
  } catch {
    pins = prev;
    flash(t("pinStorageFull"));
    return false;
  }
}

// グリッドの描き直しは、変わったタイルだけ作り直す差分方式にする。
// 全部作り直すと、タブの読み込みなどのたびにアイコン画像が一瞬消え、編集モードの揺れも最初からやり直しになって
// チカチカして見えるため。タイルの中身 (URL・タイトル・アイコン・背景色) が同じなら同じ要素を使い回し、
// 並びが変わった要素だけを動かす。
const pinTiles = new Map(); // pinId -> { el, sig }
let addTile = null;

function pinById(id) {
  return pins.find((p) => p.id === id) || null;
}

function pinSignature(pin) {
  const one = (p) => { const icon = iconStore[p.url]; return [p.id, p.url, p.title || "", icon ? icon.length : 0, icon ? icon.slice(-16) : ""]; };
  return JSON.stringify([isSplitItem(pin) ? pin.children.map(one) : one(pin), !!settings.pinTint]);
}

function createPinTile(pin) {
  const el = document.createElement("div");
  el.className = "pin";
  el.dataset.id = pin.id;
  el.title = pin.title || pin.url;

  el.appendChild(iconElement(pin.url));
  if (settings.pinTint) {
    const known = cachedTint(pin.url);
    if (known !== undefined) applyTint(el, known);
    else computeTint(pin.url).then((tint) => { if (el.isConnected && settings.pinTint) applyTint(el, tint); });
  }

  const rm = document.createElement("button");
  rm.className = "remove";
  rm.textContent = "×";
  rm.title = t("removeTitle");
  rm.addEventListener("click", (e) => { e.stopPropagation(); removePin(el.dataset.id); });
  el.appendChild(rm);

  // 要素は使い回すので、ハンドラでは毎回 ID から最新のピンを引く
  // 通常クリック: 担当タブへ (Arc のお気に入りと同じ)。⌘クリック / 中クリック: 別の新しいタブで開く
  el.addEventListener("click", (e) => {
    // ダブルクリックの 2 回目は無視する (切り替えた直後に登録 URL へ戻してしまわないように)
    if (editing || e.detail > 1) return;
    const p = pinById(el.dataset.id);
    if (!p) return;
    if (e.metaKey || e.ctrlKey) chrome.tabs.create({ url: p.url, active: false });
    else openOwned(p.id, p.url);
  });
  el.addEventListener("auxclick", (e) => {
    const p = pinById(el.dataset.id);
    if (e.button === 1 && !editing && p) { e.preventDefault(); chrome.tabs.create({ url: p.url, active: false }); }
  });
  el.addEventListener("dblclick", (e) => { if (!e.target.closest(".remove")) startPinRename(el); });
  return el;
}

// ダブルクリックでその場で名前変更 (編集モードでなくてもよい。Arc と同じで、1 回目のクリックでタブは切り替わる)。
// タイルは小さいので、タイルの下に浮かぶ入力欄に打つ。Enter で確定、Esc で取消、フォーカスが外れたら確定。ダイアログは出さない
function startPinRename(el, id = el.dataset.id) { // 分割項目はペイン (id) ごと。入力欄はタイルの下に出す
  const p = pinLeaf(id);
  if (!p || document.querySelector(".rename-pop")) return;
  const pop = document.createElement("div");
  pop.className = "rename-pop";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = p.title || "";
  input.setAttribute("aria-label", t("renamePrompt"));
  pop.appendChild(input);
  const r = el.getBoundingClientRect();
  const panelWidth = document.documentElement.clientWidth;
  const width = Math.min(220, panelWidth - 16);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, panelWidth - width - 8))}px`;
  pop.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(pop);
  let done = false;
  const onScroll = (e) => { if (!pop.contains(e.target)) finish(true); }; // 位置が固定なので、パネルがスクロールしたら閉じる (入力欄自身の横スクロールは除く)
  const refocus = () => { if (!done && input.isConnected) input.focus(); };
  const finish = async (commit) => {
    if (done) return;
    done = true;
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("focus", refocus);
    pop.remove();
    const name = input.value.trim();
    const cur = pinLeaf(p.id);
    if (!commit || !cur || name === (cur.title || "")) return;
    const prev = pins.slice();
    const title = name || cur.url;
    pins = pins.map((x) => (isSplitItem(x) ? { ...x, children: x.children.map((c) => (c.id === p.id ? { ...c, title } : c)) } : x.id === p.id ? { ...x, title } : x));
    await persistPins(prev);
    renderPins();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // Esc で編集モードを抜けない
    if (e.isComposing || e.keyCode === 229) return; // IME の変換確定 / 取消の Enter・Esc は入力欄のまま
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => attachRenameBlur(input, refocus, () => done, finish)); // pinned.js: パネル外へ出た blur では確定しない
  document.addEventListener("scroll", onScroll, true);
  for (const type of ["pointerdown", "click", "dblclick"]) pop.addEventListener(type, (e) => e.stopPropagation());
  input.focus();
  input.select();
}

// 担当タブが開いている間は、タブの現在のファビコンを出す (Gmail の未読数や Slack の通知の赤丸などが Arc と同じように出る)。
// 新しい画像が読み込めてから差し替えるので、切り替わりでアイコンが一瞬消えない。読み込めなければ保存済みのアイコンのまま。
function applyLiveIcon(el, pin) {
  const tab = ownedTabOf(pin.id);
  const live = tab && /^(https?:|data:)/.test(tab.favIconUrl || "") ? tab.favIconUrl : null;
  const base = el.querySelector(":scope > img:not(.live-icon), :scope > .fallback");
  let liveImg = el.querySelector(":scope > img.live-icon");
  if (!live) {
    if (liveImg) liveImg.remove();
    if (base) base.hidden = false;
    return;
  }
  if (liveImg && liveImg.dataset.src === live) return;
  if (!liveImg) {
    liveImg = document.createElement("img");
    liveImg.className = "live-icon";
    liveImg.alt = "";
    liveImg.hidden = true;
    el.insertBefore(liveImg, el.firstChild);
  }
  liveImg.dataset.src = live;
  const probe = new Image();
  probe.onload = () => {
    if (liveImg.dataset.src !== live || !liveImg.isConnected) return;
    liveImg.src = live;
    liveImg.hidden = false;
    const b = el.querySelector(":scope > img:not(.live-icon), :scope > .fallback");
    if (b) b.hidden = true;
  };
  probe.onerror = () => {
    if (liveImg.dataset.src !== live) return;
    liveImg.remove();
    const b = el.querySelector(":scope > img:not(.live-icon), :scope > .fallback");
    if (b) b.hidden = false;
  };
  probe.src = live;
}

// タイルの下端に出す短い名前。タブのタイトルから「 - Google ドキュメント」のようなサービス名の末尾を落として先頭を使う。
// 表示名を変えればそれが使われる (編集モードでダブルクリック)
function pinHintText(pin) {
  let t = (pin.title || "").trim();
  if (!t || t === pin.url) {
    try { t = new URL(pin.url).hostname.replace(/^www\./, ""); } catch { t = ""; }
  }
  for (const sep of [" - ", " | ", " – ", " — ", " · ", "｜", " : "]) {
    const i = t.indexOf(sep);
    if (i > 0) t = t.slice(0, i);
  }
  return t.replace(/\s+/g, " ").trim().slice(0, 16);
}

// お気に入りの編集モード (ピン留めタブの編集は pinned.js の setPinnedEditing で別に持つ)
function setEditing(on) {
  editing = on;
  renderPins();
}

function renderPins() {
  // 並べ替えのドラッグ中に描き直すと、つかんでいるタイルが動いてしまうので、離すまで保留する
  if (pinReorder?.isDragging()) { pinRenderPending = true; return; }
  pinRenderPending = false;
  const grid = $("#pin-grid");
  grid.classList.toggle("editing", editing);

  // 同じアイコンのお気に入りを見分けるため、色相と明るさを少しずつずらす段数を決める (2 つ目 +1、3 つ目 -1、4 つ目 +2 …)。
  // 「同じアイコン」は、保存済みアイコンの画像が同じか、無ければ同じサイト (Chrome の favicon はサイト単位) とみなす
  // 分割項目のタイルは左のペイン基準 (色味も)
  const iconKey = (p0) => { const p = itemTabs(p0)[0]; return iconStore[p.url] || originOf(p.url) || p.url; };
  const groupCount = new Map();
  for (const p of pins) { const k = iconKey(p); groupCount.set(k, (groupCount.get(k) || 0) + 1); }
  const seenInGroup = new Map();

  const wanted = [];
  const alive = new Set();
  for (const pin of pins) {
    alive.add(pin.id);
    const sig = pinSignature(pin);
    let entry = pinTiles.get(pin.id);
    if (!entry || entry.sig !== sig) {
      const el = isSplitItem(pin) ? createSplitTile(pin) : createPinTile(pin);
      if (entry) entry.el.replaceWith(el);
      entry = { el, sig };
      pinTiles.set(pin.id, entry);
    }
    if (isSplitItem(pin)) updateSplitTile(entry.el, pin); // 「開いている」印とライブなアイコンはペインごと
    else {
      entry.el.classList.toggle("open", !!ownedTabOf(pin.id));
      applyLiveIcon(entry.el, pin);
    }
    const key = iconKey(pin);
    const idx = seenInGroup.get(key) || 0;
    seenInGroup.set(key, idx + 1);
    const step = groupCount.get(key) > 1 && idx > 0 ? (idx % 2 ? 1 : -1) * Math.ceil(idx / 2) : 0;
    entry.el.style.setProperty("--tint-step", String(step));
    entry.el.style.setProperty("--tint-abs", String(Math.abs(step)));
    entry.el.classList.toggle("dup", step !== 0);
    // タイルの下端に短い名前をうっすら出す (収まる最初の数文字だけ)
    const hinted = settings.pinHints;
    let label = entry.el.querySelector(":scope > .hint-label");
    if (hinted) {
      if (!label) { label = document.createElement("span"); label.className = "hint-label"; entry.el.appendChild(label); }
      const text = isSplitItem(pin) ? pin.children.map((p) => pinHintText(p).slice(0, 6)).join("·") : pinHintText(pin);
      if (label.textContent !== text) label.textContent = text;
    } else if (label) {
      label.remove();
    }
    entry.el.classList.toggle("hinted", hinted);
    wanted.push(entry.el);
  }
  for (const [id, entry] of pinTiles) {
    if (!alive.has(id)) { entry.el.remove(); pinTiles.delete(id); }
  }

  if (editing && pins.length < settings.maxPins) {
    if (!addTile) {
      addTile = document.createElement("div");
      addTile.className = "pin add";
      addTile.appendChild(uiIcon("plus", 18));
      addTile.addEventListener("click", pinCurrentTab);
    }
    addTile.title = pinCurrentTitle;
    wanted.push(addTile);
  } else if (addTile) {
    addTile.remove();
  }

  // 並びが違う位置の要素だけ動かす (動かした要素だけ揺れのアニメーションがやり直しになる)
  for (let i = 0; i < wanted.length; i++) {
    if (grid.children[i] !== wanted[i]) grid.insertBefore(wanted[i], grid.children[i] || null);
  }
  while (grid.children.length > wanted.length) grid.lastElementChild.remove();

  $("#pin-empty").hidden = pins.length > 0 || editing;
  $("#btn-edit").classList.toggle("active", editing);
}

// お気に入りを消して担当を解放する (分割項目なら 2 枚とも。固定していた分割は解いて 1 枚ずつ外し、Today 欄に分割のまま戻す)。消せたら true。
// release: false は、ペイン id が別の容器 (ピン留めタブ) の項目へ移ったときだけ (担当を解放すると、移した先の担当が外れる)
async function removePin(id, { release = true } = {}) {
  const item = pinById(id);
  const snap = release && isSplitItem(item) ? await splitReleaseSnapshot(item.children.map((p) => p.id)) : null; // 保存で担当が外される前に控える
  const prev = pins.slice();
  pins = pins.filter((p) => p.id !== id);
  if (!(await persistPins(prev))) return false;
  if (snap) await releaseSplitPanes(item.children.map((p) => p.id), snap);
  else if (release) await releaseOwnedTab(id);
  renderPins();
  return true;
}

// background.js のピン追加 (pin-active / add-pin) の結果を知らせる
function flashPinResult(res) {
  if (res?.reason === "quota") flash(t("pinStorageFull"));
  if (res?.reason === "full") flash(t("pinLimitReachedSettings", settings.maxPins));
  if (res?.reason === "duplicate") flash(t("pinDuplicate"));
  if (res?.reason === "unsupported-url" || res?.reason === "no-tab") flash(t("pinUnsupportedUrl"));
  if (res?.reason === "error") flash(t("pinAddError")); // 背景への連絡失敗など。無言で終わらない
}

async function pinCurrentTab() {
  // いま見ているタブが分割のペアで、2 枚とも担当の無いタブなら、分割のお気に入り (1 マス) として末尾に追加する
  await refreshOpenTabs();
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const partner = current && splitPartners(current)[0];
  if (partner && !Object.values(ownedTabs).some((id) => id === current.id || id === partner.id)) {
    return pinSplitFromTabs([current, partner].sort((a, b) => a.index - b.index), { kind: "favorites", where: "end" });
  }
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "pin-active" }); } catch { res = { ok: false, reason: "error" }; }
  if (res?.ok && res.pin && res.tabId) {
    await adoptTab(res.pin.id, res.tabId, { chromePin: true }); // いま見ているタブをそのまま新しいピンの担当タブにする
    renderPins();
  }
  flashPinResult(res);
}

// 位置を指定してお気に入りを追加 (Today 欄からのドラッグ)。background が末尾に足すので、そのあと並びを直す。
// where: "before" / "after" (id のタイルの前後)、"end" (末尾)。戻り値は新しいピンの id
async function insertPin(url, title, { where = "end", id = null } = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "add-pin", url, title }); } catch { res = { ok: false, reason: "error" }; }
  flashPinResult(res);
  if (!res?.ok || !res.pin) return null;
  const { pins: stored = [] } = await chrome.storage.sync.get("pins");
  pins = stored;
  const at = where === "end" ? -1 : pins.findIndex((p) => p.id === id);
  if (at >= 0) {
    const prev = pins.slice();
    const [added] = pins.splice(pins.findIndex((p) => p.id === res.pin.id), 1);
    pins.splice(at + (where === "after" ? 1 : 0), 0, added);
    await persistPins(prev);
  }
  renderPins();
  return res.pin.id;
}

// Today 欄からタブをドラッグしてきたときの差し込み先 (today.js の dropTarget から呼ぶ)。お気に入りのセクションの中なら必ず何かを返す:
// 一番近いタイルの左半分で前・右半分で後ろ、最後のタイルより右か下 (余白) なら末尾
function favoritesInsertTarget(x, y) {
  const grid = $("#pin-grid");
  const sec = grid.closest("section").getBoundingClientRect();
  if (x < sec.left || x > sec.right || y < sec.top || y > sec.bottom) return null;
  const tiles = [...grid.querySelectorAll(".pin:not(.add)")];
  const end = { el: grid, cls: "drop-end", kind: "favorites", where: "end", id: null };
  if (tiles.length === 0) return end;
  const last = tiles.at(-1).getBoundingClientRect();
  if (y > last.bottom || (y >= last.top && x > last.right)) return end;
  let best = null, bestDist = Infinity;
  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    const d = (x - (r.left + r.width / 2)) ** 2 + (y - (r.top + r.height / 2)) ** 2;
    if (d < bestDist) { bestDist = d; best = el; }
  }
  const r = best.getBoundingClientRect();
  const where = x < r.left + r.width / 2 ? "before" : "after";
  return { el: best, cls: `drop-${where}`, kind: "favorites", where, id: best.dataset.id };
}

// ---------- 並べ替え (ドラッグ、編集モードでなくてもよい) ----------
// 動きは reorder.js の共通部品に任せ、ここでは確定した並びの保存だけを行う。
// ほかの欄へ持っていくと、Today 欄なら解除 (today.js の unpinToToday)、ピン留めタブの一覧ならそちらへ移動 (pinned.js の moveFavoriteToPinned)
let pinReorder = null;
let pinRenderPending = false;

function setupPinReorder() {
  pinReorder = setupLiveReorder({
    container: $("#pin-grid"),
    itemSelector: ".pin:not(.add)",
    canStart: (e) => !e.target.closest(".remove"),
    dropTarget: (x, y) => todayUnpinTarget(x, y) || pinnedInsertTarget(x, y),
    combineGrid: true, // 格子の結合: 相手の中央の正方形で「分割にする」、入れ替えは奥側 1/4 (reorder.js)
    combineTarget: pinCombineTarget, // 単独のタイルを別の単独のタイルの真ん中に重ねると分割項目に
    detach: pinDetach, // Option を押しながら分割タイルのペインをつかむと、その 1 枚だけを引き出す
    onDrop: async (target, el) => {
      if (target.kind === "split") return combinePins(target, el);
      const id = el.dataset.id;
      // 分割タイルから引き出してきたペインなら、先に引き出しを確定する。移動先が断っても (重複など) 引き出しは確定している
      if (el.dataset.pulledFrom && !(await dissolvePinSplit(el.dataset.pulledFrom, id))) return;
      const item = pinById(id);
      if (!item) return;
      if (target.kind === "unpin") return isSplitItem(item) ? unpinSplitToToday(item, target) : unpinToToday(id, item.url, target, () => removePin(id));
      return isSplitItem(item) ? moveFavoriteSplitToPinned(id, target) : moveFavoriteToPinned(id, target);
    },
    onCommit: async (order, movedEl) => {
      // 引き出したペインが同じグリッドに残るときは、分割の分だけ項目が増える。満杯なら何もしない (描き直しで元どおり)
      const pulledFrom = movedEl.dataset.pulledFrom;
      if (pulledFrom && pins.length >= settings.maxPins) return flash(t("pinLimitReachedSettings", settings.maxPins));
      const remainId = pulledFrom ? await dissolvePinSplit(pulledFrom, movedEl.dataset.id) : null;
      if (pulledFrom && !remainId) return;
      const ids = order.map((el) => (el.dataset.id === pulledFrom ? remainId : el.dataset.id)); // 分割タイルの位置には残ったペインが入る
      const byId = new Map(pins.map((p) => [p.id, p]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean);
      for (const p of pins) if (!ids.includes(p.id)) next.push(p); // ドラッグ中に他の端末から増えたピンは末尾に
      if (next.some((p, i) => p !== pins[i])) {
        const prev = pins.slice();
        pins = next;
        await persistPins(prev);
      }
    },
    onEnd: () => renderPins(), // 取り消し時の並びの復元と、保留していた描き直しの反映
  });
}

// パネル幅に合わせてグリッドの列数を決める (タイルの最小・最大サイズと間隔は CSS の変数で決める)
function setupPinGridLayout() {
  const grid = $("#pin-grid");
  const px = (name) => parseFloat(getComputedStyle(grid).getPropertyValue(name)) || 0;
  const layout = () => {
    const cs = getComputedStyle(grid);
    const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (width <= 0) return; // 設定画面を表示中など
    const cols = pinColumns(width, px("--pin-min"), px("--pin-max"), px("--pin-gap"));
    if (grid.style.getPropertyValue("--pin-cols") !== String(cols)) grid.style.setProperty("--pin-cols", String(cols));
  };
  new ResizeObserver(layout).observe(grid);
  layout();
}

function setupPinDropZone() {
  const grid = $("#pin-grid");
  const hasUrl = (dt) => dt.types.includes("text/uri-list") || dt.types.includes("text/plain");
  grid.addEventListener("dragover", (e) => {
    if (hasUrl(e.dataTransfer)) { e.preventDefault(); grid.classList.add("drop-target"); }
  });
  grid.addEventListener("dragleave", () => grid.classList.remove("drop-target"));
  grid.addEventListener("drop", async (e) => {
    grid.classList.remove("drop-target");
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    const url = (raw || "").split("\n").find((l) => /^https?:\/\//.test(l.trim()));
    if (!url) return;
    let res;
    try { res = await chrome.runtime.sendMessage({ type: "add-pin", url: url.trim(), title: url.trim() }); } catch { res = null; }
    if (res?.reason === "quota") flash(t("pinStorageFull"));
    if (res?.reason === "full") flash(t("pinLimitReached", settings.maxPins));
    if (res?.reason === "duplicate") flash(t("pinDuplicate"));
  });
}

let flashTimer;
function flash(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---------- GitHub ----------
// background.js が保存する機械可読なエラーコードを表示用の文言にする。
// それ以外 (HTTP 401 ... / GraphQL のメッセージ) は background 側で組み立てた文なのでそのまま返す。
function describeError(code) {
  switch (code) {
    case "no-token": return t("errNoToken").trim(); // errNoToken はリンク連結用の末尾スペース付き
    case "network": return t("errNetwork", settings.host);
    case "bad-response": return t("errBadResponse", settings.host);
    default: return code;
  }
}

function ciClass(pr) {
  if (pr.isDraft) return "draft";
  switch (pr.ci) {
    case "SUCCESS": return "ok";
    case "FAILURE": case "ERROR": return "fail";
    case "PENDING": case "EXPECTED": return "pending";
    default: return "";
  }
}

function ciLabel(pr) {
  if (pr.isDraft) return t("ciDraft");
  const key = { SUCCESS: "ciSuccess", FAILURE: "ciFailure", ERROR: "ciError", PENDING: "ciPending", EXPECTED: "ciExpected" }[pr.ci];
  return t(key || "ciNone");
}

function reviewTag(pr) {
  switch (pr.reviewDecision) {
    case "APPROVED": return ["approved", t("reviewApproved")];
    case "CHANGES_REQUESTED": return ["changes", t("reviewChangesRequested")];
    case "REVIEW_REQUIRED": return ["review", t("reviewRequired")];
    default: return null;
  }
}

function renderList(listEl, items, { showAuthor }) {
  listEl.innerHTML = "";
  for (const pr of items) {
    const li = document.createElement("li");
    li.className = "pr";
    const ghTab = settings.ghDedicatedTab ? ownedTabOf(ghOwnerId(pr.url)) : null;
    const isOpen = settings.ghDedicatedTab ? !!ghTab : !!findTabForUrl(pr.url, { exact: true });
    if (isOpen) li.classList.add("open-tab");
    li.title = t("prTooltip", [pr.repo, pr.number, pr.title, ciLabel(pr), relTime(pr.updatedAt)]);

    const dot = document.createElement("span");
    dot.className = `status ${ciClass(pr)}`;
    li.appendChild(dot);

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = pr.title;
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";
    const repo = document.createElement("span");
    repo.className = "repo";
    repo.textContent = `${pr.repo.split("/")[1] || pr.repo} #${pr.number}`;
    meta.appendChild(repo);
    if (showAuthor && pr.author) {
      if (pr.avatarUrl) {
        const av = document.createElement("img");
        av.src = pr.avatarUrl; av.alt = "";
        meta.appendChild(av);
      }
      const au = document.createElement("span");
      au.className = "author";
      au.textContent = pr.author;
      meta.appendChild(au);
    }
    const tag = reviewTag(pr);
    if (tag) {
      const tagEl = document.createElement("span");
      tagEl.className = `tag ${tag[0]}`;
      tagEl.textContent = tag[1];
      meta.appendChild(tagEl);
    }
    const time = document.createElement("span");
    time.textContent = relTime(pr.updatedAt);
    meta.appendChild(time);
    body.appendChild(meta);
    li.appendChild(body);

    // 開いている PR (専用タブがあるとき) はホバーで × を出す。タブを閉じるだけで、項目は残る (閉じると担当も外れる)
    if (ghTab) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "pr-close";
      close.title = t("closeTabTitle");
      close.addEventListener("click", (e) => { e.stopPropagation(); chrome.tabs.remove(ghTab.id).catch(() => { /* 既に閉じている */ }); });
      // 中クリックも閉じる。li の auxclick (別の新しいタブで開く) に伝わらないようにする
      close.addEventListener("auxclick", (e) => {
        e.stopPropagation(); e.preventDefault();
        if (e.button === 1) chrome.tabs.remove(ghTab.id).catch(() => { /* 既に閉じている */ });
      });
      li.appendChild(close);
    }

    // 通常クリック: その PR の専用タブで開く (開いていれば切り替えるだけ)。⌘クリック / 中クリック: 別の新しいタブで開く
    const openPr = (inNewTab) => {
      if (inNewTab) return chrome.tabs.create({ url: pr.url, active: false });
      if (settings.ghDedicatedTab) return openOwned(ghOwnerId(pr.url), pr.url, { navigate: true, chromePin: false });
      return openOrFocus(pr.url, { exact: true });
    };
    li.addEventListener("click", (e) => { if (e.detail <= 1) openPr(e.metaKey || e.ctrlKey); });
    li.addEventListener("auxclick", (e) => {
      if (e.button === 1) { e.preventDefault(); openPr(true); }
    });
    listEl.appendChild(li);
  }
}

async function renderGitHub() {
  const { github: gh = {} } = await chrome.storage.local.get("github");
  const errEl = $("#gh-error");
  const refreshBtn = $("#btn-refresh");
  refreshBtn.classList.toggle("spin", !!gh.loading);

  // トークン未設定のあいだはフォルダや更新ボタンを出さず、設定への導線だけ残す
  const noToken = !settings.token || gh.error === "no-token";
  refreshBtn.hidden = noToken;
  $("#gh-updated").hidden = noToken;

  const mine = gh.mine || [];
  const reviews = gh.reviews || [];
  // 空のフォルダは「なし」と出さずにフォルダごと隠す
  document.querySelector('[data-folder="mine"]').hidden = noToken || !settings.showMine || mine.length === 0;
  document.querySelector('[data-folder="reviews"]').hidden = noToken || !settings.showReviews || reviews.length === 0;

  errEl.title = ""; // 前回のエラー詳細ツールチップを引き継がない
  if (noToken) {
    errEl.hidden = false;
    errEl.innerHTML = "";
    errEl.append(t("errNoToken"));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn";
    b.textContent = t("openSettings");
    b.addEventListener("click", () => { showSettings(); $("#in-token").focus(); });
    errEl.appendChild(b);
  } else if (gh.error) {
    errEl.hidden = false;
    errEl.textContent = t("errFetchFailed", describeError(gh.error));
    errEl.title = gh.errorDetail || "";
  } else {
    errEl.hidden = true;
  }

  $("#count-mine").textContent = mine.length;
  const rc = $("#count-reviews");
  rc.textContent = reviews.length;
  rc.classList.toggle("has", reviews.length > 0);
  renderList($("#list-mine"), mine, { showAuthor: false });
  renderList($("#list-reviews"), reviews, { showAuthor: true });
  $("#gh-updated").textContent = gh.fetchedAt && !gh.error ? t("updatedAt", relTime(gh.fetchedAt)) : "";
}

async function setupFolders() {
  const { folderState = {} } = await chrome.storage.local.get("folderState");
  document.querySelectorAll(".folder").forEach((f) => {
    const key = f.dataset.folder;
    const head = f.querySelector(".folder-head");
    const expanded = folderState[key] !== false;
    head.setAttribute("aria-expanded", String(expanded));
    head.addEventListener("click", async () => {
      const now = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(now));
      const { folderState: fs = {} } = await chrome.storage.local.get("folderState");
      fs[key] = now;
      await chrome.storage.local.set({ folderState: fs });
    });
  });
}

// ---------- 設定画面 ----------
// 上限セレクトを settings.maxPins に合わせる (既定の選択肢 12/16/20/24 に無い値はその場で追加)
function syncMaxPinsSelect() {
  const sel = $("#in-maxpins");
  const v = String(settings.maxPins);
  if (![...sel.options].some((o) => o.value === v)) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  sel.value = v;
}

let mainScrollY = 0;
function showSettings() {
  if (!$("#view-main").hidden) mainScrollY = window.scrollY;
  $("#in-host").value = settings.host;
  $("#in-token").value = settings.token;
  $("#in-interval").value = String(settings.intervalMin);
  $("#in-show-mine").checked = settings.showMine;
  $("#in-show-reviews").checked = settings.showReviews;
  $("#in-team").checked = settings.includeTeamRequests;
  $("#in-pin-owned").checked = settings.pinOwnedTabs;
  $("#in-pin-tint").checked = settings.pinTint;
  $("#in-pin-hints").checked = settings.pinHints;
  $("#in-auto-archive").value = String(settings.autoArchiveHours);
  $("#in-gh-dedicated").checked = settings.ghDedicatedTab;
  syncMaxPinsSelect();
  syncAppearanceControls();
  showBgStatus("");
  $("#settings-status").textContent = "";
  $("#import-status").hidden = true;
  importCandidates = [];
  renderImportPreview();
  $("#view-main").hidden = true;
  $("#view-archive").hidden = true;
  $("#view-settings").hidden = false;
  window.scrollTo(0, 0);
}

function showMain() {
  $("#view-settings").hidden = true;
  $("#view-archive").hidden = true;
  $("#view-main").hidden = false;
  window.scrollTo(0, mainScrollY);
}

async function saveSettings(e) {
  e.preventDefault();
  const status = $("#settings-status");
  const host = $("#in-host").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "github.com";

  if (host !== "github.com") {
    const origin = `https://${host}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) { status.textContent = t("errHostPermission", host); return; }
    }
  }

  const pinOwnedTabs = $("#in-pin-owned").checked;
  const pinnedChanged = pinOwnedTabs !== settings.pinOwnedTabs;
  // 見た目の項目はその場で保存済み (appearance.js) なので、今の値を引き継ぐ
  settings = {
    ...settings,
    host,
    token: $("#in-token").value.trim(),
    intervalMin: Number($("#in-interval").value),
    showMine: $("#in-show-mine").checked,
    showReviews: $("#in-show-reviews").checked,
    includeTeamRequests: $("#in-team").checked,
    maxPins: Number($("#in-maxpins").value),
    pinOwnedTabs,
    ghDedicatedTab: $("#in-gh-dedicated").checked,
    pinTint: $("#in-pin-tint").checked,
    pinHints: $("#in-pin-hints").checked,
    autoArchiveHours: Number($("#in-auto-archive").value),
  };
  await Promise.all([
    chrome.storage.sync.set({ settings: syncedSettings() }),
    chrome.storage.local.set({ githubToken: settings.token }),
  ]);
  if (pinnedChanged) await applyPinnedSetting(pinOwnedTabs);
  status.textContent = t("statusSaved");
  await refreshOpenTabs();
  await pruneOrphanOwners(); // GitHub 専用タブをオフにした / フォルダを隠したときは PR の担当を外す
  await chrome.runtime.sendMessage({ type: "refresh" }); // トークンを消したときのバッジ消去も兼ねる
  if (!settings.token) {
    // トークン無しはピンだけ使う正規の状態なので、保存そのものは成功
    status.textContent = t("statusSavedOnly");
    setTimeout(showMain, 600);
    return;
  }
  const { github: gh = {} } = await chrome.storage.local.get("github");
  status.textContent = gh.error ? t("statusError", describeError(gh.error)) : t("statusConnected");
  if (!gh.error) setTimeout(showMain, 600);
}

// ---------- Arc からインポート ----------
// 候補: { id, url, title, folder, group, groupId, target, checked, existing }
//   target: "grid" (お気に入りのグリッドへ) | "pinned" (ピン留めタブの一覧へ。フォルダ構造を保つ)
// Arc のお気に入りはグリッドへ。Arc のスペースのピン留めは一覧へ入れ、複数のスペースから取り込むときは
// スペース名のフォルダにまとめて構造を保つ。
let importCandidates = [];
let importSpaces = [];      // 解析結果の spaces (tree を取り込みに使う)
let importRows = [];        // { c, cb }  チェック状態の反映用 (再描画せずに更新してフォーカスを保つ)
let importGroupBoxes = [];  // { gcb, items }

function roundUpLimit(n) { return Math.max(4, Math.ceil(n / 4) * 4); }

// お気に入りは chrome.storage.sync の 1 項目 ("pins" キー) に丸ごと保存している。1 項目は
// QUOTA_BYTES_PER_ITEM (8,192 バイト。キー長 + 値を JSON 化した UTF-8 バイト数) まで。
// Chrome 側の JSON 化と僅かに差が出うるので少し余裕を見る。
const PINS_ITEM_QUOTA = (chrome.storage.sync.QUOTA_BYTES_PER_ITEM || 8192) - 256;
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000"; // crypto.randomUUID() と同じ長さ
function pinsFit(list) {
  return new TextEncoder().encode(JSON.stringify(list)).length + "pins".length <= PINS_ITEM_QUOTA;
}

function arcSpaceLabel(arcSpace) {
  return arcSpace.name || t("importUnnamedSpace", arcSpace.index || 1);
}
// 取り込み先に既にある URL
function existingUrlsFor(target) {
  return target === "grid" ? new Set(flatPins().map((p) => p.url)) : treeUrls(pinnedTabs);
}

// Arc のツリーから、選ばれた URL だけを残したツリーを作る (新しい ID を振り、空になったフォルダは除く)
function buildImportTree(arcSpace, urls) {
  const walk = (nodes) => nodes.flatMap((n) => {
    if (n.type === "tab") return urls.has(n.url) ? [{ type: "tab", id: crypto.randomUUID(), url: n.url, title: n.title }] : [];
    const children = walk(n.children || []);
    return children.length ? [{ type: "folder", id: crypto.randomUUID(), title: n.title, children }] : [];
  });
  return walk(arcSpace.tree || []);
}

// 選択中の候補から、ピン留めタブの一覧に足すノード列を作る。
// 複数の Arc スペースから取り込むときは、それぞれをスペース名のフォルダにまとめる (1 つだけなら平らに)
function buildPinnedImport(sel) {
  const already = treeUrls(pinnedTabs);
  const perSpace = [];
  for (const arcSpace of importSpaces) {
    const target = `space:${arcSpace.id}`;
    const urls = new Set(sel.filter((c) => c.groupId === target && !already.has(c.url)).map((c) => c.url));
    if (!urls.size) continue;
    const tree = buildImportTree(arcSpace, urls);
    if (tree.length) perSpace.push({ arcSpace, tree });
  }
  if (perSpace.length <= 1) return perSpace[0]?.tree || [];
  return perSpace.map(({ arcSpace, tree }) => ({ type: "folder", id: crypto.randomUUID(), title: arcSpaceLabel(arcSpace), children: tree }));
}

// 選択中の候補 (取り込み先と URL で重複を除く)
function selectedImportItems() {
  const seen = new Set();
  const out = [];
  for (const c of importCandidates) {
    const key = `${c.target}|${c.url}`;
    if (!c.checked || c.existing || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// チェック状態だけを DOM に反映する (行を作り直さないのでキーボードフォーカスとアイコンが保たれる)
function syncImportChecks() {
  for (const { c, cb } of importRows) cb.checked = c.checked;
  for (const { gcb, items } of importGroupBoxes) {
    const selectable = items.filter((i) => !i.existing);
    gcb.checked = selectable.length > 0 && selectable.every((i) => i.checked);
    gcb.indeterminate = selectable.some((i) => i.checked) && !gcb.checked;
    gcb.disabled = selectable.length === 0;
  }
  updateImportSummary();
}

function updateImportSummary() {
  const sel = selectedImportItems();
  const btn = $("#btn-import");
  btn.textContent = t("importButton", sel.length);
  // 容量: お気に入りは pins の 1 項目、ピン留めタブは pinnedTabs の 1 項目
  const gridSel = sel.filter((c) => c.target === "grid");
  let fits = pinsFit([...pins, ...gridSel.map((c) => ({ id: PLACEHOLDER_ID, url: c.url, title: c.title }))]);
  if (sel.some((c) => c.target === "pinned") && !pinnedTabsFit([...pinnedTabs, ...buildPinnedImport(sel)])) fits = false;
  btn.disabled = sel.length === 0 || !fits;
  const note = $("#import-note");
  const total = pins.length + gridSel.length;
  note.classList.toggle("warn", !fits);
  if (!fits) {
    note.hidden = false;
    note.textContent = t("importTooMany");
  } else if (total > settings.maxPins) {
    note.hidden = false;
    note.textContent = t("importRaiseLimit", roundUpLimit(total));
  } else {
    note.hidden = true;
  }
}

// 候補一覧を組み立てる。ファイルを読んだとき、および既存のピンが変わったとき (「ピン留め済み」の判定が変わる) に呼ぶ
function renderImportPreview() {
  const groupsEl = $("#import-groups");
  groupsEl.innerHTML = "";
  importRows = [];
  importGroupBoxes = [];
  const groups = new Map(); // groupId -> items (同名のスペースが複数あっても混ざらないよう ID で分ける)
  const existingCache = new Map();
  for (const c of importCandidates) {
    if (!existingCache.has(c.target)) existingCache.set(c.target, existingUrlsFor(c.target));
    c.existing = existingCache.get(c.target).has(c.url);
    if (c.existing) c.checked = false;
    if (!groups.has(c.groupId)) groups.set(c.groupId, []);
    groups.get(c.groupId).push(c);
  }
  const spaceGroups = [...groups.values()].filter((items) => items[0].target === "pinned").length;

  for (const items of groups.values()) {
    const g = document.createElement("div");
    g.className = "import-group";
    const head = document.createElement("label");
    head.className = "group-head";
    const gcb = document.createElement("input");
    gcb.type = "checkbox";
    gcb.addEventListener("change", () => {
      for (const i of items) if (!i.existing) i.checked = gcb.checked;
      syncImportChecks();
    });
    head.appendChild(gcb);
    const name = document.createElement("span");
    name.textContent = items[0].group;
    head.appendChild(name);
    const target = document.createElement("span");
    target.className = "import-target";
    // 取り込み先。Arc のスペースが複数あれば、それぞれスペース名のフォルダにまとまる
    if (items[0].target === "grid") target.textContent = t("importTargetGrid");
    else if (spaceGroups > 1) target.textContent = t("importTargetPinnedFolder", arcSpaceLabel(importSpaces.find((sp) => `space:${sp.id}` === items[0].groupId) || {}));
    else target.textContent = t("importTargetPinned");
    head.appendChild(target);
    const cnt = document.createElement("span");
    cnt.className = "count";
    cnt.textContent = String(items.length);
    head.appendChild(cnt);
    g.appendChild(head);
    importGroupBoxes.push({ gcb, items });

    for (const c of items) {
      const row = document.createElement("label");
      row.className = "import-item" + (c.existing ? " disabled" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.disabled = c.existing;
      cb.addEventListener("change", () => { c.checked = cb.checked; syncImportChecks(); });
      row.appendChild(cb);
      importRows.push({ c, cb });
      row.appendChild(iconElement(c.url, { override: c.icon }));
      const text = document.createElement("div");
      text.className = "text";
      const t1 = document.createElement("div");
      t1.className = "t";
      if (c.folder) {
        const f = document.createElement("span");
        f.className = "path";
        f.textContent = `${c.folder} /`;
        t1.appendChild(f);
      }
      const ttl = document.createElement("span");
      ttl.className = "name";
      ttl.textContent = c.title;
      t1.appendChild(ttl);
      if (c.existing) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = t(c.target === "grid" ? "importAlreadyFavorite" : "importAlreadyPinned");
        t1.appendChild(tag);
      }
      const t2 = document.createElement("div");
      t2.className = "u";
      try { t2.textContent = new URL(c.url).hostname; } catch { t2.textContent = c.url; }
      text.append(t1, t2);
      row.appendChild(text);
      // 行内ではフォルダ名もタイトルも省略されうるので、ツールチップに全パス + タイトルと URL を出す
      const full = `${c.folder ? `${c.folder} / ` : ""}${c.title}`;
      row.title = c.title === c.url ? full : `${full}\n${c.url}`;
      g.appendChild(row);
    }
    groupsEl.appendChild(g);
  }

  syncImportChecks();
  $("#import-preview").hidden = importCandidates.length === 0;
  // 候補に Arc の項目 ID があるときだけアイコン取り込みを案内する
  $("#import-icons").hidden = !importCandidates.some((c) => c.id);
}

async function onArcFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("#import-status");
  status.hidden = true;
  importCandidates = [];
  importSpaces = [];
  $("#import-icons-status").textContent = "";
  let parsed;
  try {
    parsed = parseArcSidebar(await file.text(), { untitledFolder: t("importUntitledFolder") });
  } catch {
    status.textContent = t("importParseError");
    status.hidden = false;
    renderImportPreview();
    return;
  }
  importSpaces = parsed.spaces;
  const favGroup = t("importFavorites");
  for (const p of parsed.favorites) importCandidates.push({ ...p, group: favGroup, groupId: "favorites", target: "grid", checked: true });
  for (const s of parsed.spaces) {
    if (!s.pins.length) continue;
    const label = t("importSpacePins", arcSpaceLabel(s));
    for (const p of s.pins) importCandidates.push({ ...p, group: label, groupId: `space:${s.id}`, target: "pinned", checked: true });
  }
  if (!importCandidates.length) {
    status.textContent = t("importEmpty");
    status.hidden = false;
  }
  renderImportPreview();
}

// Arc の SidebarItemsFaviconCache フォルダを選んだとき: 候補と、取り込み済みの URL にアイコンを付ける
async function onArcIconsChosen(e) {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  const status = $("#import-icons-status");
  if (!files.length) return;
  const byName = await readArcIconFolder(files);
  let found = 0;
  const forExisting = {};
  const seen = new Set();
  for (const c of importCandidates) {
    const dataUrl = c.id ? byName.get(arcFaviconFileName(c.id)) : null;
    if (!dataUrl) continue;
    c.icon = dataUrl;
    if (!seen.has(c.url)) { seen.add(c.url); found += 1; }
    if (c.existing) forExisting[c.url] = dataUrl; // 取り込み済みにもすぐ反映する
  }
  await saveIcons(forExisting);
  status.textContent = found ? tn("importIconsDone", found) : t("importIconsNone");
  renderImportPreview();
}

async function runImport() {
  const sel = selectedImportItems();
  if (!sel.length) return;
  const status = $("#import-status");
  let added = 0;
  const icons = {};

  // お気に入りのグリッドへ
  const gridSel = sel.filter((c) => c.target === "grid");
  if (gridSel.length) {
    const urls = new Set(flatPins().map((p) => p.url));
    const toAdd = gridSel.filter((c) => !urls.has(c.url) && (urls.add(c.url), true));
    if (toAdd.length) {
      const next = [...pins, ...toAdd.map((c) => ({ id: crypto.randomUUID(), url: c.url, title: c.title }))];
      if (!pinsFit(next)) { updateImportSummary(); return; }
      const before = pins;
      pins = next;
      try {
        await savePins();
      } catch {
        pins = before;
        status.textContent = t("importTooMany");
        status.hidden = false;
        return;
      }
      added += toAdd.length;
      for (const c of toAdd) if (c.icon) icons[c.url] = c.icon;
      if (pins.length > settings.maxPins) {
        settings = { ...settings, maxPins: roundUpLimit(pins.length) };
        await chrome.storage.sync.set({ settings: syncedSettings() });
        syncMaxPinsSelect(); // 設定フォームは表示中なので、次の「保存」で上限が戻らないようセレクトも更新する
      }
    }
  }

  // ピン留めタブの一覧へ (フォルダ構造を保つ。複数の Arc スペースはスペース名のフォルダにまとめる)
  const pinnedSel = sel.filter((c) => c.target === "pinned");
  if (pinnedSel.length) {
    const nodes = buildPinnedImport(pinnedSel);
    if (nodes.length) {
      const prev = cloneTree(pinnedTabs);
      pinnedTabs = [...prev, ...nodes];
      if (!(await savePinnedTabs(prev))) {
        // 失敗 (容量超過など)。pinnedTabs は savePinnedTabs が元に戻している。
        // お気に入り側で取り込めた分のアイコンだけ保存し、候補は残して選び直せるようにする
        await saveIcons(icons);
        status.textContent = t("importTooMany");
        status.hidden = false;
        renderImportPreview();
        renderPins();
        return;
      }
      let n = 0;
      walkTabs(nodes, (node) => { n++; const c = pinnedSel.find((x) => x.url === node.url && x.icon); if (c) icons[node.url] = c.icon; });
      added += n;
    }
  }

  await saveIcons(icons);
  status.textContent = tn("importDone", added);
  status.hidden = false;
  importCandidates = [];
  importSpaces = [];
  renderImportPreview();
  renderPins();
  renderPinned();
}

// macOS ではファイルの場所と開き方まで案内し、それ以外の OS では一般的な案内にする
async function applyImportHelp() {
  let os = "";
  try { os = (await chrome.runtime.getPlatformInfo()).os; } catch { /* 一般的な案内のまま */ }
  $("#import-help").innerHTML = t(os === "mac" ? "importHelpMac" : "importHelp");
}

// ---------- 初期化 ----------
async function init() {
  localizeDocument();
  applyUiIcons();
  // ＋ は「ピン (sync) → 担当 (session)」の順に書くので、担当を先に読めば、見える担当には必ずピンがある
  await Promise.all([loadSettings(), loadBackdropImage(), refreshOpenTabs(), applyShortcutLabels(), loadOwnedTabs(), loadIconStore()]);
  applyAppearance(settings); // テーマ・色味・アクセント色は appearance.js が前回の値で付けてあるので、ここでは保存された値に合わせ直す
  setupAppearanceSettings();
  await loadPins();
  await loadPinnedTabs(); // 担当先の一覧 (allOwnerTargets) に使うので、結び直しより前に読む
  ghData = (await chrome.storage.local.get("github")).github || {}; // PR の担当先も同じ
  await pruneIcons(allOwnerTargets().filter((p) => !p.gh).map((p) => p.url));
  await pruneOwnedTabs();
  await pruneOrphanOwners();
  await reconcileOwnedTabs();
  renderPins();
  await setupFolders();
  await renderGitHub();
  setupPinDropZone();
  setupPinGridLayout();
  setupPinReorder();
  // storage の変更を受けるリスナーは、pinned.js / today.js のリスナーより先に登録する (登録順に呼ばれるので、
  // ownedTabs / iconStore をここで先に更新してから他のリスナーが描き直せる)。更新は await より前に行う
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && changes.icons) iconStore = changes.icons.newValue || {};
    if (area === "session" && changes.ownedTabs) ownedTabs = changes.ownedTabs.newValue || {}; // 別ウィンドウのパネルが更新した場合
    if (area === "sync" && changes.pins) {
      pins = sanitizedPins(changes.pins.newValue || []);
      await refreshOpenTabs();
      await pruneOrphanOwners();
      renderPins();
      if (importCandidates.length) renderImportPreview(); // プレビューの「追加済み」/件数/上限の注記を追従
    }
    if (area === "local" && changes.github) {
      ghData = changes.github.newValue || {};
      renderGitHub();
      await pruneOrphanOwners(); // 一覧から消えた PR (マージ・クローズ等) の担当を外す。タブは閉じず Today に戻る
    }
    if ((area === "sync" && changes.settings) || (area === "local" && changes.githubToken)) {
      await loadSettings();
      applyAppearance(settings);
      if (changes.settings && !$("#view-settings").hidden) {
        // 見た目はその場で保存するので settings はよく書き換わる。上限が変わったときだけ合わせ、未保存の選択を戻さない
        const maxPinsOf = (s) => ({ ...DEFAULT_SETTINGS, ...(s || {}) }).maxPins;
        if (maxPinsOf(changes.settings.oldValue) !== maxPinsOf(changes.settings.newValue)) syncMaxPinsSelect();
        syncAppearanceControls();
      }
      renderPins(); renderGitHub();
    }
    if (area === "local" && changes.backgroundImage) { // 別のパネルが背景画像を変えた場合
      await loadBackdropImage();
      applyAppearance(settings);
      if (!$("#view-settings").hidden) syncAppearanceControls();
    }
    if (area === "local" && changes.icons) renderPins();
    if (area === "session" && changes.ownedTabs) { renderPins(); renderGitHub(); }
  });
  await initPinned();
  await initToday();

  $("#btn-edit").addEventListener("click", () => setEditing(!editing));
  $("#btn-pin-current").addEventListener("click", pinCurrentTab);
  $("#btn-refresh").addEventListener("click", () => chrome.runtime.sendMessage({ type: "refresh" }));
  $("#btn-settings").addEventListener("click", showSettings);
  $("#btn-back").addEventListener("click", showMain);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#in-arc-file").addEventListener("change", onArcFileChosen);
  $("#btn-import").addEventListener("click", runImport);
  $("#in-arc-icons").addEventListener("change", onArcIconsChosen);
  $("#btn-import-all").addEventListener("click", () => { importCandidates.forEach((c) => { if (!c.existing) c.checked = true; }); syncImportChecks(); });
  $("#btn-import-none").addEventListener("click", () => { importCandidates.forEach((c) => { c.checked = false; }); syncImportChecks(); });
  $("#btn-arc-file").addEventListener("click", () => $("#in-arc-file").click());
  $("#btn-arc-icons").addEventListener("click", () => $("#in-arc-icons").click());
  $("#link-import").addEventListener("click", () => {
    showSettings();
    $(".import").scrollIntoView({ block: "start" });
    $("#btn-arc-file").focus({ preventScroll: true });
  });
  applyImportHelp();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editing) setEditing(false);
    if (e.key === "Escape" && !$("#view-settings").hidden) showMain();
  });

  // 開いているタブの変化を追従 (ピンの「開いている」インジケータ用)
  const onTabs = async () => { await refreshOpenTabs(); await pruneOwnedTabs(); renderPins(); renderGitHub(); };
  chrome.tabs.onCreated.addListener(onTabs);
  chrome.tabs.onRemoved.addListener(onTabs);
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.url || info.status === "complete" || info.favIconUrl) onTabs();
    if (info.status === "complete" || info.favIconUrl) captureIconsOnLoad(tab);
  });
  chrome.tabs.onRemoved.addListener((tabId) => freshPinTabs.delete(tabId));
  // 破棄 (メモリセーバー / chrome.tabs.discard) でタブ ID が変わったら担当を付け替える (pruneOwnedTabs が旧 ID を「閉じられた」と落とす前に)
  chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    await repointOwnedTab(addedTabId, removedTabId);
    await onTabs();
    renderPinned();
  });

  // 相対時刻の表示を 1 分ごとに更新
  setInterval(renderGitHub, 60000);
}

init();
