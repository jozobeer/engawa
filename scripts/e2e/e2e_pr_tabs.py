# GitHub の PR ごとの専用タブの E2E (使い捨てプロファイルのヘッドレス Chrome)
# 使い方: python3 scripts/e2e/e2e_pr_tabs.py <拡張のディレクトリ>
# storage.local の github に PR を直接書いて描画させる。タブは github.com の URL を開くが、読み込み完了は待たない
# (ネットワークが無くても通る)。
import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
oks = []
def check(name, cond, info=""):
    oks.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

A = "https://github.com/e2e-org/repo/pull/1"
B = "https://github.com/e2e-org/repo/pull/2"
C = "https://github.com/e2e-org/repo/pull/3"
pr = lambda url, n: {"url": url, "title": f"PR {n}", "repo": "e2e-org/repo", "number": n, "updatedAt": "2026-10-13T00:00:00Z", "ci": None}

c = Chrome(ext)
try:
    tid_sp, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    c.send("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    time.sleep(1.2)
    E = lambda expr: c.eval(sp, expr, timeout=60)
    win = E("chrome.windows.getCurrent().then(w => w.id)")
    owned = lambda: E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    def tabinfo(tid):
        if tid is None: return None
        return E(f"chrome.tabs.get({tid}).then(t => ({{ url: t.url || t.pendingUrl, pinned: t.pinned, active: t.active }})).catch(() => null)")
    ntabs = lambda: E("chrome.tabs.query({}).then(ts => ts.length)")
    setgh = lambda prs: E(f"Promise.all([chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({{ settings: {{ ...(r.settings || {{}}), showMine: true, showReviews: true, ghDedicatedTab: true }} }})), chrome.storage.local.set({{ githubToken: 'x', github: {{ mine: {json.dumps(prs)}, reviews: [], fetchedAt: Date.now() }} }})])")
    row = lambda url: f"[...document.querySelectorAll('.pr')].find(li => li.querySelector('.repo').textContent.endsWith(' #{url.rsplit('/', 1)[1]}'))"
    def mouse(typ, x, y, b=0, mod=0):
        c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": b, "clickCount": 1, "modifiers": mod}, session=sp)
    def center(expr):
        return E(f"(() => {{ const r = ({expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
    def point_on(expr):  # 要素の中心が実際にその要素の内側を指すまで待つ (取得エラーのバナーなどで行の位置がずれるため)
        x, y = center(expr)
        for _ in range(25):
            if E(f"{expr}.contains(document.elementFromPoint({x}, {y}))"): return x, y
            time.sleep(0.2)
            x, y = center(expr)
        return x, y
    def click_pr(url, mod=0):  # 実際のポインター操作で行をクリックする
        x, y = point_on(row(url))
        mouse("mouseMoved", x, y); mouse("mousePressed", x, y, 1, mod); mouse("mouseReleased", x, y, 0, mod)
        time.sleep(1.5)
    has_open = lambda url: E(f"{row(url)}.classList.contains('open-tab')")
    today_has = lambda tid: E(f"!!document.querySelector('#today-list .tab-row[data-tab-id=\"{tid}\"]')")
    def seq(n):  # number の行が描かれて見えるようになるまで待つ (設定の読み込み前はフォルダが隠れ、行の領域が無い)
        for _ in range(30):
            if E("document.querySelectorAll('.pr').length") == n and not E("document.querySelector('[data-folder=\"mine\"]').hidden"): return True
            time.sleep(0.2)
        return False

    base = ntabs()
    setgh([pr(A, 1), pr(B, 2)])
    check("two PR rows are rendered", seq(2))

    # --- A をクリック: タブが 1 枚開き、A の担当になる (固定タブにはしない) ---
    click_pr(A)
    o = owned(); ta = o.get("gh:" + A)
    check("clicking PR A opens one tab bound to A", ta is not None and ntabs() == base + 1, json.dumps(o))
    check("A's tab points at A", ta is not None and (tabinfo(ta) or {}).get("url", "").startswith(A), json.dumps(tabinfo(ta)))
    check("A's tab is not a Chrome pinned tab", (tabinfo(ta) or {}).get("pinned") is False)
    check("A's row is marked open, B's is not", has_open(A) and not has_open(B))
    check("A's tab stays out of Today", not today_has(ta))
    check("A's tab is not recorded in ownedPinned", E("chrome.storage.local.get('ownedPinned').then(r => !Object.keys(r.ownedPinned || {}).some(k => k.startsWith('gh:')))"))

    # --- B をクリック: 別のタブが開き、A のタブは残る ---
    click_pr(B)
    o = owned(); tb = o.get("gh:" + B)
    check("clicking PR B opens another tab", tb is not None and tb != ta and ntabs() == base + 2, json.dumps(o))
    check("A's tab is still there and still bound", tabinfo(ta) is not None and o.get("gh:" + A) == ta)
    check("B's tab is active", (tabinfo(tb) or {}).get("active") is True)

    # --- A を再クリック: A のタブに切り替わる。タブ ID は同じで、タブは増えない。読み込み直さない (URL はそのまま) ---
    url_before = (tabinfo(ta) or {}).get("url")
    click_pr(A)
    o = owned()
    check("re-clicking A switches to A's tab (same id, no new tab)", o.get("gh:" + A) == ta and ntabs() == base + 2 and (tabinfo(ta) or {}).get("active") is True, json.dumps(o))
    check("A's tab URL is untouched (no reload)", (tabinfo(ta) or {}).get("url") == url_before, f"{url_before} -> {(tabinfo(ta) or {}).get('url')}")

    # --- サブページを表示中の別タブからの切り替えは動かさない / 見ているときの再クリックは PR に戻す ---
    E(f"chrome.tabs.update({ta}, {{ url: '{A}/files' }})"); time.sleep(1.5)
    E(f"chrome.tabs.update({tb}, {{ active: true }})"); time.sleep(0.8)
    click_pr(A)
    check("switching from another tab keeps the PR subpage", (tabinfo(ta) or {}).get("url", "").rstrip("/").endswith("/pull/1/files"), json.dumps(tabinfo(ta)))
    click_pr(A)
    check("clicking again while viewing returns to the PR page", (tabinfo(ta) or {}).get("url", "").rstrip("/").endswith("/pull/1"), json.dumps(tabinfo(ta)))

    # --- ⌘ クリックは別の新しいタブ (担当は変わらない) ---
    n0 = ntabs()
    click_pr(A, mod=4)
    o = owned()
    check("meta-click opens a new unbound tab", ntabs() == n0 + 1 and o.get("gh:" + A) == ta and len(o) == 2, json.dumps(o))
    extra = E(f"chrome.tabs.query({{}}).then(ts => ts.filter(t => (t.url || t.pendingUrl || '').startsWith('{A}') && t.id !== {ta}).map(t => t.id))")
    for tid in extra: E(f"chrome.tabs.remove({tid})")
    time.sleep(0.8)

    # --- × は A のタブだけ閉じる。行は残る ---
    check("opened PR row has a close button", E(f"!!{row(A)}.querySelector('.pr-close')"))
    check("a PR without a tab has no close button", E("!document.querySelector('.pr:not(.open-tab) .pr-close')"))
    x, y = point_on(row(A)); mouse("mouseMoved", x, y); time.sleep(0.3)
    check("close button is visible on hover", E(f"getComputedStyle({row(A)}.querySelector('.pr-close')).visibility") == "visible")
    bx, by = point_on(f"{row(A)}.querySelector('.pr-close')")
    mouse("mouseMoved", bx, by); mouse("mousePressed", bx, by, 1); mouse("mouseReleased", bx, by, 0)
    time.sleep(1.5)
    check("× closes only A's tab", tabinfo(ta) is None and tabinfo(tb) is not None)
    check("A's row stays, no longer open; binding is gone", E(f"!!{row(A)}") and not has_open(A) and "gh:" + A not in owned(), json.dumps(owned()))

    # --- 一覧から消えた PR の担当は外れ、タブは閉じず Today に戻る ---
    click_pr(A)
    ta2 = owned().get("gh:" + A)
    check("A can be opened again after closing", ta2 is not None and ta2 != ta)
    setgh([pr(B, 2)]); time.sleep(2)
    o = owned()
    check("PR dropped from the list loses its binding", "gh:" + A not in o and o.get("gh:" + B) == tb, json.dumps(o))
    check("its tab stays open as an ordinary tab", tabinfo(ta2) is not None and (tabinfo(ta2) or {}).get("pinned") is False)
    check("the freed tab shows up in Today", today_has(ta2))
    check("urls record of the dropped PR is cleaned up", "gh:" + A not in E("chrome.storage.local.get('ownedUrls').then(r => r.ownedUrls || {})"))

    # --- URL が一致する既存タブは、クリックで採用される (新しいタブは開かない) ---
    setgh([pr(B, 2), pr(C, 3)]); time.sleep(1)
    tc = E(f"chrome.tabs.create({{ url: '{C}/files', active: false, windowId: {win} }}).then(t => t.id)"); time.sleep(1)
    n0 = ntabs()
    click_pr(C)
    check("an existing tab on the same PR is adopted", owned().get("gh:" + C) == tc and ntabs() == n0, json.dumps(owned()))

    # --- 旧 "github" 担当 (固定タブ) は孤児として外れ、固定も解ける ---
    legacy = E("chrome.tabs.create({ url: 'https://github.com/e2e-org/legacy', pinned: true, active: false }).then(t => t.id)"); time.sleep(1)
    E(f"chrome.storage.session.get('ownedTabs').then(r => chrome.storage.session.set({{ ownedTabs: {{ ...(r.ownedTabs || {{}}), github: {legacy} }} }}))")
    E("chrome.storage.local.get('ownedPinned').then(r => chrome.storage.local.set({ ownedPinned: { ...(r.ownedPinned || {}), github: true } }))")
    setgh([pr(B, 2), pr(C, 3)]); time.sleep(2)  # github の変更で孤児掃除が走る
    check("legacy 'github' binding is dropped", "github" not in owned(), json.dumps(owned()))
    check("legacy tab is unpinned and returns to Today", (tabinfo(legacy) or {}).get("pinned") is False and today_has(legacy), json.dumps(tabinfo(legacy)))

    # --- フォルダの表示設定: 「自分の PR」を隠すと担当が外れる ---
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...r.settings, showMine: false } }))"); time.sleep(0.5)
    E("pruneOrphanOwners()"); time.sleep(1)
    check("hiding the folder drops its PR bindings", not any(k.startswith("gh:") for k in owned()), json.dumps(owned()))
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...r.settings, showMine: true } }))"); time.sleep(0.5)

    # --- 設定オフ: 担当を持たず、従来どおり URL 一致のタブを探して開く / 行に × は無い ---
    click_pr(B)
    check("with the setting on, B is bound again", "gh:" + B in owned())
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...r.settings, ghDedicatedTab: false } }))"); time.sleep(0.8)
    E("pruneOrphanOwners()"); time.sleep(1)
    check("turning the setting off releases PR bindings and hides ×", not any(k.startswith("gh:") for k in owned()) and E("!document.querySelector('.pr .pr-close')"), json.dumps(owned()))

    # --- 更新で session が消えた後の旧 "github" 固定タブ: 一度きりの移行で、URL が一致する 1 枚だけ固定が外れる ---
    L1 = "https://github.com/e2e-org/legacy-pinned"
    mig = E(f"chrome.tabs.create({{ url: '{L1}', pinned: true, active: false }}).then(t => t.id)")
    mine_pin = E("chrome.tabs.create({ url: 'https://github.com/e2e-org/users-own', pinned: true, active: false }).then(t => t.id)"); time.sleep(1)
    E("chrome.storage.session.remove('ownedTabs')")
    E(f"chrome.storage.local.get(['ownedPinned', 'ownedUrls']).then(r => chrome.storage.local.set({{ ownedPinned: {{ ...(r.ownedPinned || {{}}), github: true }}, ownedUrls: {{ ...(r.ownedUrls || {{}}), github: '{L1}' }} }}))")
    setgh([pr(B, 2), pr(C, 3)]); time.sleep(3)  # github の変更で background の掃除 (と移行) が走る
    check("legacy pinned tab is unpinned by the one-time migration", (tabinfo(mig) or {}).get("pinned") is False, json.dumps(tabinfo(mig)))
    check("the user's own pinned tab is left alone", (tabinfo(mine_pin) or {}).get("pinned") is True, json.dumps(tabinfo(mine_pin)))
    check("migration removes ownedPinned.github and ownedUrls.github", E("chrome.storage.local.get(['ownedPinned', 'ownedUrls']).then(r => !('github' in (r.ownedPinned || {})) && !('github' in (r.ownedUrls || {})))"))

    # --- 中クリックの × はタブを閉じるだけで、同じ PR の新しいタブを増やさない ---
    setgh([pr(A, 1), pr(B, 2)]); seq(2)
    click_pr(A)
    ta3 = owned().get("gh:" + A)
    n0 = ntabs()
    x, y = point_on(row(A)); mouse("mouseMoved", x, y); time.sleep(0.3)
    bx, by = point_on(f"{row(A)}.querySelector('.pr-close')")
    c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": bx, "y": by, "button": "middle", "buttons": 4, "clickCount": 1}, session=sp)
    c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": bx, "y": by, "button": "middle", "buttons": 0, "clickCount": 1}, session=sp)
    time.sleep(1.5)
    check("middle-click on x closes the tab without opening another", tabinfo(ta3) is None and ntabs() == n0 - 1, f"{n0} -> {ntabs()}")

    # --- 長い文字でもパネルが横にスクロールしない。サイドパネルの最小幅に近い 320px で見る ---
    c.send("Emulation.setDeviceMetricsOverride", {"width": 320, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    sideways = lambda: E("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    LONG = "Very long pull request title that never ends " * 6
    WIDE_LOGIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLM"  # ハイフンの無い 39 文字 (ログインの最大長)。途中で折り返せない
    long_pr = {**pr(A, 1), "title": LONG, "repo": "e2e-org/" + "a-really-long-repository-name" * 3}
    long_rv = {**pr(B, 2), "title": LONG, "repo": "e2e-org/" + "x" * 80, "author": WIDE_LOGIN, "reviewDecision": "CHANGES_REQUESTED"}
    E(f"Promise.all([chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({{ settings: {{ ...r.settings, showMine: true, showReviews: true, ghDedicatedTab: true }} }})), chrome.storage.local.set({{ github: {{ mine: {json.dumps([long_pr])}, reviews: {json.dumps([long_rv])}, fetchedAt: Date.now() }} }})])")
    for _ in range(30):  # 件数は直前と同じ 2 行なので、長いタイトルが描かれるのを待つ
        if E(f"[...document.querySelectorAll('.pr .title')].filter(el => el.textContent === {json.dumps(LONG)}).length") == 2: break
        time.sleep(0.2)
    click_pr(A)  # 開いている行には × が出る
    sw = sideways()
    check("long PR titles and logins do not make the panel scroll sideways", sw[0] <= sw[1], f"scrollWidth={sw[0]} clientWidth={sw[1]}")
    # 行 (li) の外枠は広がらず、はみ出すのは中の列なので、行の中身の右端を行の右端と比べる
    over = E("[...document.querySelectorAll('.pr')].flatMap(li => [...li.querySelectorAll('.title, .meta > *')].filter(el => el.getBoundingClientRect().right > li.getBoundingClientRect().right + 0.5).map(el => el.className || el.textContent))")
    check("PR row contents stay inside the row", not over, json.dumps(over))
    check("a long PR title is cut with an ellipsis", E("[...document.querySelectorAll('.pr .title')].every(el => el.scrollWidth > el.clientWidth)"))
    gap = E(f"(() => {{ const li = {row(A)}, x = li.querySelector('.pr-close'); return x ? x.getBoundingClientRect().left - li.querySelector('.title').getBoundingClientRect().right : null; }})()")
    check("the hover x of an open PR does not cover the end of its title", gap is not None and gap >= -0.5, f"gap={gap}")

    # --- 区切れない長いホスト名を含むエラー (取得失敗の通知 / 設定画面の保存結果) ---
    HOST = "githubenterpriseserverforourinternalengineeringorganization.example.com"
    E(f"chrome.storage.local.get('github').then(r => chrome.storage.local.set({{ github: {{ ...r.github, error: {json.dumps('HTTP 502 from ' + HOST)} }} }}))")
    for _ in range(30):
        if E("!document.querySelector('#gh-error').hidden"): break
        time.sleep(0.2)
    sw = sideways()
    check("a fetch error with a long hostname does not scroll sideways", E("!document.querySelector('#gh-error').hidden") and sw[0] <= sw[1], f"scrollWidth={sw[0]} clientWidth={sw[1]}")
    E(f"showSettings(); document.querySelector('#settings-status').textContent = t('errNetwork', {json.dumps(HOST)})")
    sw = sideways()
    check("the settings status with a long hostname does not scroll sideways", sw[0] <= sw[1], f"scrollWidth={sw[0]} clientWidth={sw[1]}")
    E("showMain()")

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:300])
finally:
    c.close()
print(f"\n{sum(oks)}/{len(oks)} passed")
sys.exit(0 if all(oks) else 1)
