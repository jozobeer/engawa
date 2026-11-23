# ピン留めタブの一覧 (フォルダ付き) の E2E (使い捨てプロファイルのヘッドレス Chrome、ネットワーク不要)
# 使い方: python3 scripts/e2e/e2e_pinned.py <拡張のディレクトリ>
import sys, time, json, os, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
oks = []
def check(name, cond, info=""):
    oks.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

c = Chrome(ext)
try:
    tid_sp, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    c.send("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    time.sleep(1.2)
    E = lambda expr: c.eval(sp, expr, timeout=60)
    win = E("chrome.windows.getCurrent().then(w => w.id)")
    rows = lambda: E("[...document.querySelectorAll('#pinned-list .pinned-node')].map(r => ({ id: r.dataset.nodeId, kind: r.classList.contains('folder-row') ? 'folder' : 'tab', title: r.querySelector('.tab-title').textContent, depth: (r.closest('.folder-children') ? 1 : 0) }))")

    check("favorites heading reads Favorites", E("document.querySelector('.pins h2').textContent") == "Favorites")
    check("empty pinned list shows its header, ＋/▤ and the hint", E("!document.querySelector('#pinned-empty').hidden && document.querySelector('#pinned-empty').offsetHeight > 0 && document.querySelector('#btn-pinned-add').offsetHeight > 0 && document.querySelector('#btn-pinned-folder').offsetHeight > 0"))
    check("no space UI remains", E("!document.querySelector('#space-bar') && !document.body.classList.contains('space-tinted')"))

    # --- ＋ で現在のタブをピン留め → 担当タブになり、Today から消える ---
    tab = E(f"chrome.tabs.create({{ url: 'https://example.com/work', active: true, windowId: {win} }}).then(t => t.id)")
    time.sleep(2.5)
    check("new tab appears in Today first", E(f"!!document.querySelector('#today-list .tab-row[data-tab-id=\"{tab}\"]')"))
    E("document.querySelector('#btn-pinned-add').click()"); time.sleep(1.2)
    r = rows()
    check("＋ pins the current tab", len(r) == 1 and r[0]["kind"] == "tab", json.dumps(r))
    check("hint hides once a tab is pinned", E("document.querySelector('#pinned-empty').hidden"))
    owned = E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    check("pinned tab is bound as the owned tab", owned.get(r[0]["id"]) == tab, json.dumps(owned))
    check("owned pinned tab leaves the Today list", E(f"!document.querySelector('#today-list .tab-row[data-tab-id=\"{tab}\"]')"))
    check("pinned tab is NOT Chrome-pinned", E(f"chrome.tabs.get({tab}).then(t => t.pinned)") is False)
    E("document.querySelector('#btn-pinned-add').click()"); time.sleep(0.8)
    check("pinning the same URL twice is refused", len(rows()) == 1 and "Already" in E("document.querySelector('#toast').textContent"))

    # --- × は編集モードだけ (通常モードではホバーしても出ず、押しても消えない) ---
    rx = E("(() => { const r = document.querySelector('#pinned-list .pinned-row .tab-close').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    c.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": rx[0], "y": rx[1]}, session=sp); time.sleep(0.3)
    check("× stays hidden on hover outside edit mode", E("getComputedStyle(document.querySelector('#pinned-list .pinned-row .tab-close')).visibility") == "hidden")
    E("document.querySelector('#pinned-list .pinned-row .tab-close').click()"); time.sleep(0.5)
    check("× does nothing outside edit mode", len(rows()) == 1)

    # --- 設定「お気に入りを固定タブにする」を切り替えても、ピン留めタブの担当タブは固定しない ---
    E("applyPinnedSetting(false).then(() => applyPinnedSetting(true))"); time.sleep(1.0)
    check("toggling the pin-owned setting leaves the pinned-list tab unpinned", E(f"chrome.tabs.get({tab}).then(t => t.pinned)") is False)
    check("the pinned-list node is not recorded in ownedPinned", E(f"chrome.storage.local.get('ownedPinned').then(r => !((r.ownedPinned || {{}})['{r[0]['id']}']))"))

    # --- 再起動相当: session を消してパネルを開き直すと、固定タブでないピン留めタブも結び直す ---
    E(f"chrome.tabs.update({tab}, {{ url: 'https://example.com/work/elsewhere' }})"); time.sleep(2.5)
    E("chrome.storage.session.remove('ownedTabs')")
    c.send("Target.closeTarget", {"targetId": tid_sp}); time.sleep(0.5)
    tid_sp, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    c.send("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    time.sleep(2)
    E = lambda expr: c.eval(sp, expr, timeout=60)
    owned = E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    check("after a session wipe, an unpinned pinned-list tab is rebound via its last URL", owned.get(r[0]["id"]) == tab and E(f"!document.querySelector('#today-list .tab-row[data-tab-id=\"{tab}\"]')"), json.dumps(owned))
    E(f"chrome.tabs.update({tab}, {{ url: 'https://example.com/work' }})"); time.sleep(2)

    # --- フォルダ: 作成、名前変更、中に追加、折りたたみ ---
    E("document.querySelector('#btn-pinned-folder').click()"); time.sleep(0.8)
    folder = next((x for x in rows() if x["kind"] == "folder"), None)
    check("a folder is created", folder is not None, json.dumps(rows()))
    E(f"renamePinnedNode('{folder['id']}', 'Docs')"); time.sleep(0.6)
    check("folder renamed", any(x["title"] == "Docs" for x in rows()))
    E(f"addPinnedTab('https://example.com/doc1', 'Doc 1', {{ parentId: '{folder['id']}' }})"); time.sleep(0.6)
    check("a tab inside a folder renders indented", any(x["title"] == "Doc 1" and x["depth"] == 1 for x in rows()), json.dumps(rows()))
    E(f"document.querySelector('.folder-row[data-node-id=\"{folder['id']}\"] .chev').click()"); time.sleep(0.5)
    check("collapsing hides the folder's children", E(f"document.querySelector('.folder-row[data-node-id=\"{folder['id']}\"] + .folder-children').hidden"))
    check("collapse state is stored per device", E("chrome.storage.local.get('folderCollapsed').then(r => Object.keys(r.folderCollapsed || {}).length)") == 1)
    E(f"document.querySelector('.folder-row[data-node-id=\"{folder['id']}\"] .chev').click()"); time.sleep(0.4)

    # --- 並べ替え (ドラッグ、同じ階層内) ---
    E("addPinnedTab('https://example.com/third', 'Third')"); time.sleep(0.6)
    E("setPinnedEditing(true)"); time.sleep(0.2)
    top = [x for x in rows() if x["depth"] == 0]
    first, last = top[0], top[-1]
    center = lambda nid: E(f"(() => {{ const r = document.querySelector('.pinned-node[data-node-id=\"{nid}\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
    mouse = lambda typ, x, y, b=1: c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": b, "clickCount": 1}, session=sp)
    # 単独の行を別の単独の行の真ん中に重ねると分割項目になる (split-items)。並べ替えは相手の奥側 1/4 まで進んだとき: 行の上端近くへ持っていく
    edge = lambda nid: (lambda c: [c[0], c[1] - E(f"document.querySelector('.pinned-node[data-node-id=\"{nid}\"]').getBoundingClientRect().height") * 0.4])(center(nid))
    (x1, y1), (x2, y2) = center(last["id"]), edge(first["id"])
    mouse("mousePressed", x1, y1)
    for k in range(1, 13):
        mouse("mouseMoved", x1, y1 + (y2 - y1) * k / 12); time.sleep(0.03)
    time.sleep(0.2); mouse("mouseReleased", x2, y2, 0); time.sleep(0.8)
    stored = E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs.map(n => n.id))")
    check("dragging reorders the top level and saves it", stored[0] == last["id"], f"stored={stored} moved={last['id']}")
    # フォルダ内の並べ替えも同じ階層内で保存される
    E(f"addPinnedTab('https://example.com/doc2', 'Doc 2', {{ parentId: '{folder['id']}' }})"); time.sleep(0.6)
    inner = [x for x in rows() if x["depth"] == 1]
    (ax, ay), (bx, by) = center(inner[1]["id"]), edge(inner[0]["id"])
    mouse("mousePressed", ax, ay)
    for k in range(1, 11):
        mouse("mouseMoved", ax, ay + (by - ay) * k / 10); time.sleep(0.03)
    time.sleep(0.2); mouse("mouseReleased", bx, by, 0); time.sleep(0.8)
    inner_stored = E(f"chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs.find(n => n.id === '{folder['id']}').children.map(n => n.title))")
    check("dragging inside a folder reorders only that folder", inner_stored == ["Doc 2", "Doc 1"] and len(E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs)")) == 3, json.dumps(inner_stored))
    # フォルダ行をドラッグすると、その子コンテナごと動く (子が別のフォルダの下に取り残されない)
    E("addPinnedTab('https://example.com/fourth', 'Fourth')"); time.sleep(0.6)
    fx, fy = center(folder["id"])
    last_top = [x for x in rows() if x["depth"] == 0][-1]
    lx, ly = center(last_top["id"])
    mouse("mousePressed", fx, fy)
    for k in range(1, 15):
        mouse("mouseMoved", fx, fy + (ly - fy) * k / 14); time.sleep(0.03)
    time.sleep(0.2)
    mid_dom = E("[...document.querySelector('#pinned-list').children].map(el => el.classList.contains('folder-children') ? 'KIDS' : el.dataset.nodeId)")
    fi = mid_dom.index(folder["id"])
    check("dragging a folder keeps its children container right after it", mid_dom[fi + 1] == "KIDS", json.dumps(mid_dom))
    mouse("mouseReleased", lx, ly, 0); time.sleep(0.8)
    saved = E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs.map(n => n.id))")
    check("folder drag is saved with the folder (and its children) at the new position", saved[-1] == folder["id"] and E(f"chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs.find(n => n.id === '{folder['id']}').children.length)") == 2, json.dumps(saved))

    # --- 編集モード (UI 操作): 一覧に .editing が付き、× が見えて押せば消える。ダブルクリックで名前変更 ---
    check("edit mode marks the list with .editing", E("document.querySelector('#pinned-list').classList.contains('editing')"))
    check("× is visible in edit mode", E("getComputedStyle(document.querySelector('#pinned-list .pinned-row .tab-close')).visibility") == "visible")
    E("addPinnedTab('https://example.com/temp', 'Temp')"); time.sleep(0.6)
    temp = next(x for x in rows() if x["title"] == "Temp")
    cx, cy = E(f"(() => {{ const r = document.querySelector('.pinned-node[data-node-id=\"{temp['id']}\"] .tab-close').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
    mouse("mousePressed", cx, cy); mouse("mouseReleased", cx, cy, 0); time.sleep(0.8)
    check("clicking × in edit mode removes the row and saves", all(x["title"] != "Temp" for x in rows()) and E("chrome.storage.sync.get('pinnedTabs').then(r => JSON.stringify(r.pinnedTabs).includes('/temp'))") is False, json.dumps(rows()))
    E("window.__promptCalled = false; window.prompt = () => { window.__promptCalled = true; return 'X'; }")  # ダイアログは出さない (呼ばれたら失敗)
    dbl = lambda x, y: [c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": 1 if typ == "mousePressed" else 0, "clickCount": n}, session=sp) for typ, n in (("mousePressed", 1), ("mouseReleased", 1), ("mousePressed", 2), ("mouseReleased", 2))]
    fourth = next(x for x in rows() if x["title"] == "Fourth")
    fx2, fy2 = center(fourth["id"]); dbl(fx2, fy2); time.sleep(0.5)
    check("double-clicking a row turns its title into an inline input (no dialog)", E("!!document.querySelector('.pinned-node[data-node-id=\"%s\"] input.rename-input') && document.activeElement?.classList.contains('rename-input') && !window.__promptCalled" % fourth["id"]))
    check("the row being renamed stops wiggling (edit mode)", E("getComputedStyle(document.querySelector('.pinned-node[data-node-id=\"%s\"]')).animationName === 'none'" % fourth["id"]))
    key = lambda k, vk: [c.send("Input.dispatchKeyEvent", {"type": t, "key": k, "code": k, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}, session=sp) for t in ("keyDown", "keyUp")]  # 実キー (合成イベントではない)
    E("(() => { const i = document.querySelector('input.rename-input'); if (!i) return; i.value = 'Fourth renamed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); })()"); time.sleep(0.3)
    check("Enter that confirms an IME composition does not commit the rename", E("!!document.querySelector('input.rename-input')") and not any(x["title"] == "Fourth renamed" for x in rows()))
    if not E("!!document.querySelector('input.rename-input')"): dbl(fx2, fy2); time.sleep(0.5); E("(() => { const i = document.querySelector('input.rename-input'); if (i) i.value = 'Fourth renamed'; })()")
    key("Enter", 13); time.sleep(0.8)
    check("Enter commits the inline rename and saves it", any(x["title"] == "Fourth renamed" for x in rows()) and E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs.some(n => n.title === 'Fourth renamed'))") and E("!document.querySelector('input.rename-input')"), json.dumps(rows()))

    # --- フォルダをまたぐドラッグ (タブの行だけ。フォルダ行は同じ階層の並べ替えのまま) ---
    def drag_to(x1, y1, x2, y2, steps=12):
        mouse("mousePressed", x1, y1)
        for k in range(1, steps + 1):
            mouse("mouseMoved", x1 + (x2 - x1) * k / steps, y1 + (y2 - y1) * k / steps); time.sleep(0.03)
        time.sleep(0.25)
    tree = lambda: E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs.map(n => n.type === 'folder' ? { f: n.title, c: (n.children || []).map(x => x.type === 'folder' ? { f: x.title } : x.title) } : n.title))")
    folder_of = lambda t, name: next((n for n in t if isinstance(n, dict) and n["f"] == name), None)
    has_cls = lambda nid, cls: E("document.querySelector('.pinned-node[data-node-id=\"%s\"]').classList.contains('%s')" % (nid, cls))
    ft = next(x["title"] for x in rows() if x["id"] == fourth["id"])  # 改名の成否に依存しない
    (x1, y1), (fx, fy) = center(fourth["id"]), center(folder["id"])
    drag_to(x1, y1, fx, fy)
    check("hovering a folder row while dragging a tab highlights it as the drop target", has_cls(folder["id"], "drop-into"))
    mouse("mouseReleased", fx, fy, 0); time.sleep(0.8)
    t = tree()
    check("dropping a tab on a folder moves it inside, at the end", (folder_of(t, "Docs") or {}).get("c", [])[-1:] == [ft] and ft not in t, json.dumps(t, ensure_ascii=False))
    d1 = next(x for x in rows() if x["title"] == "Doc 1")
    x1, y1 = center(d1["id"]); fx, fy = center(folder["id"])
    drag_to(x1, y1, fx, fy - 30)
    check("dragging a child above its folder marks the folder row as the insertion point", has_cls(folder["id"], "drop-before"))
    mouse("mouseReleased", fx, fy - 30, 0); time.sleep(0.8)
    t = tree(); di = next((i for i, n in enumerate(t) if isinstance(n, dict) and n["f"] == "Docs"), -1)
    check("releasing above the folder pulls the tab out right before the folder", di > 0 and t[di - 1] == "Doc 1" and "Doc 1" not in t[di]["c"], json.dumps(t, ensure_ascii=False))
    d2 = next(x for x in rows() if x["title"] == "Doc 2")
    x1, y1 = center(d2["id"])
    kb = E("document.querySelector('.folder-row[data-node-id=\"%s\"] + .folder-children').getBoundingClientRect().bottom" % folder["id"])
    drag_to(x1, y1, x1, kb + 20)
    mouse("mouseReleased", x1, kb + 20, 0); time.sleep(0.8)
    t = tree(); di = next((i for i, n in enumerate(t) if isinstance(n, dict) and n["f"] == "Docs"), -1)
    check("releasing below the folder's children pulls the tab out right after the folder", di >= 0 and di + 1 < len(t) and t[di + 1] == "Doc 2" and "Doc 2" not in t[di]["c"], json.dumps(t, ensure_ascii=False))
    E("addPinnedFolder('Other')"); time.sleep(0.6)
    other = next(x for x in rows() if x["title"] == "Other")
    (x1, y1), (ox, oy) = center(fourth["id"]), center(other["id"])
    drag_to(x1, y1, ox, oy)
    mouse("mouseReleased", ox, oy, 0); time.sleep(0.8)
    t = tree()
    check("dropping a child on another folder moves it there", (folder_of(t, "Other") or {}).get("c") == [ft] and ft not in (folder_of(t, "Docs") or {}).get("c", []), json.dumps(t, ensure_ascii=False))
    (x1, y1), (fx, fy) = center(other["id"]), center(folder["id"])
    drag_to(x1, y1, fx, fy)
    hl = has_cls(folder["id"], "drop-into")
    mouse("mouseReleased", fx, fy, 0); time.sleep(0.8)
    t = tree()
    check("a folder row is never dropped into another folder (same-level reorder only)", not hl and folder_of(t, "Docs") is not None and folder_of(t, "Other") is not None and not any(isinstance(cc, dict) for n in t if isinstance(n, dict) for cc in n["c"]), json.dumps(t, ensure_ascii=False))
    E("setPinnedEditing(false)"); time.sleep(0.2)

    # --- 編集モードでなくてもダブルクリックでその場で名前変更。Esc で取り消し ---
    d1 = next(x for x in rows() if x["title"] == "Doc 1")
    x1, y1 = center(d1["id"]); dbl(x1, y1); time.sleep(0.6)
    check("outside edit mode, double-click still opens the inline rename (no dialog)", E("!!document.querySelector('.pinned-node[data-node-id=\"%s\"] input.rename-input') && !window.__promptCalled" % d1["id"]))
    E("(() => { const i = document.querySelector('input.rename-input'); if (!i) return; i.value = 'nope'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()"); time.sleep(0.5)
    check("Escape cancels the inline rename and keeps the old title", any(x["title"] == "Doc 1" for x in rows()) and E("!document.querySelector('input.rename-input')") and E("!document.querySelector('#pinned-list').classList.contains('editing')"))
    # パネルの外へフォーカスが出ても (1 回目のクリックで切り替えたタブに Chrome がフォーカスを移すなど) 入力欄は消えず、パネルが
    # フォーカスを取り戻したら入力欄に戻る。パネル内の別の場所へ移ったときだけ確定。ヘッドレスは CDP で入力を送った後にタブを
    # 切り替えても document.hasFocus() が true のままなので、hasFocus を false にして blur を起こす
    d1 = next(x for x in rows() if x["title"] == "Doc 1")
    E("startPinnedRename(document.querySelector('.pinned-node[data-node-id=\"%s\"]'))" % d1["id"]); time.sleep(0.3)
    E("(() => { const i = document.querySelector('input.rename-input'); const orig = document.hasFocus; document.hasFocus = () => false; i.blur(); setTimeout(() => { document.hasFocus = orig; }, 150); })()"); time.sleep(0.4)
    check("a blur caused by the panel losing focus keeps the inline rename open", E("!!document.querySelector('input.rename-input')"))
    E("window.dispatchEvent(new Event('focus'))"); time.sleep(0.2)
    check("when the panel gets focus back, the input is focused again", E("document.activeElement?.classList.contains('rename-input')"))
    E("(() => { const i = document.querySelector('input.rename-input'); if (i) i.value = 'Doc 1 (blurred)'; })()")
    E("(() => { const orig = document.hasFocus; document.hasFocus = () => true; document.querySelector('#btn-pinned-add').focus(); setTimeout(() => { document.hasFocus = orig; }, 150); })()"); time.sleep(0.5)  # パネル内の別の場所へ (hasFocus は true)
    check("moving focus elsewhere in the panel commits the rename", any(x["title"] == "Doc 1 (blurred)" for x in rows()) and E("!document.querySelector('input.rename-input')"), json.dumps([x["title"] for x in rows()]))
    E("renamePinnedNode('%s', 'Doc 1')" % d1["id"]); time.sleep(0.5)
    # 通常モードでフォルダ行をダブルクリック: 入力欄が出て、開閉状態は変わらない (1 回目のクリックの開閉を戻す)
    kids_hidden = lambda nid: E("document.querySelector('.pinned-node[data-node-id=\"%s\"]').nextElementSibling.hidden" % nid)
    before = kids_hidden(other["id"])
    ox, oy = center(other["id"]); dbl(ox, oy); time.sleep(0.6)
    check("double-clicking a folder row outside edit mode opens the inline rename", E("!!document.querySelector('.pinned-node[data-node-id=\"%s\"] input.rename-input')" % other["id"]))
    check("...and leaves the folder's open/closed state as it was", kids_hidden(other["id"]) == before, f"before={before} after={kids_hidden(other['id'])}")
    key("Escape", 27); time.sleep(0.5)
    check("Escape on the folder rename keeps its name and state", any(x["title"] == "Other" for x in rows()) and kids_hidden(other["id"]) == before and E("!document.querySelector('input.rename-input')"))
    E("chrome.tabs.getCurrent().then(t => chrome.tabs.update(t.id, { active: true }))"); time.sleep(0.3)  # 1 回目のクリックで開いたタブからパネルへ戻す

    # --- ピン留めタブをクリックすると担当タブへ (タブは増えない)。削除で担当を解放 ---
    E(f"chrome.tabs.create({{ url: 'about:blank', active: true, windowId: {win} }})"); time.sleep(0.5)
    n_before = E("chrome.tabs.query({}).then(ts => ts.length)")
    work = next(x for x in rows() if x["kind"] == "tab" and x["depth"] == 0 and x["title"] != "Third")
    wx, wy = center(work["id"])  # 実際のマウス操作でクリック
    mouse("mousePressed", wx, wy); mouse("mouseReleased", wx, wy, 0); time.sleep(1.2)
    check("clicking a pinned tab switches to its owned tab without opening a new one", E("chrome.tabs.query({}).then(ts => ts.length)") == n_before and E(f"chrome.tabs.get({tab}).then(t => t.active)"))
    E(f"removePinnedNode('{work['id']}')")
    for _ in range(30):  # 担当の解放と Today 欄の描き直しは非同期なので最大 3 秒待つ
        time.sleep(0.1)
        if E(f"!!document.querySelector('#today-list .tab-row[data-tab-id=\"{tab}\"]')"): break
    owned = E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    today_has = E(f"!!document.querySelector('#today-list .tab-row[data-tab-id=\"{tab}\"]')")
    check("removing a pinned tab releases its binding and it returns to Today", work["id"] not in owned and today_has,
          f"owned={owned} today_has={today_has} alive={E(f'chrome.tabs.get({tab}).then(t => [t.windowId, t.active, t.url]).catch(() => null)')} win={win} rows={E('[...document.querySelectorAll(\'#today-list .tab-row\')].map(r => r.dataset.tabId)')}")

    # --- Arc インポート: お気に入りはグリッドへ、複数スペースはスペース名のフォルダにまとめて一覧へ ---
    arc = {"sidebar": {"containers": [{"global": {}}, {
        "topAppsContainerIDs": [{"default": True}, "TOP"],
        "spaces": ["SA", {"id": "SA", "title": "Work", "containerIDs": ["pinned", "PA", "unpinned", "UA"]},
                   "SB", {"id": "SB", "containerIDs": ["pinned", "PB", "unpinned", "UB"]}],
        "items": [
            "TOP", {"id": "TOP", "parentID": None, "data": {"itemContainer": {"containerType": {"topApps": {}}}}, "childrenIds": ["F1"]},
            "F1", {"id": "F1", "parentID": "TOP", "data": {"tab": {"savedURL": "https://fav.example/", "savedTitle": "Fav"}}},
            "PA", {"id": "PA", "parentID": None, "data": {"itemContainer": {"containerType": {"spaceItems": {}}}}, "childrenIds": ["LA", "TA2", "TA3"]},
            "LA", {"id": "LA", "parentID": "PA", "title": "Specs", "data": {"list": {}}, "childrenIds": ["TA1"]},
            "TA1", {"id": "TA1", "parentID": "LA", "data": {"tab": {"savedURL": "https://a.example/spec", "savedTitle": "Spec"}}},
            "TA2", {"id": "TA2", "parentID": "PA", "data": {"tab": {"savedURL": "https://a.example/board", "savedTitle": "Board"}}},
            "TA3", {"id": "TA3", "parentID": "PA", "data": {"tab": {"savedURL": "https://example.com/third", "savedTitle": "Third (dup)"}}},
            "PB", {"id": "PB", "parentID": None, "data": {"itemContainer": {"containerType": {"spaceItems": {}}}}, "childrenIds": ["TB1"]},
            "TB1", {"id": "TB1", "parentID": "PB", "data": {"tab": {"savedURL": "https://b.example/", "savedTitle": "B"}}},
        ]}]}}
    E("showSettings()"); time.sleep(0.3)
    E(f"""(async () => {{
        const sb = new File([Uint8Array.from(atob({json.dumps(base64.b64encode(json.dumps(arc).encode()).decode())}), ch => ch.charCodeAt(0))], 'StorableSidebar.json');
        const dt = new DataTransfer(); dt.items.add(sb);
        const input = document.querySelector('#in-arc-file'); input.files = dt.files; input.dispatchEvent(new Event('change'));
    }})()"""); time.sleep(1.2)
    targets = E("[...document.querySelectorAll('#import-groups .import-target')].map(x => x.textContent)")
    check("preview shows targets: favorites, and pinned tabs in a folder per Arc space", len(targets) == 3 and "Favorites" in targets[0] and "Work" in targets[1] and "Space 2" in targets[2], json.dumps(targets))
    check("items already in the pinned list are marked", E("[...document.querySelectorAll('#import-groups .import-item.disabled .name')].map(x => x.textContent)") == ["Third (dup)"])
    E("document.querySelector('#btn-import').click()"); time.sleep(1.5)
    check("import status counts favorites + pinned tabs", "4" in E("document.querySelector('#import-status').textContent"), E("document.querySelector('#import-status').textContent"))
    all_sync = E("chrome.storage.sync.get(null)")
    check("no space keys are written", not any(k == "spaces" or k.startswith("spacePins:") for k in all_sync))
    top_titles = [n.get("title") for n in all_sync["pinnedTabs"]]
    work_folder = next((n for n in all_sync["pinnedTabs"] if n["type"] == "folder" and n["title"] == "Work"), None)
    check("each Arc space became a top-level folder named after it", "Work" in top_titles and "Space 2" in top_titles, json.dumps(top_titles))
    check("folder structure inside the Arc space is preserved", work_folder and any(ch["type"] == "folder" and ch["title"] == "Specs" and ch["children"][0]["url"] == "https://a.example/spec" for ch in work_folder["children"]), json.dumps(work_folder)[:200])
    check("favorites group went to the grid", any(p["url"] == "https://fav.example/" for p in all_sync["pins"]))
    E("showMain()"); time.sleep(0.4)
    check("pinned list shows the imported folders", any(x["title"] == "Work" and x["kind"] == "folder" for x in rows()), json.dumps(rows()))

    # --- 単一スペースの Arc ファイルは、フォルダに包まず平らに入る ---
    arc1 = {"sidebar": {"containers": [{"global": {}}, {
        "spaces": ["S1", {"id": "S1", "title": "Solo", "containerIDs": ["pinned", "P1", "unpinned", "U1"]}],
        "items": ["P1", {"id": "P1", "parentID": None, "data": {"itemContainer": {"containerType": {"spaceItems": {}}}}, "childrenIds": ["T1"]},
                  "T1", {"id": "T1", "parentID": "P1", "data": {"tab": {"savedURL": "https://solo.example/", "savedTitle": "Solo tab"}}}]}]}}
    E("showSettings()"); time.sleep(0.3)
    E(f"""(async () => {{
        const sb = new File([Uint8Array.from(atob({json.dumps(base64.b64encode(json.dumps(arc1).encode()).decode())}), ch => ch.charCodeAt(0))], 'StorableSidebar.json');
        const dt = new DataTransfer(); dt.items.add(sb);
        const input = document.querySelector('#in-arc-file'); input.files = dt.files; input.dispatchEvent(new Event('change'));
    }})()"""); time.sleep(1.2)
    check("single Arc space targets the pinned list directly", E("document.querySelector('#import-groups .import-target').textContent") == "→ Pinned tabs")
    E("document.querySelector('#btn-import').click()"); time.sleep(1.2)
    check("single Arc space imports flat (no wrapper folder)", any(n["type"] == "tab" and n["url"] == "https://solo.example/" for n in E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs)")))
    E("showMain()"); time.sleep(0.3)

    # --- 旧データ (spaces) からの移行 ---
    E("""chrome.storage.sync.remove('pinnedTabs').then(() => chrome.storage.sync.set({
        spaces: [{ id: 'a', name: 'Alpha', hue: 0 }, { id: 'b', name: null, hue: null }],
        'spacePins:a': [{ type: 'tab', id: 'ta', url: 'https://alpha.example/', title: 'A' }],
        'spacePins:b': [{ type: 'tab', id: 'tb', url: 'https://beta.example/', title: 'B' }] }))""")
    time.sleep(0.5)
    E("loadPinnedTabs().then(() => renderPinned())"); time.sleep(0.8)
    migrated = E("chrome.storage.sync.get(null)")
    check("old spaces data migrates into folders named after the spaces and old keys are removed",
          [n["title"] for n in migrated.get("pinnedTabs", [])] == ["Alpha", "Space 2"] and "spaces" not in migrated and not any(k.startswith("spacePins:") for k in migrated), json.dumps([n.get("title") for n in migrated.get("pinnedTabs", [])]))

    # --- 旧データが 8 KB に収まらなくても init が止まらず、一覧は使える (旧キーは残る) ---
    big = lambda pfx: [{"type": "tab", "id": f"{pfx}{i}", "url": f"https://{pfx}.example/{i}", "title": "x" * 150} for i in range(30)]
    E("chrome.storage.sync.remove('pinnedTabs').then(() => chrome.storage.sync.set({ spaces: [{ id: 'a', name: 'Alpha', hue: 0 }, { id: 'b', name: 'Beta', hue: 0 }], 'spacePins:a': %s, 'spacePins:b': %s }))" % (json.dumps(big("a")), json.dumps(big("b"))))
    time.sleep(0.5)
    c.send("Target.closeTarget", {"targetId": tid_sp}); time.sleep(0.5)
    tid_sp, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html"); time.sleep(2)
    E = lambda expr: c.eval(sp, expr, timeout=60)
    folders_shown = E("[...document.querySelectorAll('#pinned-list > .folder-row .tab-title')].map(x => x.textContent)")
    check("oversized legacy data: panel still initializes and shows the folders", folders_shown == ["Alpha", "Beta"], json.dumps(folders_shown))
    check("oversized legacy data: old keys are kept until the list fits", E("chrome.storage.sync.get('spaces').then(r => Array.isArray(r.spaces))"))
    check("oversized legacy data: the user is told", "full" in E("document.querySelector('#toast').textContent").lower() or E("!document.querySelector('#toast').hidden"))

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:500])
finally:
    c.close()
print(f"\n{sum(oks)}/{len(oks)} passed")
