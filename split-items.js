// 分割項目 (split item): ピン留めタブの一覧とお気に入りのグリッドに、Chrome の分割表示 (split view) のペアを 1 項目として置く。pinned.js の前に読み込む
// (sanitizedItems が init の早い段階で呼ばれるため。ほかは呼び出し時に参照するだけなので、読み込み順は問われない)。
//
// 保存形:
//   pinnedTabs の node:  { type: "split", id, children: [tab, tab] }   ペインは { type: "tab", id, url, title }。フォルダの中にも置ける
//   pins の要素:        { type: "split", id, children: [pin, pin] }   ペインは { id, url, title } (type は付けない)。1 マスで、maxPins は項目数で数える
//   ・children はちょうど 2 枚 (左 → 右)。ペイン id は 2 つの容器をまたいで一意。split.id は担当先ではなく、DOM のキーと並べ替えの単位にだけ使う
//   ・担当タブはペインごと (ownedTabs のキー = ペイン id)。結合・引き出し・お気に入り ⇄ ピン留めの移動はペイン id を保つので、担当には触らない
//   ・項目単位のタイトルは持たない (名前変更はペインごと)
// Chrome 側の組み立ては assembleSplit が唯一の入口 (冪等)。起動時には作らず、クリック (openSplit) と、結合・移動・Today からの落とし込みのときだけ行う。
// 固定タブにするのはお気に入りの分割だけ (設定「固定タブにする」に従う。setPanePinned で 2 枚とも揃える)。ピン留めタブの分割は固定しない。

// ---------- データ ----------
function isSplitItem(node) { return node?.type === "split"; }
function itemTabs(node) { return isSplitItem(node) ? node.children : [node]; } // 担当先になるもの (葉)
const flatPins = () => pins.flatMap(itemTabs); // お気に入りの担当先になるもの (分割項目はペインに展開)
const toNodePane = (p) => ({ type: "tab", id: p.id, url: p.url, title: p.title }); // pins のペイン → pinnedTabs のペイン
const toPinPane = (p) => ({ id: p.id, url: p.url, title: p.title });               // pinnedTabs のペイン → pins のペイン
const pinLeaf = (id) => flatPins().find((p) => p.id === id) || null;
// 分割項目を、ピン留めタブの木かお気に入りから id で引く。fav はお気に入り側か
function splitItemById(id) {
  const node = findNode(pinnedTabs, id)?.node;
  if (isSplitItem(node)) return { item: node, fav: false };
  const pin = pins.find((p) => p.id === id);
  return isSplitItem(pin) ? { item: pin, fav: true } : null;
}

// 読み込み時の正規化 (pinnedTabs の木)。別端末の編集や旧版で壊れた形が、描画やドラッグに入らないようにする (保存し直さない):
// children が有効な 2 ペインでない split は平らな通常項目へ展開し、入れ子の split / folder は展開し、ペイン id の重複は後を捨てる
function sanitizedItems(nodes) {
  const seen = new Set();
  const valid = (n) => !!n && typeof n.id === "string" && typeof n.url === "string" && !seen.has(n.id);
  const leaves = (n) => (n?.type === "split" || n?.type === "folder" ? (n.children || []).flatMap(leaves) : [n]);
  const take = (n) => { if (!valid(n)) return null; seen.add(n.id); return { ...n, type: "tab" }; };
  const clean = (list) => (Array.isArray(list) ? list : []).flatMap((n) => {
    if (n?.type === "folder") return [{ ...n, children: clean(n.children) }];
    if (n?.type !== "split") return take(n) ? [n] : [];
    const panes = leaves(n).map(take).filter(Boolean);
    const whole = panes.length === 2 && typeof n.id === "string" && !seen.has(n.id) && (n.children || []).length === 2;
    if (whole) seen.add(n.id);
    return whole ? [{ ...n, children: panes }] : panes;
  });
  return clean(nodes);
}

// 読み込み時の正規化 (pins)。sanitizedItems と同じ規則で、お気に入りは平らな 1 階層 (フォルダなし)。単独の要素は同一のまま通す
function sanitizedPins(list) {
  const seen = new Set();
  const valid = (n) => !!n && typeof n.id === "string" && typeof n.url === "string" && !seen.has(n.id);
  const leaves = (n) => (n?.type === "split" ? (n.children || []).flatMap(leaves) : [n]);
  const take = (n) => { if (!valid(n)) return null; seen.add(n.id); return toPinPane(n); };
  return (Array.isArray(list) ? list : []).flatMap((n) => {
    if (n?.type !== "split") return valid(n) ? (seen.add(n.id), [n]) : [];
    const panes = leaves(n).map(take).filter(Boolean);
    const whole = panes.length === 2 && typeof n.id === "string" && !seen.has(n.id) && (n.children || []).length === 2;
    if (whole) seen.add(n.id);
    return whole ? [{ type: "split", id: n.id, children: panes }] : panes;
  });
}

// ペインを引き出したとき (ドラッグが始まって確定するとき) の、メモリ上の木の組み替え: split を 2 つの通常の tab ノードに展開する (左、右の順)。
// 引き出したペインではない側 (残る側) の id を返す
function dissolveInMemory(splitId, pulledId) {
  const r = findNode(pinnedTabs, splitId);
  if (!r || !isSplitItem(r.node)) return null;
  const panes = r.node.children;
  r.siblings.splice(r.index, 1, ...panes);
  return { remainId: panes.find((p) => p.id !== pulledId)?.id };
}

// 引き出しの確定: 組み替えて保存し、Chrome の分割も解く (担当と固定は触らない)。移動先が拒否しても引き出しは確定する (Chrome は解けているので、
// データも合わせる)。残る側の id を返す。保存に失敗したら null
async function dissolveSplit(splitId, pulledId) {
  const prev = cloneTree(pinnedTabs);
  const r = findNode(pinnedTabs, splitId);
  const tabs = r && isSplitItem(r.node) ? r.node.children.map((p) => ownedTabOf(p.id)) : [];
  const done = dissolveInMemory(splitId, pulledId);
  if (!done) return null;
  if (tabs.every(Boolean) && inSplit(tabs[0]) && tabs[0].splitViewId === tabs[1].splitViewId) await unsplitTab(tabs[0].id);
  return (await savePinnedTabs(prev)) ? done.remainId : null;
}

// お気に入りの分割項目から 1 枚を引き出す確定 (dissolveSplit の pins 版)。2 枚の通常のお気に入りに展開して保存し、Chrome の分割も解く。残る側の id を返す。失敗は null
async function dissolvePinSplit(splitId, pulledId) {
  const item = pins.find((p) => p.id === splitId);
  if (!isSplitItem(item)) return null;
  const prev = pins.slice();
  const tabs = item.children.map((p) => ownedTabOf(p.id));
  pins = pins.flatMap((p) => (p === item ? item.children.map(toPinPane) : [p]));
  if (tabs.every(Boolean) && inSplit(tabs[0]) && tabs[0].splitViewId === tabs[1].splitViewId) await unsplitTab(tabs[0].id);
  return (await persistPins(prev)) ? item.children.find((p) => p.id !== pulledId).id : null;
}

// ---------- 担当タブ ----------
// 複数のタブを 1 回の session.set で担当にする (中間の状態を storage.onChanged に見せない)。どれかが別の担当のタブなら、全体を断る (分割を半端に採用しない)。
// pairs = [[ownerId, tabId], ...]。await より前に対応表へ載せる (並行するクリックに奪われないように)
async function adoptTabs(pairs) {
  const taken = new Set(Object.values(ownedTabs));
  if (pairs.some(([, tabId]) => taken.has(tabId))) return false;
  ownedTabs = { ...ownedTabs, ...Object.fromEntries(pairs) };
  await chrome.storage.session.set({ ownedTabs });
  await refreshOpenTabs();
  return true;
}

// ---------- Chrome 側の組み立て ----------
// 担当タブ (panes = [[ペイン id, タブ id], ...] を左 → 右の順) の Chrome の固定を揃える。chromePin なら左 → 右の順に固定し、外すときは拡張が固定した
// もの (ownedPinned) だけを右 → 左の順に外す (ユーザー自身が固定したタブは触らない)。固定の付け外しは分割を解くので、呼び出し側が先に unsplit し、
// 終わってから組み直す (assembleSplit がその入口)。タブが無い・閉じているペインは飛ばす
async function setPanePinned(panes, chromePin) {
  const op = await getOwnedPinned();
  const live = await Promise.all(panes.map(([, tabId]) => (tabId === undefined ? null : chrome.tabs.get(tabId).catch(() => null))));
  const items = panes.map(([owner], i) => [owner, live[i]]).filter(([, tab]) => !!tab);
  if (chromePin) {
    for (const [owner, tab] of items) {
      if (tab.pinned) continue;
      try { await chrome.tabs.update(tab.id, { pinned: true }); op[owner] = true; } catch { /* 閉じられた等 */ }
    }
  } else {
    for (const [owner, tab] of [...items].reverse()) {
      if (!op[owner]) continue;
      if (tab.pinned) { try { await chrome.tabs.update(tab.id, { pinned: false }); } catch { /* 閉じられた等 */ } }
      delete op[owner];
    }
  }
  await chrome.storage.local.set({ ownedPinned: op });
}

// 2 枚 (左 → 右) を Chrome の分割表示にする。全経路の唯一の入口で、冪等 (既に揃った分割なら何もしない。strip の左右の順は見ない)。
// 戻り値: "split" | "adjacent" (分割にできない。2 枚のタブは開いたまま) | "partial" (片方が閉じている)。
// pinned: null なら固定は触らず、2 枚の固定状態が同じときだけ組む (ピン留めタブの分割)。true / false なら 2 枚をその状態に揃えてから組む (お気に入りの分割。設定「固定タブにする」)。
//   外す方向は拡張が固定したタブ (ownedPinned) だけで、ユーザーが固定したタブは固定のまま。揃えられない・ユーザーのタブグループから外れてしまう (固定すると
//   グループから外れる) 組は、先に分かる時点で、ユーザーの別の分割を解いたりタブを動かしたりせず "adjacent" で終える。
// ユーザーのタブグループは動かさない。prefWindow があれば、2 枚ともそのウィンドウへ寄せる (無ければ右を左のウィンドウへ)。
// 呼び出し全体を holdingToday で包む (一瞬の途中状態を描かない)
function assembleSplit(ids, { prefWindow = null, pinned = null } = {}) {
  return holdingToday(async () => {
    const get = (id) => chrome.tabs.get(id).catch(() => null);
    let [left, right] = await Promise.all(ids.map(get));
    if (!left || !right) return "partial";
    const op = pinned === null ? {} : await getOwnedPinned();
    const ownerOf = (tab) => Object.keys(ownedTabs).find((k) => ownedTabs[k] === tab.id);
    // 揃えたあとの固定状態 (担当でないタブは触れないのでそのまま)
    const settledPin = (tab) => {
      const owner = ownerOf(tab);
      if (pinned === null || owner === undefined) return tab.pinned;
      return pinned ? true : tab.pinned && !op[owner];
    };
    if (pinned === true && [left, right].some((tab) => ownerOf(tab) !== undefined && !tab.pinned && tab.groupId !== -1)) return "adjacent";
    if (inSplit(left) && left.splitViewId === right.splitViewId && [left, right].every((tab) => tab.pinned === settledPin(tab))) return "split";
    // 組めないと先に分かる不一致 (固定状態、タブグループ。ウィンドウをまたぐと groupId は -1 になる) では、ユーザーの別の分割を解いたりタブを動かしたりしない
    const to = prefWindow ?? left.windowId;
    const groupAfterMove = (tab) => (tab.windowId === to ? tab.groupId : -1);
    if (settledPin(left) !== settledPin(right) || groupAfterMove(left) !== groupAfterMove(right)) return "adjacent";
    for (const tab of [left, right]) if (inSplit(tab)) await unsplitTab(tab.id); // 別の分割に入っている (相方はユーザーのタブ)。固定を揃えるときの分割もここで解く
    try {
      for (const tab of prefWindow === null ? [right] : [left, right]) {
        const to = prefWindow ?? left.windowId;
        if (tab.windowId !== to) await chrome.tabs.move(tab.id, { windowId: to, index: -1 });
      }
    } catch { return "adjacent"; }
    if (pinned !== null) await setPanePinned([left, right].map((tab) => [ownerOf(tab), tab.id]), pinned);
    [left, right] = await Promise.all(ids.map(get));
    if (!left || !right) return "partial";
    if (left.pinned !== right.pinned || left.groupId !== right.groupId) return "adjacent";
    if (right.index !== left.index + 1) {
      // 右を左の直後へ。右が左より前にあれば、右を抜いた分だけ左が 1 つ前にずれる
      try { await chrome.tabs.move(right.id, { index: right.index < left.index ? left.index : left.index + 1 }); } catch { return "adjacent"; }
    }
    try { await chrome.tabs.createSplit([left.id, right.id]); } catch { return "adjacent"; }
    return "split";
  });
}

// 分割項目を消す / Today へ戻すときの担当の解放 (2 枚とも)。お気に入りの分割 (拡張が固定した) は、1 枚ずつ固定を外すと分割が解けるので、
// 先に解く → 右 → 左の順に解放 → 両方生きていれば Today の分割として組み直す。ピン留めタブの分割 (固定していない) は解放だけで、分割は Chrome に残る
// 解放の前に、2 枚のタブと「拡張が固定した分割だったか」を控える。項目を保存すると、他のパネルや自分の storage.onChanged (pruneOrphanOwners) が先に担当を外して
// 分割を解いてしまうことがあるので、呼び出し側は保存の前に控えておき、releaseSplitPanes に渡す
async function splitReleaseSnapshot(paneIds) {
  const op = await getOwnedPinned();
  const live = await Promise.all(paneIds.map((id) => (ownedTabs[id] === undefined ? null : chrome.tabs.get(ownedTabs[id]).catch(() => null))));
  const ours = paneIds.some((id) => op[id]);
  const wasSplit = live.every(Boolean) && inSplit(live[0]) && live[0].splitViewId === live[1].splitViewId;
  return { tabIds: live.map((tab) => tab?.id), recombine: ours && wasSplit };
}

async function releaseSplitPanes(paneIds, snap = null) {
  const { tabIds, recombine } = snap || await splitReleaseSnapshot(paneIds);
  if (recombine) await unsplitTab(tabIds[0]);
  for (const id of [...paneIds].reverse()) await releaseOwnedTab(id);
  if (recombine) await assembleSplit(tabIds, { pinned: false });
}

// ---------- クリックで開く ----------
// 分割項目のクリック。ownedInFlight を項目の id (split.id) をキーに直列化する (ペインごとにすると create / createSplit が競合してタブが重複する)
function openSplit(itemId, paneId) {
  const prev = ownedInFlight.get(itemId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => openSplitNow(itemId, paneId));
  ownedInFlight.set(itemId, next);
  next.finally(() => { if (ownedInFlight.get(itemId) === next) ownedInFlight.delete(itemId); });
  return next;
}

// 担当が両方無いとき、2 つの URL がそれぞれ一致する「担当の無い生きた分割のペア」があればそれを担当にする (タブを増やさない)。
// 片方だけ一致する分割は奪わない
function liveSplitPairFor(item) {
  const taken = new Set(Object.values(ownedTabs));
  const free = openTabs.filter((tab) => inSplit(tab) && !taken.has(tab.id));
  const match = (tab, pane) => /^https?:/.test(tab.url || "") && sameUrl(tab.url, pane.url);
  for (const tab of free) {
    const partner = free.find((x) => x.splitViewId === tab.splitViewId && x.id !== tab.id);
    if (!partner) continue;
    if (match(tab, item.children[0]) && match(partner, item.children[1])) return [tab, partner];
    if (match(tab, item.children[1]) && match(partner, item.children[0])) return [partner, tab];
  }
  return null;
}

async function openSplitNow(itemId, paneId) {
  await refreshOpenTabs();
  await pruneOwnedTabs();
  const found = splitItemById(itemId);
  if (!found) { // 結合や引き出しで、もう分割項目ではない: 単独の項目として開く (お気に入りなら設定に従って固定する)
    const treePane = findNode(pinnedTabs, paneId || itemId)?.node;
    const pane = treePane || pinLeaf(paneId || itemId);
    return pane && !isSplitItem(pane) ? openOwnedNow(pane.id, pane.url, { chromePin: treePane ? false : !!settings.pinOwnedTabs }) : undefined;
  }
  const { item, fav } = found;
  const W = fav ? !!settings.pinOwnedTabs : null; // お気に入りの分割は設定「固定タブにする」に従って 2 枚とも固定する
  const panes = item.children;
  const tabs = panes.map((p) => ownedTabOf(p.id));
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const lookingAt = !!current && tabs.some((tab) => tab?.id === current.id); // 再クリックの判定: いま 2 枚のどちらかを見ている

  if (!tabs[0] && !tabs[1]) {
    const pair = liveSplitPairFor(item);
    if (pair && await adoptTabs(pair.map((tab, i) => [panes[i].id, tab.id]))) pair.forEach((tab, i) => { tabs[i] = tab; });
  }
  // 欠けたペインを 1 枚ずつ補う。URL が一致する (分割に入っていない) 未担当のタブがあれば採用し、無ければ相方の隣に作る
  // (作ってから動かすと分割が解けるので、作る時点で隣に置く。分割の内側の index は分割の後ろへ押し出される。assembleSplit が隣接を直す)
  for (const i of [0, 1]) {
    if (tabs[i]) continue;
    const pane = panes[i];
    const taken = new Set(Object.values(ownedTabs));
    let tab = openTabs.find((x) => !taken.has(x.id) && !inSplit(x) && /^https?:/.test(x.url || "") && sameUrl(x.url, pane.url));
    if (tab) {
      await bindOwnedTab(pane.id, tab.id);
    } else {
      const partner = tabs[1 - i] ? await chrome.tabs.get(tabs[1 - i].id).catch(() => null) : null;
      tab = await chrome.tabs.create({
        url: pane.url, active: false, pinned: W === true || !!partner?.pinned, windowId: partner?.windowId ?? myWindowId,
        ...(partner ? { index: partner.index + (i === 0 ? 0 : 1) } : {}),
      }).catch(() => null);
      if (!tab) break; // 開けなかった。ここまでに採用した分は残し、項目は消さない
      markFresh(pane.id, tab.id, pane.url);
      await bindOwnedTab(pane.id, tab.id);
      if (W === true && tab.pinned) await setOwnedPinned(pane.id, true); // 拡張が固定したタブとして記録 (設定をオフにしたときに外せる)
    }
    tabs[i] = tab;
  }
  await refreshOpenTabs();

  if (tabs[0] && tabs[1] && await assembleSplit(tabs.map((tab) => tab.id), { pinned: W }) === "adjacent") flash(t("splitOpenFailed"));

  // 押したペインを前面に (無ければ、いま表示中のペイン、無ければ左)。見ている最中の再クリックなら、押したペインだけ登録 URL に戻す
  // (つまみ / 隙間のクリックでは、どちらのペインか曖昧なので戻さない)
  const pressed = panes.findIndex((p) => p.id === paneId);
  const pressedTab = pressed < 0 ? null : tabs[pressed];
  if (lookingAt && pressedTab && !sameUrl(pressedTab.url, panes[pressed].url)) {
    await chrome.tabs.update(pressedTab.id, { url: panes[pressed].url }).catch(() => {});
    markFresh(panes[pressed].id, pressedTab.id, panes[pressed].url);
  }
  const front = pressedTab || tabs.find((tab) => tab?.id === current?.id) || tabs[0] || tabs[1];
  const fresh = front && await chrome.tabs.get(front.id).catch(() => null);
  if (fresh) await focusTab(fresh);
}

// ---------- Today 欄 <-> ピン留めタブ / お気に入り ----------
// お気に入りの分割項目 (1 マス) を target の位置 (where: before / after (id のタイルの前後) / end) に入れて保存する。容量を超えるときは何も変えずに null
async function insertPinSplit(item, { where = "end", id = null } = {}) {
  if (!pinsFit([...pins, item])) { flash(t("pinStorageFull")); return null; }
  const at = id ? pins.findIndex((p) => p.id === id) : -1;
  if (where !== "end" && at < 0) return null; // 置き先がドラッグ中に消えた
  const prev = pins.slice();
  const cut = at + (where === "after" ? 1 : 0);
  pins = where === "end" ? [...pins, item] : [...pins.slice(0, cut), item, ...pins.slice(cut)];
  if (!(await persistPins(prev))) return null;
  renderPins();
  return item;
}

// 2 枚のタブ (左 → 右) を分割項目として target の位置に置く (target.kind が "favorites" ならお気に入り、それ以外はピン留めタブ)。重複・件数・容量・URL を確かめ、
// 通らなければ何も変えない。保存が先、担当の結び付けが後 (逆だと、他のパネルの pruneOrphanOwners が、一覧に無い担当を孤児として外す)。
// 保存できて結び付けに失敗したら項目だけが残り、タブは分割のまま Today に残る (次のクリックで liveSplitPairFor が拾う)。
// お気に入りは続けて 2 枚とも固定する (設定がオンのとき。固定は分割を解くので assembleSplit が揃えてから組み直す)
async function pinSplitFromTabs(tabs, target) {
  const fav = target.kind === "favorites";
  const urls = tabs.map((tab) => tab.url || tab.pendingUrl || "");
  if (!urls.every((u) => /^https?:/.test(u))) return flash(t("pinUnsupportedUrl"));
  const exist = fav ? new Set(flatPins().map((p) => p.url)) : treeUrls(pinnedTabs);
  if (urls[0] === urls[1] || urls.some((u) => exist.has(u))) return flash(t("pinDuplicate"));
  if (fav && pins.length >= settings.maxPins) return flash(t("pinLimitReachedSettings", settings.maxPins));
  const item = {
    type: "split", id: crypto.randomUUID(),
    children: tabs.map((tab, i) => ({ ...(fav ? {} : { type: "tab" }), id: crypto.randomUUID(), url: urls[i], title: (tab.title || "").trim() || urls[i] })),
  };
  await holdingToday(async () => {
    if (!(await (fav ? insertPinSplit(item, target) : insertPinnedNode(item, target)))) return;
    if (!(await adoptTabs(item.children.map((p, i) => [p.id, tabs[i].id])))) return;
    const res = await assembleSplit(tabs.map((tab) => tab.id), fav ? { pinned: !!settings.pinOwnedTabs } : {}); // Today で既に分割なら何もしない
    if (fav && res === "adjacent") flash(t("splitOpenFailed"));
  });
  renderPinned();
  renderPins();
}

// Today 欄の分割行をピン留めタブの一覧・お気に入りに落としたとき (today.js の onDrop)
async function dropTodaySplitRow(target, rowEl) {
  const tabs = await Promise.all(rowTabIds(rowEl).map((id) => chrome.tabs.get(id).catch(() => null)));
  if (tabs.length === 2 && tabs.every(Boolean)) await pinSplitFromTabs(tabs, target);
}

// 分割項目 (ピン留めタブ・お気に入りとも) を Today 欄へ落としたとき (解除)。担当タブの無いペインは先に開き (1 枚でも開けなければ、開いた分を閉じて項目を残す)、
// 項目を消して担当を解放し、同じウィンドウの隣に寄せて分割にし、落とした位置へペアごと動かす (Chrome はペインを動かすと分割を解くので moveSplitTo が作り直す)
async function unpinSplitToToday(item, target) {
  await holdingToday(async () => {
    await refreshOpenTabs();
    const ids = [], made = [];
    for (const pane of item.children) {
      let tab = ownedTabOf(pane.id);
      if (!tab) {
        tab = await chrome.tabs.create({ url: pane.url, windowId: myWindowId, active: false }).catch(() => null);
        if (!tab) { made.forEach(closeTab); return; }
        made.push(tab.id);
      }
      ids.push(tab.id);
    }
    const fav = pins.some((p) => p.id === item.id);
    if (!(await (fav ? removePin(item.id) : removePinnedNode(item.id)))) { made.forEach(closeTab); return; }
    await assembleSplit(ids, { prefWindow: myWindowId });
    const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
    if (tabs.every(Boolean)) await moveSplitTo(tabs.sort((a, b) => a.index - b.index).map((tab) => tab.id), target);
  });
}

// ---------- 結合 ----------
// ピン留めの単独の行を、同じ階層の別の単独の行の真ん中に落としたとき: 2 つを 1 つの分割項目にする。落とした側が左。ペインは元のノードのまま (id 不変) なので、
// 担当には触らない。2 枚とも担当タブが開いていれば分割にして落とした側を表示し、片方でも無ければデータだけ変える (タブは増やさない)。
// 分割から引き出してきたペインなら、先に引き出しを確定する (dissolveSplit)
async function combinePinnedRows(target, movedEl) {
  const dragId = movedEl.dataset.nodeId;
  if (movedEl.dataset.pulledFrom && !(await dissolveSplit(movedEl.dataset.pulledFrom, dragId))) return;
  const a = findNode(pinnedTabs, dragId), b = findNode(pinnedTabs, target.id);
  if (!a || !b || a.node.type !== "tab" || b.node.type !== "tab" || a.siblings !== b.siblings) return;
  const item = { type: "split", id: crypto.randomUUID(), children: target.side === "left" ? [a.node, b.node] : [b.node, a.node] };
  const prev = cloneTree(pinnedTabs);
  b.siblings[b.siblings.indexOf(b.node)] = item;
  a.siblings.splice(a.siblings.indexOf(a.node), 1);
  if (!pinnedTabsFit(pinnedTabs)) { pinnedTabs = prev; return flash(t("pinStorageFull")); }
  if (!(await savePinnedTabs(prev))) return; // 失敗時は savePinnedTabs が元に戻して知らせる
  await refreshOpenTabs();
  const tabs = item.children.map((p) => ownedTabOf(p.id));
  if (tabs.every(Boolean)) {
    const res = await assembleSplit(tabs.map((tab) => tab.id));
    if (res === "adjacent") flash(t("splitOpenFailed"));
    await activateTab(tabs[item.children.indexOf(a.node)].id);
  }
  renderPinned();
}

// お気に入りの単独のタイルを別の単独のタイルの真ん中に落としたとき (reorder.js の combineGrid): 2 つを 1 つの分割項目 (1 マス) にする。落とした側が左。
// ペインは元のお気に入りの id のままなので担当には触らない。2 枚とも担当タブが開いていれば、固定を揃えて分割にし、落とした側を表示する (片方でも無ければデータだけ)。
// タイルから引き出してきたペインなら、先に引き出しを確定する (dissolvePinSplit)
async function combinePins(target, movedEl) {
  const dragId = movedEl.dataset.id;
  if (movedEl.dataset.pulledFrom && !(await dissolvePinSplit(movedEl.dataset.pulledFrom, dragId))) return;
  const a = pinById(dragId), b = pinById(target.id);
  if (!a || !b || isSplitItem(a) || isSplitItem(b)) return;
  const item = { type: "split", id: crypto.randomUUID(), children: (target.side === "left" ? [a, b] : [b, a]).map(toPinPane) };
  const prev = pins.slice();
  pins = pins.filter((p) => p !== a).map((p) => (p === b ? item : p));
  if (!pinsFit(pins)) { pins = prev; return flash(t("pinStorageFull")); }
  if (!(await persistPins(prev))) return;
  await refreshOpenTabs();
  const tabs = item.children.map((p) => ownedTabOf(p.id));
  if (tabs.every(Boolean)) {
    const res = await assembleSplit(tabs.map((tab) => tab.id), { pinned: !!settings.pinOwnedTabs });
    if (res === "adjacent") flash(t("splitOpenFailed"));
    await activateTab(tabs[item.children.findIndex((p) => p.id === dragId)].id);
  }
  renderPins();
}

// ---------- ピン留めタブ <-> お気に入りの移動 (分割項目ごと) ----------
// ペイン id を保つので、担当 (ownedTabs) には触らず (transferOwnedTab を使わない)、固定だけを付け外す。順序は「移動先に書く → 固定を揃える → 移動元を release なしで消す」。
// どの時点でもペイン id が allOwnerTargets に残るので、他のパネルの pruneOrphanOwners が孤児として外さない。保存に失敗したら何も変えない
async function movePinnedSplitToFavorite(itemId, target) {
  const node = findNode(pinnedTabs, itemId)?.node;
  if (!isSplitItem(node)) return;
  const item = { type: "split", id: crypto.randomUUID(), children: node.children.map(toPinPane) };
  const urls = new Set(flatPins().map((p) => p.url));
  if (item.children.some((p) => urls.has(p.url))) return flash(t("pinDuplicate"));
  if (pins.length >= settings.maxPins) return flash(t("pinLimitReachedSettings", settings.maxPins));
  await holdingToday(async () => {
    if (!(await insertPinSplit(item, target))) return;
    await refreshOpenTabs();
    await alignMovedSplit(item.children, !!settings.pinOwnedTabs);
    await removePinnedNode(node.id, { release: false });
  });
  renderPins(); renderPinned(); renderToday();
}
async function moveFavoriteSplitToPinned(pinId, target) {
  const item = pinById(pinId);
  if (!isSplitItem(item)) return;
  const node = { type: "split", id: crypto.randomUUID(), children: item.children.map(toNodePane) };
  const urls = treeUrls(pinnedTabs);
  if (node.children.some((p) => urls.has(p.url))) return flash(t("pinDuplicate"));
  await holdingToday(async () => {
    if (!(await insertPinnedNode(node, target))) return;
    await refreshOpenTabs();
    await alignMovedSplit(node.children, false);
    await removePin(item.id, { release: false });
  });
  renderPins(); renderPinned(); renderToday();
}
// 移った分割項目の 2 つのペインの固定を移動先に合わせる。2 枚とも開いていれば分割を保って (解く → 揃える → 組み直す)、片方だけなら固定だけ
async function alignMovedSplit(panes, chromePin) {
  const tabs = panes.map((p) => ownedTabOf(p.id));
  if (tabs.every(Boolean)) return assembleSplit(tabs.map((tab) => tab.id), { pinned: chromePin });
  return setPanePinned(panes.map((p, i) => [p.id, tabs[i]?.id]), chromePin);
}
