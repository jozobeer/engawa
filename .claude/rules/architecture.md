---
paths: ["*.js", "sidepanel.html", "sidepanel.css"]
---

# 設計の決まり

## 担当タブ (owned tabs)

お気に入り・ピン留めタブ・GitHub の PR は、それぞれ専用のタブ 1 枚 (担当タブ) を使い回す。クリックでタブを増やさないのが Arc 再現の核心。

- 対応表 `ownedTabs { ownerId: tabId }` は `chrome.storage.session` (タブ ID は再起動で変わる)。ownerId はお気に入りの `pin.id`、ピン留めタブの `node.id` (分割項目はペインごとのノード id。`split.id` は担当先ではない)、GitHub の PR は `gh:<PR の URL>` (PR ごとに 1 枚。旧 `"github"` 担当は廃止で、session に残っていれば孤児として外れ、更新で session が消えたあとは background.js の `migrateLegacyGhOwner()` が一度きりで固定を外す)
- `background.js` が各担当タブの最終 URL を `storage.local.ownedUrls` に記録し、再起動後は `reconcileOwnedTabs()` が最終 URL か登録 URL と一致するタブに結び直す (固定タブに限るのは、拡張が固定したはずのタブ = `pinOwnedTabs` オンのお気に入りだけ。ピン留めタブと PR は固定しないので通常タブも対象)。パネルが開かれる前に自動アーカイブが走る場合に備え、`background.js` の `reconcileOwnedTabsIfWiped()` も同じ規則を持つ (`ownedTabs` キーが無いときだけ)
- 自動で結び付けるのは URL が一致するタブだけ。同じサイトの別ページのタブを推測で奪わない (ユーザー自身の固定タブを壊した経緯あり)。単独の項目は、分割表示のペインを URL が一致しても奪わない (`openOwnedNow`。固定で分割が解ける)。分割項目は、自分の 2 URL とちょうど一致する生きた分割のペアだけ採用する (`liveSplitPairFor`)
- 担当タブを Chrome の固定タブにするのはお気に入りだけ (設定で変更可。ピン留めタブの一覧と PR は固定しない。`allOwnerTargets()` の `list: true` がその印)。固定解除は拡張が固定したタブ (`ownedPinned`) だけ
- メモリセーバーの破棄 (`tabs.onReplaced`) でタブ ID が変わる。担当の付け替えはパネル (`repointOwnedTab`) と `background.js` (`updateOwnedTabs`) の両方で行う (`session.ownedTabs` を背景が書く唯一の例外)。分割項目のペアの discard では 2 回続けて来るので、どちらも直列化し、毎回保存済みの最新値を読み直して旧 ID を持つ担当を全部付け替える (冪等)
- 担当タブを見ている最中の再クリックは登録 URL に戻す (Arc の挙動)。ダブルクリックの 2 回目は無視する
- PR の担当先は、storage.local の `github` の mine / reviews のうち、専用タブの設定・トークン・フォルダの表示設定で見えているもの (`ghPrTargets()`。background.js は `ghVisiblePrs()` で同じ規則)。一覧から消えた PR は `pruneOrphanOwners()` が外す (`github` の変更ごと)。タブは閉じず Today に戻る
- GitHub は同じ PR のサブページ (`/files` など) を表示中なら移動しない (`inPr`)
- 担当先の全一覧は `allOwnerTargets()` (ピン留めタブは `walkTabs` 経由で分割項目のペインを葉として返す)。担当先を増やすときはここに加える
- 分割項目 (`split-items.js` / `split-items-ui.js`): Chrome 側の組み立ては `assembleSplit` が唯一の入口 (冪等)。起動時には作らず、クリック (`openSplit`) と結合・Today への落とし込みのときだけ。ピン留めタブの分割は Chrome の固定タブにしない。お気に入りの分割は 1 マス (`pins` の `{type:"split", children:[ペイン, ペイン]}`。`flatPins()` / `sanitizedPins()` / `pinLeaf()`、background.js は `flatPinItems()`) で、設定「固定タブにする」に従い 2 枚とも固定する (`assembleSplit` の `pinned` 引数 + `setPanePinned`)。担当 id はペインごと。解放は `splitReleaseSnapshot` を保存の前に取る

## 描画

- 一覧の描き直しは差分方式 (要素を使い回し、並びの違う要素だけ動かす)。全部作り直すとアイコンが一瞬消え、編集モードの揺れがやり直しになってチカチカする
- 並べ替えは `reorder.js` の `setupLiveReorder` を使う。HTML5 DnD は使わない (描き直しで中断される、隙間に落とすと何も起きない)
- 入れ替え先は `offsetLeft/Top` (配置上の位置) で判定し、相手の中心寄り 7 割に入ったときだけ入れ替える (境目のばたつき防止)。まとめられる相手 (`combineTarget` が返す行。Today の分割と、ピン留めの単独行同士 = `pinnedCombineTarget`) は、真ん中の半分を分割の帯に空けるため、相手の奥側 1/4 まで進んだときに入れ替える (`swapReached`)。お気に入りの格子 (`combineGrid`) は帯が中央の正方形 (縦横とも ±1/4) で、入れ替えは縦か横のどちらかが奥側 1/4 に達したとき (`swapReachedGrid`)
- ドラッグ中の描き直しは `isDragging()` を見て保留し、`onEnd` で反映する。分割の作り直しのように複数の API 呼び出しにまたがる操作は `holdingToday()` で包み、途中の状態 (一瞬解けた分割など) を描かない。ピン留めの描画は `splitViewId` を見ないので保留しない
- Today 欄の行のキーは `"tab:<tabId>"` か `"split:<splitViewId>"`。分割行はペインごとに `data-tab-id` を持つので、行のタブは `rowTabIds(row)` で読む (行そのものの `dataset.tabId` は 1 枚の行だけ)。行の前後に入れるときは、分割行なら左のペインの前か右のペインの後ろ (ペインの間に入れると Chrome が分割を解く)。相方が担当タブで 1 枚の行に見えるペインを基準にしたときも、ペアの外側に入れる (`todayDropBoundary`)
- 「見えているタブ」の判定に `tab.active` だけを使わない。分割の非 active のペインは見えている。`highlighted` はペアの両方が true になるので使えない。分割は `splitViewId` (`inSplit()`) で見て、ペア単位で扱う
- `setPointerCapture` はドラッグが始まってから (`start()`) 呼ぶ。pointerdown で捕捉すると click イベントが項目ではなく親に飛び、行のクリック (タブ切り替えなど) が動かなくなる (実際に起きた)
- E2E でクリックを検証するときは `el.click()` ではなく `Input.dispatchMouseEvent` (mousePressed → mouseReleased) で実際のポインター操作を送る。`el.click()` は pointer イベントを経由しないので、上記のような不具合を見逃す
- `[hidden] { display: none !important }` が入っているので、表示切替は `el.hidden` で行う
- 長くなりうる文字 (タイトル、URL、ログイン、ホスト名) はパネルを横にスクロールさせない。グリッドの文字の列は `minmax(0, 1fr)` にするか、直下の要素に `overflow: hidden` / `min-width: 0` を付ける (`1fr` だけだと列の最小幅が中身の幅になる)。flex の子も `min-width: auto` のままでは縮まない。エラー文のように折り返す文は `overflow-wrap: anywhere` (break-word は最小幅を下げない)。確かめは `e2e_pr_tabs.py` の末尾と同じく 320px 幅で `scrollWidth <= clientWidth`
- ライト / ダークは `@media (prefers-color-scheme)` ではなく、`<html data-scheme="light|dark">` で切り替える (設定のテーマで OS と違う配色にできるため)。`appearance.js` を `<head>` で同期的に読み、前回の値 (localStorage の `appearance`) を最初の描画より前に付けてちらつきを防ぐ。テーマが「自動」のときは `matchMedia` で OS の切り替えに追従する。ダークの変数は `:root[data-scheme="dark"]`、それ以外のダーク用の規則は `:where(:root[data-scheme="dark"])` で包む (詳細度をライトの規則と同じに保ち、後に書いた方が勝つという元の重なり方を変えない)
- アクセント色の値は `--accent-<id>` (ライトとダークで別の値) にだけ書き、`:root[data-accent="<id>"]` で `--accent` に差す。既定 (indigo) は属性を付けない。色の一覧は `appearance.js` の `ACCENTS` で、設定画面の見本もそこから作る
- カラーテーマ (サイドバー全体の色味) は `<html data-tint="<id>">` で切り替える。既定 (neutral) は属性を付けない。面の変数 (`--bg` / `--bg-grad` / `--panel` / `--tile` / `--tile-hover` / `--fg` / `--muted` / `--border`) は `:root[data-tint="<id>"]` (ライト) と `:root[data-scheme="dark"][data-tint="<id>"]` (ダーク。詳細度を上げてダークではそちらだけ効かせる) に一式で書く。色の一覧は `appearance.js` の `TINTS`、設定画面の見本は `--chip-<id>` (ライト / ダークで別の値)。アクセント色 (強調) とは独立に効く
- 背景画像は固定の層 `#backdrop` (z-index -2) で、地色のグラデーション (body の背景) の上、ノイズの質感 (`body::before`、z-index -1) の下に敷く
- 見た目の方針はエンボス (レタープレス) 風。セクション見出しとお気に入りの短い名前は、文字を半透明にして下に明るい縁・上に暗い縁 (`text-shadow`) を付ける。色付きタイルの上ではタイルの色相の濃淡で彫る。新しい見出しを足すときも同じ作りにする

## 保存先

- `chrome.storage.sync`: `pins` (お気に入り)、`pinnedTabs` (ピン留めタブのツリー。フォルダの中にも置ける分割項目は `{type:"split", id, children:[tab, tab]}` で、`split.id` は担当先ではなく DOM のキーと並べ替えの単位)。1 項目 8 KB (`QUOTA_BYTES_PER_ITEM`) を超えると `set` が拒否される。書く前に `pinsFit` / `pinnedTabsFit` で確かめ、失敗時は元に戻して `pinStorageFull` を出す
- `chrome.storage.local`: `settings` (見た目の `theme` / `tint` / `accent` / `bg*` も含む)、`backgroundImage` (背景画像の data URL。数 MB になりうるので `settings` とは別のキー)、`icons` (URL → data URL)、`ownedUrls`、`ownedPinned`、`archive`、`folderCollapsed`
- `chrome.storage.session`: `ownedTabs`、`archiveGraceFrom`、`archiveSkip` (beforeunload で閉じられなかったタブの lastAccessed)
- 自動アーカイブはタブごとに並列に閉じて閉じた時点で記録し、応答は 5 秒で打ち切る。`tabs.remove` は beforeunload をキャンセルされると永久に解決しないため
- `storage.local.settings` は見た目の設定を変えるたびに書かれる。`settings` の `onChanged` で重い処理 (GitHub の取り直し、アラームの張り直し) や入力欄の同期をするときは、関係するキーの `oldValue` / `newValue` を比べる (background.js の `onlyAppearanceChanged`、自動アーカイブの `autoArchiveHours` と同じ形)
- 1 つのキーの書き手は 1 か所に寄せる (`ownedUrls` と `archive` は background だけ)。read-modify-write は直列化する

## アイコン

- Chrome の `_favicon` は未訪問サイトに既定の地球儀を返し、`<img>` は同じ URL を使い回すので更新されない。本物が取れたら data URL で保存し、未訪問は頭文字タイル
- 担当タブが開いている間はタブの現在の favicon を出す (未読バッジなどが見える)
- Arc のアイコンは `SidebarItemsFaviconCache/<md5(項目 ID)>` の PNG

## UI 文言

- すべて `_locales/*/messages.json`。JS からは `t(key, subs)`、単数複数は `tn(key, n)` (`key_one` / `key_other`)。HTML は `data-i18n*` 属性
- 呼び方は Arc に合わせる: グリッドは「お気に入り / Favorites」、一覧は「ピン留めタブ / Pinned tabs」、Today、アーカイブ
- ショートカット表記は `chrome.commands.getAll()` の実際の割り当てから作る (ハードコードしない)
- 新しいキーは en と ja の両方に入れ、`scripts/check-i18n.mjs` を通す
