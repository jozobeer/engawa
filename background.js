// Service worker: GitHub ライブフォルダの定期取得と、ピン留めのショートカット/コンテキストメニュー

const ALARM = "github-refresh";
const DEFAULT_SETTINGS = {
  host: "github.com",
  token: "",
  intervalMin: 3,
  showMine: true,
  showReviews: true,
  includeTeamRequests: true,
  maxPins: 20,
  pinOwnedTabs: true,
  ghDedicatedTab: true,
  autoArchiveHours: 12,
};

// settings は chrome.storage.sync (端末間で同期)。token (GitHub PAT) だけは同期しない約束なので、
// chrome.storage.local の githubToken に分けて持つ。旧版の local.settings からの一度きりの移行:
// sync が空なら local を seed (token 抜き)、両方あれば sync を正とする (sidepanel.js と同じ。SW は別コンテキストなので複製)
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

async function getSettings() {
  await migrateSettings();
  const [{ settings }, { githubToken }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("githubToken"),
  ]);
  return { ...DEFAULT_SETTINGS, ...(settings || {}), token: githubToken || "" };
}

function graphqlEndpoint(host) {
  return host === "github.com"
    ? "https://api.github.com/graphql"
    : `https://${host}/api/graphql`;
}

const QUERY = `
query($mine: String!, $rev: String!) {
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...PR } }
  reviews: search(query: $rev, type: ISSUE, first: 50) { nodes { ...PR } }
}
fragment PR on PullRequest {
  number
  title
  url
  isDraft
  reviewDecision
  updatedAt
  createdAt
  author { login avatarUrl }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

function normalize(node) {
  if (!node || !node.url) return null;
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: !!node.isDraft,
    reviewDecision: node.reviewDecision || null,
    updatedAt: node.updatedAt,
    createdAt: node.createdAt,
    author: node.author ? node.author.login : "",
    avatarUrl: node.author ? node.author.avatarUrl : "",
    repo: node.repository ? node.repository.nameWithOwner : "",
    ci: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
  };
}

async function refreshGitHub() {
  const s = await getSettings();
  const prev = (await chrome.storage.local.get("github")).github || {};
  if (!s.token) {
    await chrome.storage.local.set({
      github: { ...prev, loading: false, error: "no-token", errorDetail: null, fetchedAt: Date.now() },
    });
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.storage.local.set({ github: { ...prev, loading: true } });

  const revQualifier = s.includeTeamRequests
    ? "review-requested:@me"
    : "user-review-requested:@me";
  const variables = {
    mine: "is:pr is:open archived:false author:@me sort:updated-desc",
    rev: `is:pr is:open archived:false ${revQualifier} sort:updated-desc`,
  };

  // ブラウザが投げる例外文 (Failed to fetch 等) は常に英語なので、そのまま表示せず
  // 機械可読なコード (network / bad-response) に分類してパネル側で翻訳する。
  const coded = (code, e) => Object.assign(new Error(String(e?.message || e)), { code });
  try {
    let res;
    try {
      res = await fetch(graphqlEndpoint(s.host), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${s.token}`,
          Accept: "application/json",
        },
        body: JSON.stringify({ query: QUERY, variables }),
      });
    } catch (e) {
      throw coded("network", e);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.status === 401 ? chrome.i18n.getMessage("errTokenInvalid") : ""}`);
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw coded("bad-response", e); // GHES のログインページ (HTML) が 200 で返るケースなど
    }
    if (!json || typeof json !== "object" || (!json.data && !json.errors)) {
      throw coded("bad-response", new Error("unexpected response shape"));
    }
    if (json.errors && !json.data) {
      throw new Error(json.errors.map((e) => e.message).join(" / "));
    }
    // 部分エラーでフィールド全体が null のときは、空の一覧として保存せず前回の一覧を保持する
    // (空にすると、全 PR の担当解除と ownedUrls の消去が走ってしまう)
    const pick = (k) => (json.data[k] ? (json.data[k].nodes || []).map(normalize).filter(Boolean) : (json.errors ? (prev[k] || []) : []));
    const mine = pick("mine");
    const reviews = pick("reviews");
    await chrome.storage.local.set({
      github: {
        mine,
        reviews,
        loading: false,
        error: null,
        warning: json.errors ? json.errors.map((e) => e.message).join(" / ") : null,
        fetchedAt: Date.now(),
      },
    });
    const count = s.showReviews ? reviews.length : 0;
    await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
  } catch (e) {
    await chrome.storage.local.set({
      github: {
        ...prev,
        loading: false,
        error: e.code || String(e.message || e),
        errorDetail: e.code ? String(e.message || e) : null,
        fetchedAt: Date.now(),
      },
    });
  }
}

async function scheduleAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM);
  const period = Math.max(1, Number(s.intervalMin) || 3);
  await chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: period });
}

// ---- ピン留め ----
// お気に入り (pins) を、分割項目 ({type:"split", children:[ペイン, ペイン]}) のペインに展開して平らにする (担当先はペインごと。sidepanel 側の flatPins と同じ)
const flatPinItems = (list) => (list || []).flatMap((p) => (p && p.type === "split" ? p.children : [p]));
async function addPin(url, title) {
  if (!url || !/^https?:/.test(url)) return { ok: false, reason: "unsupported-url" };
  const s = await getSettings();
  const { pins = [] } = await chrome.storage.sync.get("pins");
  if (flatPinItems(pins).some((p) => p.url === url)) return { ok: false, reason: "duplicate" };
  if (pins.length >= s.maxPins) return { ok: false, reason: "full" };
  const pin = { id: crypto.randomUUID(), url, title: title || url };
  pins.push(pin);
  try {
    await chrome.storage.sync.set({ pins });
  } catch (e) {
    // 1 項目 8 KB (QUOTA_BYTES_PER_ITEM) を超えると拒否される
    return { ok: false, reason: /QUOTA_BYTES/i.test(String(e?.message || e)) ? "quota" : "error" };
  }
  return { ok: true, pin };
}

async function pinActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false, reason: "no-tab" };
  const res = await addPin(tab.url, tab.title);
  return { ...res, tabId: tab.id }; // パネル側がこのタブをピンの担当タブにする
}

// ---- コンテキストメニューとアクションのツールチップ ----
// MV3 ではメニュー項目がタイトル文字列ごと永続化されるため、UI 言語を変えても onInstalled までは
// 古い言語のまま残る。起動のたびに作り直す。onInstalled と onStartup は同じ起動で両方発火しうるので
// SW の生存中は 1 回だけ実行する。
let menusReady = null;
function createMenus() {
  if (!menusReady) {
    menusReady = (async () => {
      await chrome.contextMenus.removeAll();
      const create = (props) => new Promise((resolve) =>
        chrome.contextMenus.create(props, () => { void chrome.runtime.lastError; resolve(); }));
      await create({
        id: "pin-page",
        title: chrome.i18n.getMessage("menuPinPage"),
        contexts: ["page", "action"],
      });
      await create({
        id: "pin-link",
        title: chrome.i18n.getMessage("menuPinLink"),
        contexts: ["link"],
      });
    })().catch((e) => console.warn("contextMenus rebuild failed", e));
  }
  return menusReady;
}

// ツールバーのツールチップに、Chrome が実際に割り当てているショートカット (環境ごとの表記) を付ける。
// action のタイトルはメモリ上にしか無く、拡張の再読み込み (無効化→有効化など、onInstalled/onStartup が
// 発火しないケースを含む) で manifest の default_title に戻るため、SW が起動するたびに設定し直す。
async function updateActionTitle() {
  const label = chrome.i18n.getMessage("cmdOpenSidebar");
  try {
    const cmds = await chrome.commands.getAll();
    const sc = cmds.find((c) => c.name === "_execute_action")?.shortcut;
    await chrome.action.setTitle({ title: sc ? chrome.i18n.getMessage("withShortcut", [label, sc]) : label });
  } catch {
    // manifest の default_title のまま
  }
}

updateActionTitle(); // 冪等で軽量

async function onLaunch(details) {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // 自動アーカイブの猶予の起点。ブラウザの起動時 (details なし) とインストール時は数え直し、既存の古いタブを
  // いきなり閉じない (拡張の更新時は数え直さない。storage.session は拡張の再読み込みでも消えるので、無ければ設定する)
  const { archiveGraceFrom } = await chrome.storage.session.get("archiveGraceFrom");
  if (!details || details.reason === "install" || !archiveGraceFrom) {
    await chrome.storage.session.set({ archiveGraceFrom: Date.now() });
  }
  await Promise.all([createMenus(), updateActionTitle(), scheduleAlarm(), scheduleArchiveAlarm()]);
  refreshGitHub();
}

// ---- ライフサイクル ----
chrome.runtime.onInstalled.addListener(onLaunch);
chrome.runtime.onStartup.addListener(onLaunch);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshGitHub();
  if (alarm.name === ARCHIVE_ALARM) autoArchive();
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "pin-current-tab") pinActiveTab();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "pin-page" && tab) addPin(tab.url, tab.title);
  if (info.menuItemId === "pin-link" && info.linkUrl) addPin(info.linkUrl, info.linkUrl);
});

// 見た目の設定 (appearance.js) は変えるたびにその場で保存されるので、それだけの変更では GitHub を取り直さない
const APPEARANCE_KEYS = ["theme", "tint", "accent", "bgNoise", "bgTransparency", "bgPosition", "bgRepeat", "bgSize", "bgScale"];
function onlyAppearanceChanged({ oldValue = {}, newValue = {} }) {
  const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
  return [...keys].every((k) => APPEARANCE_KEYS.includes(k) || oldValue[k] === newValue[k]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  const settingsChanged = area === "sync" && changes.settings && !onlyAppearanceChanged(changes.settings);
  const tokenChanged = area === "local" && changes.githubToken;
  if (!settingsChanged && !tokenChanged) return;
  scheduleAlarm();
  refreshGitHub();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "refresh") {
    refreshGitHub().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "pin-active") {
    pinActiveTab().then(sendResponse, () => sendResponse({ ok: false, reason: "error" }));
    return true;
  }
  if (msg?.type === "archive-tabs") {
    archiveTabsById(msg.tabIds || [], "manual").then((count) => sendResponse({ ok: true, count }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "archive-remove") {
    const ids = new Set(msg.ids || []);
    updateArchive((list) => list.filter((e) => !ids.has(e.id))).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "archive-run") {
    // 自動アーカイブを今すぐ実行する (テストと、将来の「今すぐ整理」ボタン用)
    autoArchive().then((count) => sendResponse({ ok: true, count }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "archive-clear") {
    updateArchive(() => []).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "add-pin") {
    addPin(msg.url, msg.title).then(sendResponse, () => sendResponse({ ok: false, reason: "error" }));
    return true;
  }
});

// ---- 担当タブの最終 URL の記録 ----
// サイドパネルが担当タブ (ownedTabs: storage.session) を管理し、ここでは各担当タブが最後に表示していた URL を
// storage.local の ownedUrls に記録する。ブラウザ再起動でタブ ID が変わっても、閲覧先へ移動したまま復元された
// 担当タブをパネルがこの URL で結び直せる。書き込みはここだけ (直列化して read-modify-write の競合を防ぐ)。
let ownedUrlsQueue = Promise.resolve();
function updateOwnedUrls(mutate) {
  ownedUrlsQueue = ownedUrlsQueue.then(async () => {
    const { ownedUrls = {} } = await chrome.storage.local.get("ownedUrls");
    if (mutate(ownedUrls) !== false) await chrome.storage.local.set({ ownedUrls });
  }).catch((e) => console.warn("ownedUrls update failed", e));
  return ownedUrlsQueue;
}

// GitHub の PR の担当 ID は "gh:<PR の URL>" (sidepanel.js の ghOwnerId と同じ。SW は別コンテキストなので複製)。
// 担当先になる PR は、専用タブの設定がオン・トークンあり・フォルダの表示がオンの一覧 (sidepanel.js の ghPrTargets と同じ規則)
const GH_PREFIX = "gh:";
function ghVisiblePrs(s, gh) {
  if (!s.ghDedicatedTab || !s.token) return [];
  return [...(s.showMine ? gh.mine || [] : []), ...(s.showReviews ? gh.reviews || [] : [])];
}

// 旧 "github" 担当 (GitHub フォルダ全体の専用タブ) の一度きりの移行。旧版が Chrome 固定したタブは、更新で
// storage.session の ownedTabs が消えるとパネルの孤児掃除 (releaseOwnedTab) に拾われず、固定のまま残る。
// ownedPinned.github が真なら、固定タブのうち最後の URL (ownedUrls.github) と一致する 1 枚だけを固定解除する
// (一致が取れなければ固定は触らない。ユーザー自身の固定タブを推測で外さない)。そのあと両方のキーを消す。
// ownedUrls.github を消す stale 掃除より前に走らせること。session に "github" が残っていればパネルの release に任せる
async function migrateLegacyGhOwner() {
  const { ownedPinned = {}, ownedUrls = {} } = await chrome.storage.local.get(["ownedPinned", "ownedUrls"]);
  if (!("github" in ownedPinned) && !("github" in ownedUrls)) return;
  const { ownedTabs = {} } = await chrome.storage.session.get("ownedTabs");
  if ("github" in ownedTabs) return;
  if (ownedPinned.github && ownedUrls.github) {
    const tabs = await chrome.tabs.query({ pinned: true });
    const hit = tabs.find((t) => !t.incognito && sameUrl(t.url || "", ownedUrls.github));
    if (hit) await chrome.tabs.update(hit.id, { pinned: false }).catch(() => { /* 既に閉じている */ });
  }
  if ("github" in ownedPinned) {
    const { ownedPinned: cur = {} } = await chrome.storage.local.get("ownedPinned");
    delete cur.github;
    await chrome.storage.local.set({ ownedPinned: cur });
  }
  await updateOwnedUrls((m) => (("github" in m) ? (delete m.github, true) : false));
}
let legacyMigration = Promise.resolve();
const migrateLegacyOnce = () => (legacyMigration = legacyMigration.then(migrateLegacyGhOwner).catch((e) => console.warn("legacy github migration failed", e)));
migrateLegacyOnce();

async function ownerOfTab(tabId) {
  const { ownedTabs = {} } = await chrome.storage.session.get("ownedTabs");
  return Object.keys(ownedTabs).find((k) => ownedTabs[k] === tabId) || null;
}

// 末尾スラッシュとハッシュの違いは同じページとみなす (sidepanel.js の sameUrl と同じ。SW はモジュールなので複製)
function sameUrl(a, b) {
  const norm = (u) => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return u; } };
  return norm(a) === norm(b);
}

// storage.session が消えた後 (再起動・再読み込み・更新・無効→有効)、パネルが開かれる前に自動アーカイブが走っても
// 担当タブを閉じないよう、sidepanel.js の reconcileOwnedTabs と同じ規則で背景からも結び直す。
// ownedTabs キーが無いときだけ (パネルが書いた後は触らない)。何も結べなければ書かない (次の周期で再試行)
async function reconcileOwnedTabsIfWiped() {
  if ("ownedTabs" in (await chrome.storage.session.get("ownedTabs"))) return;
  const [s, sync, { ownedUrls = {} }, tabs] = await Promise.all([
    getSettings(), chrome.storage.sync.get(["pins", "pinnedTabs"]), chrome.storage.local.get("ownedUrls"), chrome.tabs.query({}),
  ]);
  const owners = flatPinItems(sync.pins).map((p) => [p.id, p.url]);
  const listOwned = new Set();
  const walk = (nodes) => { for (const n of nodes || []) { if (n.type === "tab") { owners.push([n.id, n.url]); listOwned.add(n.id); } else walk(n.children); } };
  walk(sync.pinnedTabs);
  const { github: gh = {} } = await chrome.storage.local.get("github");
  const listPrIds = new Set();
  for (const pr of ghVisiblePrs(s, gh)) { owners.push([GH_PREFIX + pr.url, pr.url]); listPrIds.add(GH_PREFIX + pr.url); }
  const bound = {}, taken = new Set();
  const tryBind = (id, url) => {
    if (!url || id in bound) return;
    const mustBePinned = s.pinOwnedTabs && !listOwned.has(id) && !listPrIds.has(id);
    const tab = tabs.find((t) => (!mustBePinned || t.pinned) && !t.incognito && !taken.has(t.id) && /^https?:/.test(t.url || "") && sameUrl(t.url, url));
    if (tab) { bound[id] = tab.id; taken.add(tab.id); }
  };
  for (const [id] of owners) tryBind(id, ownedUrls[id]);
  for (const [id, url] of owners) tryBind(id, url);
  if (!Object.keys(bound).length) return;
  // 書き込みは onReplaced と同じ直列化キューを通す。待っている間にパネルが書いていたら、上書きしない
  await enqueueOwnedTabs(async () => {
    if ("ownedTabs" in (await chrome.storage.session.get("ownedTabs"))) return;
    await chrome.storage.session.set({ ownedTabs: bound });
  });
}

// session の ownedTabs の read-modify-write の直列化キュー (updateOwnedUrls と同じ考え)。分割項目のペアを discard すると onReplaced が
// 続けて 2 回来る。get → set を並行させると後の set が先の付け替えを上書きして失い、担当を失う (次のクリックでタブが増える)
let ownedTabsQueue = Promise.resolve();
function enqueueOwnedTabs(job) {
  ownedTabsQueue = ownedTabsQueue.then(job).catch((e) => console.warn("ownedTabs update failed", e));
  return ownedTabsQueue;
}
function updateOwnedTabs(mutate) {
  return enqueueOwnedTabs(async () => {
    const { ownedTabs = {} } = await chrome.storage.session.get("ownedTabs"); // 毎回読み直す
    if (mutate(ownedTabs) !== false) await chrome.storage.session.set({ ownedTabs });
  });
}

// 破棄 (メモリセーバー / chrome.tabs.discard) やプリレンダーの差し替えでタブ ID が変わる。担当の対応を新しい ID に付け替える
// (パネルが閉じていても追従させ、autoArchive の ownedTabIds() が新 ID を見るように)。session の ownedTabs を背景が書く唯一の例外。
// 旧 ID を持つ担当を全部付け替える (冪等。変わらなければ書かない)。パネルも同じ付け替えをするが、結果は同じになる
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => updateOwnedTabs((m) => {
  const owners = Object.keys(m).filter((k) => m[k] === removedTabId);
  owners.forEach((k) => { m[k] = addedTabId; });
  return owners.length > 0;
}));

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url || !/^https?:/.test(info.url)) return;
  const owner = await ownerOfTab(tabId);
  if (owner) updateOwnedUrls((m) => (m[owner] === info.url ? false : ((m[owner] = info.url), true)));
});

// 新しく担当になったタブの現在の URL を記録する (移動しないまま再起動されても結び直せるように)
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session" && changes.ownedTabs) {
    const before = changes.ownedTabs.oldValue || {};
    const after = changes.ownedTabs.newValue || {};
    for (const [owner, tabId] of Object.entries(after)) {
      if (before[owner] === tabId) continue;
      try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab.url || tab.pendingUrl;
        if (url && /^https?:/.test(url)) updateOwnedUrls((m) => (m[owner] === url ? false : ((m[owner] = url), true)));
      } catch { /* 既に閉じている */ }
    }
  }
  // 削除されたお気に入り・ピン留めタブ・一覧から消えた PR の記録を消す (pins / pinnedTabs の全 ID と、見えている PR を正とする)。
  // 旧 "github" の記録もここで消える
  if ((area === "sync" && (changes.pins || changes.pinnedTabs || changes.settings)) || (area === "local" && (changes.github || changes.githubToken))) {
    await migrateLegacyOnce(); // ownedUrls.github を消す前に旧固定タブを移行する
    const [all, s, { github: gh = {} }] = await Promise.all([
      chrome.storage.sync.get(["pins", "pinnedTabs"]), getSettings(), chrome.storage.local.get("github"),
    ]);
    const ids = new Set(flatPinItems(all.pins).map((p) => p.id));
    const walk = (nodes) => { for (const n of nodes || []) { if (n.type === "tab") ids.add(n.id); else walk(n.children); } };
    walk(all.pinnedTabs);
    for (const pr of ghVisiblePrs(s, gh)) ids.add(GH_PREFIX + pr.url);
    updateOwnedUrls((m) => {
      const stale = Object.keys(m).filter((k) => !ids.has(k));
      stale.forEach((k) => delete m[k]);
      return stale.length > 0;
    });
  }
});

// ---- 自動アーカイブ (Arc の「しばらく見ていないタブは片付く」) ----
// 一定時間アクティブにしていない通常のタブを閉じ、storage.local の archive に残す (パネルのアーカイブ画面から開き直せる)。
// 対象外: 固定タブ、ピンの担当タブ、各ウィンドウで表示中のタブ、音を出しているタブ、http(s) 以外のタブ。分割表示のペインはペアの全部が対象のときだけ (wholeSplits)。
// 表示中のタブは対象外なので、ウィンドウのタブが全部閉じてウィンドウごと消えることはない。
// 最終アクセス時刻は tab.lastAccessed。ただしブラウザの起動時とインストール時を起点に猶予を数え直す (archiveGraceFrom)。
const ARCHIVE_ALARM = "auto-archive";
const ARCHIVE_MAX = 300;

async function scheduleArchiveAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ARCHIVE_ALARM);
  if (Number(s.autoArchiveHours) > 0) await chrome.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
}

let archiveQueue = Promise.resolve();
function updateArchive(mutate) {
  archiveQueue = archiveQueue.then(async () => {
    const { archive = [] } = await chrome.storage.local.get("archive");
    const next = mutate(archive);
    if (next) await chrome.storage.local.set({ archive: next.slice(0, ARCHIVE_MAX) });
  }).catch((e) => console.warn("archive update failed", e));
  return archiveQueue;
}

function archiveEntry(tab, reason) {
  const fav = tab.favIconUrl || "";
  // ナビゲーションがコミットするまで tab.url は "" で pendingUrl にだけ URL が入る (archiveTabsById と同じ判定)
  const url = tab.url || tab.pendingUrl || "";
  return {
    id: crypto.randomUUID(),
    url,
    title: tab.title || url,
    // 大きな data: URL は保存しない (アーカイブ画面では Chrome の favicon で代用する)
    favIconUrl: /^(https?:|data:)/.test(fav) && fav.length <= 4096 ? fav : null,
    archivedAt: Date.now(),
    reason,
  };
}

async function ownedTabIds() {
  const { ownedTabs = {} } = await chrome.storage.session.get("ownedTabs");
  return new Set(Object.values(ownedTabs));
}

// Chrome の分割表示 (split view) のペインか。Chrome 140 より前は splitViewId が無い (パネルの split.js の inSplit と同じ)
const NO_SPLIT = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1;
function inSplit(tab) {
  return (tab.splitViewId ?? NO_SPLIT) !== NO_SPLIT;
}

// 閉じる候補 (candidates) のうち、分割のペインはペアの全部が候補のときだけ残す。分割の非 active のペインは見えているのに
// active が false なので、1 枚ずつ判定すると表示中の分割の片方だけを閉じてしまう。all は相方を探すためのタブ一覧
function wholeSplits(candidates, all) {
  const ids = new Set(candidates.map((tab) => tab.id));
  return candidates.filter((tab) => !inSplit(tab) || all.every((x) => x.splitViewId !== tab.splitViewId || ids.has(x.id)));
}

// 閉じたタブから順に記録する。閉じられなかったタブ (既に閉じていた等) の記録は残さない。
// tabs.remove は、下書きなどで「このサイトを離れますか」(beforeunload) の確認が出るタブではユーザーが答えるまで解決せず、
// キャンセルすると永久に保留になる (Chrome の TabsRemoveFunction は WebContentsDestroyed を待つ)。1 件の保留で他のタブの
// 記録や応答を道連れにしないよう、タブごとに並列に閉じて閉じたものはその場で記録し、応答は ARCHIVE_CLOSE_WAIT_MS で打ち切る。
// 待っても閉じなかったタブは確認が出ているとみなし、ユーザーが自分でそのタブを見る (lastAccessed が変わる) まで自動アーカイブの
// 候補から外す (storage.session の archiveSkip { [tabId]: lastAccessed })。手動の ⇣ は対象のまま。「離れる」が押されれば
// 保留中の remove が解決して記録される (SW が 5 分で終了した後は記録されない。ユーザー自身の閉じ操作なので × と同じ扱い)。
const ARCHIVE_CLOSE_WAIT_MS = 5000;
const closing = new Map(); // tabId -> 最新の試行。保留中の remove が複数あっても、実際に閉じたときの記録は 1 回

async function closeAndRecord(tab, reason) {
  const attempt = Symbol("attempt");
  closing.set(tab.id, attempt);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    if (closing.get(tab.id) === attempt) closing.delete(tab.id);
    return "gone"; // 既に閉じている
  }
  if (closing.get(tab.id) !== attempt) return "closed"; // 別の試行が記録する
  closing.delete(tab.id);
  const entry = archiveEntry(tab, reason);
  if (/^https?:/.test(entry.url)) await updateArchive((list) => [entry, ...list]);
  return "closed";
}

async function archiveTabs(tabs, reason) {
  if (!tabs.length) return 0;
  const timeout = new Promise((resolve) => setTimeout(resolve, ARCHIVE_CLOSE_WAIT_MS, "stuck"));
  const results = await Promise.all(tabs.map((tab) => Promise.race([closeAndRecord(tab, reason), timeout])));
  const stuck = tabs.filter((_, i) => results[i] === "stuck");
  if (stuck.length) {
    const { archiveSkip = {} } = await chrome.storage.session.get("archiveSkip");
    for (const tab of stuck) {
      // ダイアログ表示でタブがアクティブになり lastAccessed が更新されるので、その後の値を記録する
      try { archiveSkip[tab.id] = (await chrome.tabs.get(tab.id)).lastAccessed; } catch { /* 閉じた直後 */ }
    }
    await chrome.storage.session.set({ archiveSkip });
  }
  return results.filter((r) => r === "closed").length;
}

async function archiveTabsById(ids, reason) {
  const owned = await ownedTabIds();
  const all = await chrome.tabs.query({});
  const wanted = new Set(ids);
  const urlOf = (tab) => tab.url || tab.pendingUrl || "";
  const isHttp = (tab) => /^https?:/.test(urlOf(tab));
  // 記録して閉じるのは http(s) のタブ、記録せずに閉じるのは空の新しいタブ。chrome:// の設定画面、ほかの拡張のページ、
  // ローカルファイルなどは開き直せる形で記録できないので触らない。
  // シークレットウィンドウのタブは対象外 (storage.local は通常/シークレットで共有・永続するので、シークレットの閲覧データは記録しない)
  const picked = all.filter((tab) => wanted.has(tab.id) && !tab.pinned && !tab.incognito && !owned.has(tab.id)
    && (isHttp(tab) || /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(urlOf(tab))));
  const closing = wholeSplits(picked, all);
  await Promise.all(closing.filter((tab) => !isHttp(tab)).map((tab) => chrome.tabs.remove(tab.id).catch(() => { /* 既に閉じている */ })));
  return archiveTabs(closing.filter(isHttp), reason);
}

async function autoArchive() {
  const s = await getSettings();
  const hours = Number(s.autoArchiveHours);
  if (!(hours > 0)) return;
  const { archiveGraceFrom = Date.now(), archiveSkip = {} } = await chrome.storage.session.get(["archiveGraceFrom", "archiveSkip"]);
  const cutoff = Date.now() - hours * 3600 * 1000;
  await reconcileOwnedTabsIfWiped(); // 再起動後、パネルが開かれる前でも担当タブを閉じない
  const owned = await ownedTabIds();
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const stale = tabs.filter((tab) =>
    !tab.pinned && !tab.active && !tab.audible && !tab.incognito && !owned.has(tab.id)
    && /^https?:/.test(tab.url || "")
    && archiveSkip[tab.id] !== tab.lastAccessed
    && Math.max(Number(tab.lastAccessed) || 0, archiveGraceFrom) < cutoff);
  return archiveTabs(wholeSplits(stale, tabs), "auto"); // 分割はペアごと (表示中の分割の見えている片方を閉じない)
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
    const before = changes.settings.oldValue?.autoArchiveHours;
    const after = changes.settings.newValue?.autoArchiveHours;
    if (before !== after) scheduleArchiveAlarm();
  }
});
