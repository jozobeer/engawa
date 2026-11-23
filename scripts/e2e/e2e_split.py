# Today 欄の分割表示 (Chrome の split view) の E2E (使い捨てプロファイルのヘッドレス Chrome、ネットワーク不要)
#   分割のペアは 1 行 (左端につまみ、ペインごとに ×)。ペインのクリックでそのタブへ、× でそのタブだけ閉じる。
#   行を別の行の真ん中に落とすと分割 (落とした側が左 / 右)、ペインをドラッグするとその 1 枚だけが分割から出る (末尾へ / 別の行と組む)、
#   つまみでペアごと移動 (分割は保つ)。片付けと自動アーカイブはペア単位 (表示中の分割の片方を閉じない)。
#   お気に入りの担当タブは分割のペインを奪わない。引き出したペインはピン留めタブにできる。分割行ごとピン留めタブに落とすと分割項目になる (e2e_split_items.py)。
#   相方が担当タブの分割 (Today では 1 枚の行) は、相方を見ていても強調し、隣に入れてもペインの間には入れない
# 使い方: python3 scripts/e2e/e2e_split.py <拡張のディレクトリ>   (Chrome 155 以降)
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
    # Today 欄の並び: 1 枚の行はタブ ID、分割行はペインのタブ ID のリスト (左から)
    today = lambda: E("[...document.querySelectorAll('#today-list > .tab-row')].map(r => r.classList.contains('split-row') ? [...r.querySelectorAll(':scope > .split-pane')].map(p => Number(p.dataset.tabId)) : Number(r.dataset.tabId))")
    strip = lambda: E(f"chrome.tabs.query({{ windowId: {win} }}).then(ts => ts.sort((a, b) => a.index - b.index).map(t => [t.id, t.splitViewId]))")
    order = lambda: [t for t, _ in strip()]
    split_of = lambda tid: dict((t, s) for t, s in strip()).get(tid)
    paired = lambda a, b: split_of(a) is not None and split_of(a) != -1 and split_of(a) == split_of(b) and abs(order().index(a) - order().index(b)) == 1
    active = lambda tid: E(f"chrome.tabs.get({tid}).then(t => t.active).catch(() => false)")
    def wait_for(fn, timeout=4.0):
        end = time.time() + timeout
        while time.time() < end:
            v = fn()
            if v: return v
            time.sleep(0.1)
        return fn()
    box = lambda expr: E("(() => { const r = (%s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()" % expr)
    pane = lambda tid: box("document.querySelector('.split-pane[data-tab-id=\"%d\"]')" % tid)
    grip = lambda tid: box("document.querySelector('.split-pane[data-tab-id=\"%d\"]').closest('.split-row').querySelector('.split-grip')" % tid)
    row = lambda tid: box("document.querySelector('#today-list > .tab-row[data-tab-id=\"%d\"]')" % tid)
    row_cls = lambda tid, cls: E("document.querySelector('#today-list > .tab-row[data-tab-id=\"%d\"]')?.classList.contains('%s') === true" % (tid, cls))
    mouse = lambda typ, x, y, b=1: c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": b, "clickCount": 1}, session=sp)
    def click(x, y):
        mouse("mouseMoved", x, y, 0); mouse("mousePressed", x, y); mouse("mouseReleased", x, y, 0); time.sleep(0.6)
    def move_to(x1, y1, x2, y2, steps=14):
        for k in range(1, steps + 1):
            mouse("mouseMoved", x1 + (x2 - x1) * k / steps, y1 + (y2 - y1) * k / steps); time.sleep(0.03)
        time.sleep(0.25)
    def grab(x, y):
        # 押して少し動かし、ドラッグを始める (5px 未満はクリック扱い)。始まった後の位置を返す
        c.send("Page.bringToFront", session=sp); time.sleep(0.3)  # ペインのクリックでサイドパネルのタブが裏に回ると、ヘッドレス Chrome は入力イベントに応答しなくなる
        mouse("mousePressed", x, y); mouse("mouseMoved", x, y + 4); mouse("mouseMoved", x, y + 8); time.sleep(0.2)
        return x, y + 8
    def drag_to(x1, y1, x2, y2):
        sx, sy = grab(x1, y1); move_to(sx, sy, x2, y2)
    def drop(x, y):
        mouse("mouseReleased", x, y, 0); time.sleep(1.5)
    key = lambda k, vk: [c.send("Input.dispatchKeyEvent", {"type": t, "key": k, "code": k, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}, session=sp) for t in ("keyDown", "keyUp")]

    check("setup: this Chrome has the split view API (Chrome 155+)", E("typeof chrome.tabs.createSplit === 'function' && typeof chrome.tabs.unsplit === 'function'"))
    t1, t2, t3, t4, t5 = (mk(f"https://split-{i}.invalid/") for i in range(1, 6))
    time.sleep(2)

    # --- 分割は 1 行にまとまる (外で作られた分割にも追従する) ---
    E(f"chrome.tabs.createSplit([{t1}, {t2}])")
    check("a split pair is shown as one row with its tabs as panes, left to right", wait_for(lambda: [t1, t2] in today()), json.dumps(today()))
    check("...and its tabs are not listed again as separate rows", t1 not in today() and t2 not in today())
    check("the split row starts with the grip (at the left end)", E("document.querySelector('.split-pane[data-tab-id=\"%d\"]').closest('.split-row').firstElementChild.classList.contains('split-grip')" % t1))

    # --- ペインのクリックでそのタブへ ---
    x, y, w, h = pane(t2)
    click(x + w * 0.35, y + h / 2)
    check("clicking a pane switches to that tab", wait_for(lambda: active(t2)))
    check("the row shows the split as visible and the clicked pane as focused", wait_for(lambda: E("(() => { const p = document.querySelector('.split-pane[data-tab-id=\"%d\"]'); return p.classList.contains('focused') && p.closest('.split-row').classList.contains('active'); })()" % t2)))

    # --- × はそのペインだけ閉じる ---
    x, y, w, h = pane(t1)
    mouse("mouseMoved", x + w / 2, y + h / 2, 0); time.sleep(0.2)
    check("hovering a pane shows its ×", E("getComputedStyle(document.querySelector('.split-pane[data-tab-id=\"%d\"] .tab-close')).visibility === 'visible'" % t1))
    cx, cy, cw, ch = box("document.querySelector('.split-pane[data-tab-id=\"%d\"] .tab-close')" % t1)
    click(cx + cw / 2, cy + ch / 2)
    check("× on a pane closes just that tab", wait_for(lambda: t1 not in order()), json.dumps(order()))
    check("...and the other pane goes back to a normal row", wait_for(lambda: t2 in today()) and split_of(t2) == -1, json.dumps(today()))

    # --- 行を別の行の真ん中 (右半分) に落とすと分割になる。落とした行が右 ---
    x1, y1, w1, h1 = row(t4); x2, y2, w2, h2 = row(t2)
    drag_to(x1 + w1 * 0.3, y1 + h1 / 2, x2 + w2 * 0.75, y2 + h2 / 2)
    check("hovering the middle of another row marks its right half as the split target", row_cls(t2, "drop-split-right"))
    drop(x2 + w2 * 0.75, y2 + h2 / 2)
    check("dropping on the right half makes a split with the dragged tab on the right", wait_for(lambda: [t2, t4] in today()), json.dumps(today()))
    check("...in Chrome too (adjacent, same splitViewId)", paired(t2, t4) and order().index(t4) == order().index(t2) + 1, json.dumps(strip()))
    check("...and the new split is shown (the dragged tab is active)", wait_for(lambda: active(t4)))

    # --- 左半分に落とすと、落とした行が左 ---
    x1, y1, w1, h1 = row(t5); x2, y2, w2, h2 = row(t3)
    drag_to(x1 + w1 * 0.3, y1 + h1 / 2, x2 + w2 * 0.25, y2 + h2 / 2)
    check("hovering the left half marks it as the split target", row_cls(t3, "drop-split-left"))
    drop(x2 + w2 * 0.25, y2 + h2 / 2)
    check("dropping on the left half puts the dragged tab on the left", wait_for(lambda: [t5, t3] in today()) and paired(t5, t3) and order().index(t5) + 1 == order().index(t3), json.dumps(today()))

    # --- ペインをドラッグすると、その 1 枚だけが分割から出る (ほかの行の位置へ) ---
    before = today()
    px, py, pw, ph = pane(t4)
    sx, sy = grab(px + pw * 0.4, py + ph / 2)
    check("pulling a pane leaves it faded in the split row", E("document.querySelector('.split-pane[data-tab-id=\"%d\"]').classList.contains('pulled')" % t4))
    check("...and lifts it out as a row of its own", E("document.querySelectorAll('#today-list > .tab-row[data-tab-id=\"%d\"]').length === 1" % t4))
    x2, y2, w2, h2 = pane(t3)  # 最後の行 ([t5, t3]) の真ん中 = その後ろへ
    move_to(sx, sy, x2, y2 + h2 / 2)
    drop(x2, y2 + h2 / 2)
    check("dropping the pulled pane elsewhere takes it out of the split", wait_for(lambda: split_of(t4) == -1 and split_of(t2) == -1), json.dumps(strip()))
    check("...and it lands where it was dropped (after the last row)", wait_for(lambda: today()[-1] == t4) and order()[-1] == t4, json.dumps(today()))
    check("...while the other split is untouched", paired(t5, t3) and [t5, t3] in today(), json.dumps(today()))
    check("the old partner becomes a normal row", t2 in today(), json.dumps(today()))

    # --- つまみでペアごと移動 (分割は保つ) ---
    gx, gy, gw, gh = grip(t5); x2, y2, w2, h2 = row(t2)
    drag_to(gx + gw / 2, gy + gh / 2, x2 + w2 / 2, y2 + h2 / 2)
    drop(x2 + w2 / 2, y2 + h2 / 2)
    check("dragging the grip moves the whole pair", wait_for(lambda: order().index(t3) + 1 == order().index(t2)) and order().index(t5) + 1 == order().index(t3), json.dumps(strip()))
    check("...and it stays a split (rebuilt after the move)", wait_for(lambda: paired(t5, t3)) and [t5, t3] in today(), json.dumps(strip()))

    # --- 1 枚の行は分割行をまたいで動かしても、ペインの間に入らない ---
    x1, y1, w1, h1 = row(t2); x2, y2, w2, h2 = pane(t5)
    drag_to(x1 + w1 / 2, y1 + h1 / 2, x2 + w2, y2 + h2 / 2)
    drop(x2 + w2, y2 + h2 / 2)
    check("a single row dragged over a split row lands before it, not between the panes", wait_for(lambda: order().index(t2) + 1 == order().index(t5)) and paired(t5, t3), json.dumps(strip()))

    # --- 引き出したペインを別の行の真ん中に落とすと、その行と組む ---
    px, py, pw, ph = pane(t3)
    sx, sy = grab(px + pw * 0.4, py + ph / 2)
    x2, y2, w2, h2 = row(t4)
    move_to(sx, sy, x2 + w2 * 0.25, y2 + h2 / 2)
    check("a pulled pane can be dropped on another row to split with it", row_cls(t4, "drop-split-left"))
    drop(x2 + w2 * 0.25, y2 + h2 / 2)
    check("...which makes the new pair and leaves the old partner alone", wait_for(lambda: [t3, t4] in today()) and paired(t3, t4) and split_of(t5) == -1 and t5 in today(), json.dumps(today()))

    # --- 引き出しを Esc で取り消すと元どおり ---
    before = today()
    px, py, pw, ph = pane(t4)
    sx, sy = grab(px + pw * 0.4, py + ph / 2)
    move_to(sx, sy, sx, sy + 60)
    key("Escape", 27); time.sleep(0.4)
    mouse("mouseReleased", sx, sy + 60, 0); time.sleep(1)
    check("Esc while pulling a pane puts everything back", today() == before and paired(t3, t4) and not E("!!document.querySelector('.split-pane.pulled')"), json.dumps(today()))

    # --- 分割行 (ペアごと) をピン留めタブへ落とすと分割項目になる (e2e_split_items.py)。ここでは Esc で取り消したら何も起きず、分割のまま残ることだけ確かめる ---
    gx, gy, gw, gh = grip(t3); sx2, sy2, sw2, sh2 = box("document.querySelector('#pinned-section')")
    drag_to(gx + gw / 2, gy + gh / 2, sx2 + sw2 / 2, sy2 + sh2 / 2)
    check("hovering a split row over the pinned section shows where it would go", E("!!document.querySelector('#pinned-section .drop-end, #pinned-list.drop-end')"))
    key("Escape", 27); time.sleep(0.4)
    mouse("mouseReleased", sx2 + sw2 / 2, sy2 + sh2 / 2, 0); time.sleep(1)
    check("Esc while dragging a split row over the pinned section pins nothing and it stays a split", E("chrome.storage.sync.get('pinnedTabs').then(r => (r.pinnedTabs || []).length === 0)") and paired(t3, t4), json.dumps(today()))

    # --- お気に入りの担当タブは分割のペインを奪わない ---
    E("chrome.storage.sync.set({ pins: [{ id: 'fz', url: 'https://split-4.invalid/', title: 'Split 4' }] })")
    wait_for(lambda: E("!!document.querySelector('.pin[data-id=\"fz\"]')"))
    fx, fy, fw, fh = box("document.querySelector('.pin[data-id=\"fz\"]')")
    click(fx + fw / 2, fy + fh / 2); time.sleep(1)
    owned_fz = E("chrome.storage.session.get('ownedTabs').then(r => (r.ownedTabs || {}).fz ?? null)")
    check("clicking a favorite whose URL is open in a split pane opens its own tab instead of taking the pane", owned_fz not in (None, t4) and paired(t3, t4), f"owned={owned_fz} strip={json.dumps(strip())}")
    E("chrome.storage.sync.set({ pins: [] })"); time.sleep(0.5)

    # --- 片付けはペア単位: 表示中の分割は残し、見えていない分割はペアごと ---
    t6 = mk("https://split-6.invalid/"); time.sleep(0.8)
    E(f"chrome.tabs.createSplit([{t2}, {t5}])")
    E(f"chrome.tabs.update({t3}, {{ active: true }})"); time.sleep(1)
    check("setup: one visible split and one hidden split", paired(t3, t4) and paired(t2, t5) and active(t3), json.dumps(strip()))
    wait_for(lambda: not E("document.querySelector('#btn-clear-today').disabled"))
    E("document.querySelector('#btn-clear-today').click()"); time.sleep(2.5)
    left = order()
    check("tidy up keeps both panes of the visible split", t3 in left and t4 in left and paired(t3, t4), json.dumps(strip()))
    check("tidy up archives a hidden split as a pair, and normal tabs", all(t not in left for t in (t2, t5, t6)), json.dumps(strip()))

    # --- 自動アーカイブもペア単位 ---
    t7 = mk("https://split-7.invalid/"); t8 = mk("https://split-8.invalid/"); time.sleep(0.8)
    E(f"chrome.tabs.createSplit([{t7}, {t8}])")
    E(f"chrome.tabs.update({t3}, {{ active: true }})"); time.sleep(0.5)
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...(r.settings || {}), autoArchiveHours: 0.0003 } }))")
    E("chrome.storage.session.set({ archiveGraceFrom: 0 })"); time.sleep(1.5)
    E("chrome.runtime.sendMessage({ type: 'archive-run' })"); time.sleep(2.5)
    left = order()
    check("auto-archive never closes the visible split's other pane", t3 in left and t4 in left and paired(t3, t4), json.dumps(strip()))
    check("auto-archive closes an unseen split as a pair", t7 not in left and t8 not in left, json.dumps(strip()))
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...(r.settings || {}), autoArchiveHours: 12 } }))")
    E("chrome.storage.session.set({ archiveGraceFrom: Date.now() })")

    # --- 引き出したペインはピン留めタブにできる (分割を解いて担当タブに) ---
    t11 = mk("https://split-11.invalid/"); t9 = mk("https://split-9.invalid/"); t10 = mk("https://split-10.invalid/"); time.sleep(0.8)
    E(f"chrome.tabs.createSplit([{t9}, {t10}])"); time.sleep(1)
    px, py, pw, ph = pane(t10); sx2, sy2, sw2, sh2 = box("document.querySelector('#pinned-section')")
    drag_to(px + pw * 0.4, py + ph / 2, sx2 + sw2 / 2, sy2 + sh2 / 2)
    drop(sx2 + sw2 / 2, sy2 + sh2 / 2)
    pinned_ids = E("chrome.storage.sync.get('pinnedTabs').then(r => (r.pinnedTabs || []).map(n => n.id))")
    owner = E("chrome.storage.session.get('ownedTabs').then(r => Object.entries(r.ownedTabs || {}).find(([, id]) => id === %d)?.[0] ?? null)" % t10)
    check("a pulled pane dropped on the pinned tabs becomes a pinned tab using that tab", len(pinned_ids) == 1 and owner == pinned_ids[0], f"pinned={pinned_ids} owner={owner}")
    check("...out of the split, and its partner stays in Today as a normal row", split_of(t10) == -1 and split_of(t9) == -1 and t9 in today() and t10 not in today(), json.dumps(today()))

    # --- 相方が担当タブの分割: Today では 1 枚の行。相方を見ていても強調し、隣に入れても分割を壊さない ---
    E(f"chrome.tabs.createSplit([{t9}, {t10}])"); time.sleep(0.5)
    E(f"chrome.tabs.update({t10}, {{ active: true }})"); time.sleep(1)
    check("setup: a split whose right pane is a pinned tab's tab", paired(t9, t10) and t10 not in today(), json.dumps(strip()))
    check("the Today row of the other pane is shown as visible while the owned pane is active", row_cls(t9, "active"))
    ax, ay, aw, ah = row(t11); bx, by, bw, bh = row(t9)
    drag_to(ax + aw / 2, ay + ah / 2, bx + bw / 2, by + bh * 0.7)
    move_to(bx + bw / 2, by + bh * 0.7, bx + bw / 2, by + bh * 1.4)
    drop(bx + bw / 2, by + bh * 1.4)
    o = order()
    check("a row moved after that pane goes after the whole pair, not between the panes", paired(t9, t10) and o.index(t11) == o.index(t10) + 1, json.dumps(strip()))

    errs = E("window.__errs")
    check("no errors in the panel", not errs, json.dumps(errs))
finally:
    c.close()

print(f"\n{sum(oks)}/{len(oks)} passed")
sys.exit(0 if all(oks) else 1)
