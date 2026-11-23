# セクションをまたぐドラッグ&ドロップの E2E (使い捨てプロファイルのヘッドレス Chrome、ネットワーク不要)
#   Today 欄の行 → ピン留めタブ (行の前後 / フォルダの中 / 末尾)、Today 欄の行 → お気に入り (タイルの前後 / 末尾)、
#   ピン留めタブの行 / お気に入りのタイル → Today 欄 (解除、落とした位置に)、お気に入り ⇄ ピン留めタブ。
#   タブは増えず、そのタブがそのまま担当タブになる (担当タブの無いお気に入りを Today に落としたときだけタブを開く)。
#   ドラッグは編集モードでなくてもできる
# 使い方: python3 scripts/e2e/e2e_dnd.py <拡張のディレクトリ>
import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
oks = []
def check(name, cond, info=""):
    oks.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

c = Chrome(ext)
try:
    _, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    c.send("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    time.sleep(1.2)
    E = lambda expr: c.eval(sp, expr, timeout=60)
    E("window.__errs = []; addEventListener('error', e => __errs.push(String(e.message))); addEventListener('unhandledrejection', e => __errs.push(String(e.reason)))")
    win = E("chrome.windows.getCurrent().then(w => w.id)")
    mk = lambda url: E(f"chrome.tabs.create({{ url: '{url}', active: false, windowId: {win} }}).then(t => t.id)")
    tab_count = lambda: E(f"chrome.tabs.query({{ windowId: {win} }}).then(ts => ts.length)")
    today_rows = lambda: E("[...document.querySelectorAll('#today-list .tab-row')].map(r => Number(r.dataset.tabId))")
    owned = lambda: E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    tree = lambda: E("chrome.storage.sync.get('pinnedTabs').then(r => (r.pinnedTabs || []).map(n => n.type === 'folder' ? { f: n.title, c: (n.children || []).map(x => x.title) } : n.title))")
    node_by_url = lambda url: E("chrome.storage.sync.get('pinnedTabs').then(r => { const walk = (ns) => { for (const n of ns) { if (n.type === 'tab' && n.url === '%s') return n.id; if (n.type === 'folder') { const f = walk(n.children || []); if (f) return f; } } return null; }; return walk(r.pinnedTabs || []); })" % url)
    pins = lambda: E("chrome.storage.sync.get('pins').then(r => (r.pins || []).map(p => p.url))")
    pin_by_url = lambda url: E("chrome.storage.sync.get('pins').then(r => (r.pins || []).find(p => p.url === '%s')?.id || null)" % url)
    rect = lambda sel: E("(() => { const r = document.querySelector('%s').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()" % sel)
    prow = lambda nid: rect('.pinned-node[data-node-id="%s"]' % nid)
    trow = lambda tid: rect('#today-list .tab-row[data-tab-id="%d"]' % tid)
    tile = lambda pid: rect('.pin[data-id="%s"]' % pid)
    has_cls = lambda sel, cls: E("document.querySelector('%s')?.classList.contains('%s') === true" % (sel, cls))
    mouse = lambda typ, x, y, b=1: c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": b, "clickCount": 1}, session=sp)
    def drag_to(x1, y1, x2, y2, steps=14):
        mouse("mousePressed", x1, y1)
        for k in range(1, steps + 1):
            mouse("mouseMoved", x1 + (x2 - x1) * k / steps, y1 + (y2 - y1) * k / steps); time.sleep(0.03)
        time.sleep(0.25)
    def drop(x, y):
        mouse("mouseReleased", x, y, 0); time.sleep(1.2)
    key = lambda k, vk: [c.send("Input.dispatchKeyEvent", {"type": t, "key": k, "code": k, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}, session=sp) for t in ("keyDown", "keyUp")]

    # 準備: お気に入り 2 つ、ピン留めタブ [One, Docs{Spec}, Two]、Today にタブ 3 つ
    E("chrome.storage.sync.set(%s)" % json.dumps({
        "pins": [{"id": "fa", "url": "https://fav-a.invalid/", "title": "Fav A"}, {"id": "fb", "url": "https://fav-b.invalid/", "title": "Fav B"}],
        "pinnedTabs": [{"type": "tab", "id": "n-one", "url": "https://one.invalid/", "title": "One"},
                       {"type": "folder", "id": "n-docs", "title": "Docs", "children": [{"type": "tab", "id": "n-spec", "url": "https://spec.invalid/", "title": "Spec"}]},
                       {"type": "tab", "id": "n-two", "url": "https://two.invalid/", "title": "Two"}]}))
    t1 = mk("https://dnd-1.invalid/"); t2 = mk("https://dnd-2.invalid/"); t3 = mk("https://dnd-3.invalid/")
    time.sleep(2.5)
    check("setup: the three tabs are listed in Today", all(t in today_rows() for t in (t1, t2, t3)), json.dumps(today_rows()))
    n0 = tab_count()

    # --- Today → ピン留めタブ: 行の上半分に重ねると、その行の前に差し込む ---
    x1, y1, w1, h1 = trow(t1); x2, y2, w2, h2 = prow("n-two")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, x2 + w2 / 2, y2 + h2 * 0.25)
    check("hovering the upper half of a pinned row shows the insertion line above it", has_cls('.pinned-node[data-node-id="n-two"]', "drop-before"))
    drop(x2 + w2 / 2, y2 + h2 * 0.25)
    nid1 = node_by_url("https://dnd-1.invalid/")
    check("dropping a Today tab above a pinned row inserts it right before that row", tree()[-2:] == ["dnd-1.invalid", "Two"] or (nid1 and tree()[-1] == "Two" and len(tree()) == 4), json.dumps(tree(), ensure_ascii=False))
    check("the dragged tab becomes the new pinned tab's owned tab (no new tab is opened)", nid1 and owned().get(nid1) == t1 and tab_count() == n0, f"owned={owned()} tabs={tab_count()}/{n0}")
    check("...and it leaves Today", t1 not in today_rows(), json.dumps(today_rows()))

    # --- Today → ピン留めタブ: フォルダに重ねると、その中 (末尾) へ ---
    x1, y1, w1, h1 = trow(t2); fx, fy, fw, fh = prow("n-docs")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, fx + fw / 2, fy + fh / 2)
    check("hovering a folder row highlights it as the drop target", has_cls('.pinned-node[data-node-id="n-docs"]', "drop-into"))
    drop(fx + fw / 2, fy + fh / 2)
    docs = next((n for n in tree() if isinstance(n, dict) and n["f"] == "Docs"), {"c": []})
    nid2 = node_by_url("https://dnd-2.invalid/")
    check("dropping on a folder puts the tab inside, at the end", docs["c"][-1:] == ["dnd-2.invalid"] or (nid2 and len(docs["c"]) == 2), json.dumps(docs, ensure_ascii=False))
    check("the folder drop also binds the tab", nid2 and owned().get(nid2) == t2 and t2 not in today_rows(), f"owned={owned()}")

    # --- Today → ピン留めタブ: 行の無いところ (一覧の下端) なら末尾 ---
    x1, y1, w1, h1 = trow(t3); lx, ly, lw, lh = rect("#pinned-list")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, lx + lw / 2, ly + lh - 3)
    check("hovering below the rows marks the whole list as the drop target (append)", has_cls("#pinned-list", "drop-end"))
    drop(lx + lw / 2, ly + lh - 3)
    nid3 = node_by_url("https://dnd-3.invalid/")
    check("dropping below the rows appends at the top level", nid3 and tree()[-1] == "dnd-3.invalid", json.dumps(tree(), ensure_ascii=False))

    # --- Today → お気に入り: タイルの左半分に重ねると、そのタイルの前に ---
    t4 = mk("https://dnd-4.invalid/"); t5 = mk("https://dnd-5.invalid/"); time.sleep(2)
    x1, y1, w1, h1 = trow(t4); bx, by, bw, bh = tile("fb")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, bx + bw * 0.25, by + bh / 2)
    check("hovering the left half of a favorite tile shows the insertion mark before it", has_cls('.pin[data-id="fb"]', "drop-before"))
    drop(bx + bw * 0.25, by + bh / 2)
    pid4 = pin_by_url("https://dnd-4.invalid/")
    check("dropping a Today tab on a favorite tile inserts a favorite before it", pins() == ["https://fav-a.invalid/", "https://dnd-4.invalid/", "https://fav-b.invalid/"], json.dumps(pins()))
    check("the dragged tab becomes the favorite's owned tab (no new tab)", pid4 and owned().get(pid4) == t4 and t4 not in today_rows() and tab_count() == n0 + 2, f"owned={owned()} tabs={tab_count()}")

    # --- Today → お気に入り: タイルの無いところ (グリッドの右の余白) なら末尾 ---
    x1, y1, w1, h1 = trow(t5); gx, gy, gw, gh = rect("#pin-grid"); ax, ay, aw, ah = tile("fa")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, gx + gw - 8, ay + ah / 2)
    check("hovering the empty part of the grid marks the grid as the drop target (append)", has_cls("#pin-grid", "drop-end"))
    drop(gx + gw - 8, ay + ah / 2)
    check("dropping on the empty part appends a favorite at the end", pins()[-1:] == ["https://dnd-5.invalid/"], json.dumps(pins()))
    pid5 = pin_by_url("https://dnd-5.invalid/")

    # --- 取り消し: フォルダに重ねてから Esc → 何も変わらない ---
    t6 = mk("https://dnd-6.invalid/"); time.sleep(2)
    before_tree, before_rows = tree(), today_rows()
    x1, y1, w1, h1 = trow(t6); fx, fy, fw, fh = prow("n-docs")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, fx + fw / 2, fy + fh / 2)
    key("Escape", 27); time.sleep(0.5); mouse("mouseReleased", fx + fw / 2, fy + fh / 2, 0); time.sleep(0.5)
    check("Escape during the drag cancels: nothing moves", tree() == before_tree and t6 in today_rows() and not has_cls('.pinned-node[data-node-id="n-docs"]', "drop-into"), json.dumps(tree(), ensure_ascii=False))

    # --- 逆方向 (編集モードでなくてよい): ピン留めタブの行を Today 欄の行の上半分に落とすと、解除してその行の前に ---
    pinned_of = lambda tid: E(f"chrome.tabs.get({tid}).then(t => t.pinned)")
    active_tab = lambda: E(f"chrome.tabs.query({{ windowId: {win}, active: true }}).then(ts => ts[0]?.id)")
    x1, y1, w1, h1 = prow(nid1); rx, ry, rw, rh = trow(t6)
    drag_to(x1 + w1 / 2, y1 + h1 / 2, rx + rw / 2, ry + rh * 0.25)
    check("hovering the upper half of a Today row with a pinned row shows the insertion line above it (no edit mode)", has_cls(f'#today-list .tab-row[data-tab-id="{t6}"]', "drop-before"))
    n_before = tab_count()
    drop(rx + rw / 2, ry + rh * 0.25)
    rows = today_rows()
    check("dropping a pinned row on Today removes the pinned tab and the tab returns right before that row", node_by_url("https://dnd-1.invalid/") is None and t1 in rows and rows.index(t1) == rows.index(t6) - 1 and tab_count() == n_before, f"rows={rows}")

    # --- 逆方向: お気に入りのタイルを Today 欄の行の下半分に落とすと、解除してその行の後ろに (固定も外れる) ---
    x1, y1, w1, h1 = tile(pid4); rx, ry, rw, rh = trow(t6)
    drag_to(x1 + w1 / 2, y1 + h1 / 2, rx + rw / 2, ry + rh * 0.75)
    check("hovering the lower half of a Today row with a favorite tile shows the insertion line below it", has_cls(f'#today-list .tab-row[data-tab-id="{t6}"]', "drop-after"))
    drop(rx + rw / 2, ry + rh * 0.75)
    rows = today_rows()
    check("dropping a favorite tile on Today removes the favorite and the tab returns right after that row", pin_by_url("https://dnd-4.invalid/") is None and t4 in rows and rows.index(t4) == rows.index(t6) + 1 and tab_count() == n_before, f"pins={pins()} rows={rows}")
    check("...and the tab is no longer a Chrome pinned tab", pinned_of(t4) is False)

    # --- 通常モードの並べ替え: タイルをドラッグしても担当タブは開かない (クリック扱いにならない) ---
    act = active_tab()
    x1, y1, w1, h1 = tile("fa"); x2, y2, w2, h2 = tile(pid5)
    drag_to(x1 + w1 / 2, y1 + h1 / 2, x2 + w2 * 0.8, y2 + h2 / 2)
    drop(x2 + w2 * 0.8, y2 + h2 / 2)
    check("dragging a favorite tile in normal mode reorders it", pins() == ["https://fav-b.invalid/", "https://dnd-5.invalid/", "https://fav-a.invalid/"], json.dumps(pins()))
    check("...without opening its tab or switching tabs", tab_count() == n_before and active_tab() == act, f"tabs={tab_count()}/{n_before} active={active_tab()}/{act}")

    # --- 担当タブの無いお気に入りを Today 欄に落とすと、消えるのではなくそこにタブが開く ---
    before = today_rows(); x1, y1, w1, h1 = tile("fa"); rx, ry, rw, rh = trow(t6)
    drag_to(x1 + w1 / 2, y1 + h1 / 2, rx + rw / 2, ry + rh * 0.25)
    drop(rx + rw / 2, ry + rh * 0.25)
    rows = today_rows(); new = [r for r in rows if r not in before]
    check("dropping a favorite with no open tab on Today opens its tab at that position", pin_by_url("https://fav-a.invalid/") is None and len(new) == 1 and rows.index(new[0]) == rows.index(t6) - 1 and tab_count() == n_before + 1, f"rows={rows} before={before}")
    check("...in the background (the active tab does not change)", active_tab() == act, f"active={active_tab()}/{act}")
    n_before += 1

    # --- お気に入り → ピン留めタブ: タイルを行の上半分に落とすと、その行の前にピン留めタブとして移る (担当タブを引き継ぎ、固定は外す) ---
    x1, y1, w1, h1 = tile(pid5); x2, y2, w2, h2 = prow("n-one")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, x2 + w2 / 2, y2 + h2 * 0.25)
    check("hovering a pinned row with a favorite tile shows the insertion line", has_cls('.pinned-node[data-node-id="n-one"]', "drop-before"))
    drop(x2 + w2 / 2, y2 + h2 * 0.25)
    nid5 = node_by_url("https://dnd-5.invalid/")
    check("dropping a favorite on the pinned list moves it there (favorite removed, pinned tab inserted before the row)", pin_by_url("https://dnd-5.invalid/") is None and nid5 and tree()[:2] == ["dnd-5.invalid", "One"], f"pins={pins()} tree={json.dumps(tree(), ensure_ascii=False)}")
    check("the owned tab moves with it, is unpinned in Chrome, and no tab is opened or closed", nid5 and owned().get(nid5) == t5 and pinned_of(t5) is False and tab_count() == n_before and t5 not in today_rows(), f"owned={owned()} tabs={tab_count()}/{n_before}")

    # --- ピン留めタブ → お気に入り: 行をグリッドの余白に落とすと、末尾のお気に入りとして移る (担当タブを引き継ぎ、設定に従って固定) ---
    x1, y1, w1, h1 = prow(nid3); gx, gy, gw, gh = rect("#pin-grid"); bx, by, bw, bh = tile("fb")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, gx + gw - 8, by + bh / 2)
    check("hovering the empty part of the grid with a pinned row marks the grid as the drop target", has_cls("#pin-grid", "drop-end"))
    drop(gx + gw - 8, by + bh / 2)
    pid3 = pin_by_url("https://dnd-3.invalid/")
    check("dropping a pinned row on the grid moves it to favorites (pinned tab removed, favorite appended)", node_by_url("https://dnd-3.invalid/") is None and pid3 and pins()[-1] == "https://dnd-3.invalid/", f"pins={pins()} tree={json.dumps(tree(), ensure_ascii=False)}")
    check("the owned tab moves with it and becomes a Chrome pinned tab; no tab is opened or closed", pid3 and owned().get(pid3) == t3 and pinned_of(t3) is True and tab_count() == n_before and t3 not in today_rows(), f"owned={owned()} tabs={tab_count()}/{n_before}")

    # --- フォルダの行はお気に入りにできない (グリッドに重ねても目印が出ず、落としても何も起きない) ---
    pins_before = pins()
    x1, y1, w1, h1 = prow("n-docs")
    drag_to(x1 + w1 / 2, y1 + h1 / 2, gx + gw - 8, by + bh / 2)
    check("a folder row is not accepted by the favorites grid", not has_cls("#pin-grid", "drop-end"))
    key("Escape", 27); time.sleep(0.5); mouse("mouseReleased", gx + gw - 8, by + bh / 2, 0); time.sleep(0.5)
    check("...and nothing changes", pins() == pins_before and any(isinstance(n, dict) and n["f"] == "Docs" for n in tree()), f"pins={pins()}")

    # --- フォルダの中のタブを Today 欄へドラッグすると、フォルダから出すのではなく解除して Today に入る ---
    # (pinnedDropTarget の「フォルダから出す」判定がセクション外 (Today 欄) でも効いて取り違える回帰の検証。Docs の中の Spec は担当タブが無いので、落とすと Today にそのタブが開く)
    check("setup: the folder-internal tab (Spec) row is visible", E("(() => { const el = document.querySelector('.pinned-node[data-node-id=\"n-spec\"]'); return !!el && !!el.offsetParent; })()"))
    before = today_rows(); n_b = tab_count()
    x1, y1, w1, h1 = prow("n-spec"); rx, ry, rw, rh = trow(t6)
    drag_to(x1 + w1 / 2, y1 + h1 / 2, rx + rw / 2, ry + rh * 0.25)
    check("dragging a folder-internal tab over Today shows the Today insertion line, not a folder pop-out",
          has_cls(f'#today-list .tab-row[data-tab-id="{t6}"]', "drop-before") and not has_cls('.pinned-node[data-node-id="n-docs"]', "drop-before") and not has_cls('.pinned-node[data-node-id="n-docs"]', "drop-after"))
    drop(rx + rw / 2, ry + rh * 0.25)
    rows = today_rows(); new = [r for r in rows if r not in before]
    check("dropping a folder-internal tab on Today unpins it (opens a tab at that position), not popped out to the top level",
          node_by_url("https://spec.invalid/") is None and len(new) == 1 and rows.index(new[0]) == rows.index(t6) - 1 and tab_count() == n_b + 1,
          f"tree={json.dumps(tree(), ensure_ascii=False)} rows={rows}")

    check("no uncaught exceptions", E("window.__errs.length === 0"), json.dumps(E("window.__errs")))
finally:
    c.close()

print(f"\n{sum(oks)}/{len(oks)} passed")
sys.exit(0 if all(oks) else 1)
