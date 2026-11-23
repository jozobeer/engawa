# 編集モードの並べ替えの E2E (使い捨てプロファイルのヘッドレス Chrome、ネットワーク不要)
# 使い方: python3 scripts/e2e/e2e_reorder.py <拡張のディレクトリ>
import sys, time, json, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
oks = []
def check(name, cond, info=""):
    oks.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

c = Chrome(ext)
try:
    _, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    c.send("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 700, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    time.sleep(1.2)
    E = lambda expr: c.eval(sp, expr)
    ids = ["a", "b", "c", "d", "e", "f"]
    E("chrome.storage.sync.set({ pins: %s })" % json.dumps([{"id": i, "url": f"https://{i}.invalid/", "title": i} for i in ids]))
    time.sleep(1.5)
    E("document.querySelector('#btn-edit').click()")
    time.sleep(0.3)
    dom = lambda: E("[...document.querySelectorAll('#pin-grid .pin:not(.add)')].map(t => t.dataset.id).join('')")
    stored = lambda: E("chrome.storage.sync.get('pins').then(r => r.pins.map(p => p.id).join(''))")
    center = lambda i: E(f"(() => {{ const r = document.querySelector('.pin[data-id=\"{i}\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
    mouse = lambda typ, x, y, buttons=1: c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": buttons, "clickCount": 1}, session=sp)
    cols = E("getComputedStyle(document.querySelector('#pin-grid')).getPropertyValue('--pin-cols')")
    print("grid cols:", cols)

    # --- 描き直しでタイルの要素を作り直さない (アイコンが一瞬消える・揺れがやり直しになるのを防ぐ) ---
    E("document.querySelectorAll('#pin-grid .pin').forEach(t => { t.__keep = true; })")
    E("renderPins()")
    E("chrome.tabs.create({ url: 'about:blank', active: false })")  # タブの変化による描き直し
    time.sleep(0.8)
    check("re-render keeps existing tile elements (no flicker)", E("[...document.querySelectorAll('#pin-grid .pin:not(.add)')].every(t => t.__keep)"))

    # --- a を d の位置へ。途中で並びがリアルタイムに変わる ---
    ax, ay = center("a"); dx, dy = center("d")
    # タイルの真ん中 (縦横とも ±1/4) に重ねると「分割にする」なので、入れ替えは相手の奥側 1/4 まで進めて行う (combineGrid)
    dx += E("document.querySelector('#pin-grid .pin[data-id=\"d\"]').getBoundingClientRect().width") * 0.4
    mouse("mousePressed", ax, ay)
    steps = 12
    max_anim = 0
    for k in range(1, steps + 1):
        mouse("mouseMoved", ax + (dx - ax) * k / steps, ay + (dy - ay) * k / steps)
        # タイルを横切った直後に、並び替えのアニメーションが走っているかを数える
        max_anim = max(max_anim, E("document.getAnimations().filter(a => a.effect?.target?.classList?.contains('pin')).length"))
        time.sleep(0.03)
    time.sleep(0.2)
    mid = dom()
    check("tiles reorder live while dragging (before release)", mid == "bcdaef", mid)
    check("dragged tile follows the pointer as a floating copy", E("!!document.querySelector('.pin.reorder-ghost')"))
    check("other tiles animate into place", max_anim >= 1, f"max running tile animations: {max_anim}")
    check("storage unchanged until release", stored() == "abcdef", stored())

    # --- ドラッグ中にピンの描き直しが起きても中断しない ---
    E("chrome.storage.local.set({ icons: { 'https://zz.invalid/': 'data:image/png;base64,AA==' } })")
    time.sleep(0.4)
    check("re-render during drag is deferred (dragged tile still in grid)", E("!!document.querySelector('.pin.placeholder')") and dom() == "bcdaef", dom())

    mouse("mouseReleased", dx, dy, 0)
    time.sleep(0.8)
    check("order is saved on release", stored() == "bcdaef", stored())
    check("ghost removed after release", E("!document.querySelector('.pin.reorder-ghost') && !document.querySelector('.pin.placeholder')"))

    # --- 境目付近でゆっくり往復しても、並びが行ったり来たりしない ---
    E("window.__orders = []; window.__mo = new MutationObserver(() => window.__orders.push([...document.querySelectorAll('#pin-grid .pin:not(.add)')].map(t => t.dataset.id).join(''))); window.__mo.observe(document.querySelector('#pin-grid'), { childList: true })")
    bx0, by0 = center("b"); cx0, cy0 = center("c")
    mid_x = (bx0 + cx0) / 2
    mouse("mousePressed", bx0, by0)
    for k in range(40):  # b の中心から b と c の境目付近を小刻みに往復
        off = (k % 6 - 3) * 1.5
        mouse("mouseMoved", mid_x + off, by0)
        time.sleep(0.015)
    mouse("mouseReleased", mid_x, by0, 0)
    time.sleep(0.5)
    flips = E("window.__orders.length")
    check("hovering near a tile boundary does not flip back and forth", flips <= 1, f"{flips} reorders: {E('window.__orders')}")
    E("window.__mo.disconnect()")
    # 元の並び (bcdaef) に戻しておく
    if stored() != "bcdaef":
        E("chrome.storage.sync.set({ pins: ['b','c','d','a','e','f'].map(i => ({ id: i, url: `https://${i}.invalid/`, title: i })) })")
        time.sleep(0.8)

    # --- Esc で取り消し ---
    fx, fy = center("f"); bx, by = center("b")
    mouse("mousePressed", fx, fy)
    for k in range(1, 9):
        mouse("mouseMoved", fx + (bx - fx) * k / 8, fy + (by - fy) * k / 8)
        time.sleep(0.03)
    time.sleep(0.2)
    moved = dom()
    c.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}, session=sp)
    c.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27}, session=sp)
    time.sleep(0.3)
    mouse("mouseReleased", bx, by, 0)
    time.sleep(0.6)
    check("Esc during drag cancels (order restored, nothing saved)", moved != "bcdaef" and dom() == "bcdaef" and stored() == "bcdaef", f"moved={moved} dom={dom()} stored={stored()}")
    check("Esc during drag keeps edit mode on", E("document.querySelector('#pin-grid').classList.contains('editing')"))

    # --- 小さな揺れはクリック扱い (並びは変わらない) ---
    cx, cy = center("c")
    mouse("mousePressed", cx, cy); mouse("mouseMoved", cx + 2, cy + 1); mouse("mouseReleased", cx + 2, cy + 1, 0)
    time.sleep(0.4)
    check("tiny movement is treated as a click", stored() == "bcdaef" and dom() == "bcdaef")

    # --- × ボタンからはドラッグが始まらない ---
    rx, ry = E("(() => { const r = document.querySelector('.pin[data-id=\"e\"] .remove').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    mouse("mousePressed", rx, ry)
    mouse("mouseMoved", rx - 40, ry + 40)
    check("dragging does not start from the remove button", E("!document.querySelector('.pin.reorder-ghost')"))
    mouse("mouseReleased", rx - 40, ry + 40, 0)

    # --- ダブルクリックでその場で名前変更 (パネル内の入力欄。ダイアログは出さない。編集モードでなくてもよい) ---
    E("window.__promptCalled = false; window.prompt = () => { window.__promptCalled = true; return 'X'; }")
    E("setEditing(false)"); time.sleep(0.2)
    dbl = lambda x, y: [c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": 1 if typ == "mousePressed" else 0, "clickCount": n}, session=sp) for typ, n in (("mousePressed", 1), ("mouseReleased", 1), ("mousePressed", 2), ("mouseReleased", 2))]
    cx, cy = center("c"); dbl(cx, cy); time.sleep(0.5)
    check("double-clicking a tile opens an inline rename box in the panel (no dialog)", E("!!document.querySelector('.rename-pop input.rename-input') && document.activeElement?.classList.contains('rename-input') && !window.__promptCalled"))
    check("the rename box sits just under the tile", E("(() => { const p = document.querySelector('.rename-pop'); const t = document.querySelector('.pin[data-id=\"c\"]'); if (!p) return 999; return Math.abs(p.getBoundingClientRect().top - t.getBoundingClientRect().bottom); })()") < 14)
    check("the rename box is opaque (nothing shows through it)", E("(() => { const p = document.querySelector('.rename-pop'); if (!p) return false; const m = getComputedStyle(p).backgroundColor.match(/^rgba?\\(([^)]+)\\)$/); const n = m ? m[1].split(',').map(Number) : []; return n.length === 3 || (n.length === 4 && n[3] >= 0.99); })()"))
    key = lambda k, vk: [c.send("Input.dispatchKeyEvent", {"type": t, "key": k, "code": k, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}, session=sp) for t in ("keyDown", "keyUp")]  # 実キー (合成イベントではない)
    reopen = lambda: (dbl(cx, cy), time.sleep(0.5)) if not E("!!document.querySelector('.rename-pop')") else None
    E("document.querySelector('.rename-pop input')?.dispatchEvent(new Event('scroll'))"); time.sleep(0.2)
    check("the box's own scrolling (long text) does not close it", E("!!document.querySelector('.rename-pop')"))
    reopen()
    E("(() => { const i = document.querySelector('.rename-pop input'); if (!i) return; i.value = 'Renamed C'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); })()"); time.sleep(0.3)
    check("Enter that confirms an IME composition does not commit", E("!!document.querySelector('.rename-pop')") and E("chrome.storage.sync.get('pins').then(r => r.pins.find(p => p.id === 'c').title)") != "Renamed C")
    reopen(); E("(() => { const i = document.querySelector('.rename-pop input'); if (i) i.value = 'Renamed C'; })()")
    key("Enter", 13); time.sleep(0.6)
    check("Enter saves the new title and closes the box", E("chrome.storage.sync.get('pins').then(r => r.pins.find(p => p.id === 'c').title)") == "Renamed C" and E("!document.querySelector('.rename-pop')"))
    dbl(cx, cy); time.sleep(0.5)
    E("(() => { const i = document.querySelector('.rename-pop input'); if (i) i.value = 'zzz'; })()"); key("Escape", 27); time.sleep(0.5)
    check("Escape cancels and keeps the title", E("chrome.storage.sync.get('pins').then(r => r.pins.find(p => p.id === 'c').title)") == "Renamed C" and E("!document.querySelector('.rename-pop')"))
    # パネルの外へフォーカスが出ても箱は消えず、パネルがフォーカスを取り戻したら入力欄に戻る。パネル内の別の場所へ移ったときだけ確定。
    # ヘッドレスは CDP で入力を送った後にタブを切り替えても document.hasFocus() が true のままなので、hasFocus を false にして blur を起こす
    E("startPinRename(document.querySelector('.pin[data-id=\"c\"]'))"); time.sleep(0.3)
    E("(() => { const i = document.querySelector('.rename-pop input'); const orig = document.hasFocus; document.hasFocus = () => false; i.blur(); setTimeout(() => { document.hasFocus = orig; }, 150); })()"); time.sleep(0.4)
    check("a blur caused by the panel losing focus keeps the rename box open", E("!!document.querySelector('.rename-pop')"))
    E("window.dispatchEvent(new Event('focus'))"); time.sleep(0.2)
    check("when the panel gets focus back, the box's input is focused again", E("document.activeElement?.classList.contains('rename-input')"))
    E("(() => { const i = document.querySelector('.rename-pop input'); if (i) i.value = 'Renamed C2'; })()")
    E("(() => { const orig = document.hasFocus; document.hasFocus = () => true; document.querySelector('#btn-edit').focus(); setTimeout(() => { document.hasFocus = orig; }, 150); })()"); time.sleep(0.5)  # パネル内の別の場所へ (hasFocus は true)
    check("moving focus elsewhere in the panel saves and closes the box", E("chrome.storage.sync.get('pins').then(r => r.pins.find(p => p.id === 'c').title)") == "Renamed C2" and E("!document.querySelector('.rename-pop')"))
    E("chrome.tabs.getCurrent().then(t => chrome.tabs.update(t.id, { active: true }))"); time.sleep(0.3)  # 1 回目のクリックで開いたタブからパネルへ戻す (背景タブでは色の検査が狂う)
    mouse("mouseMoved", 1, 1); time.sleep(0.2)  # タイルにポインターが残ると :hover の明度で色の検査が狂う

    # --- 同じアイコンのお気に入りは、色相と明るさを少しずらして見分けられる ---
    import zlib, struct, base64, colorsys
    def png(size, rgb):
        raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
        ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")
    red = "data:image/png;base64," + base64.b64encode(png(32, (220, 60, 60))).decode()
    blue = "data:image/png;base64," + base64.b64encode(png(32, (60, 120, 220))).decode()
    E("setEditing(false)")
    E("chrome.storage.local.set({ icons: { 'https://a.invalid/': %s, 'https://b.invalid/': %s, 'https://c.invalid/': %s, 'https://d.invalid/': %s } })" % (json.dumps(red), json.dumps(red), json.dumps(red), json.dumps(blue)))
    time.sleep(2.5)
    info = E("(() => Object.fromEntries(['a','b','c','d'].map(i => { const el = document.querySelector('.pin[data-id=\"' + i + '\"]'); const cs = getComputedStyle(el); return [i, { step: cs.getPropertyValue('--tint-step').trim(), tinted: el.classList.contains('tinted'), dup: el.classList.contains('dup'), bg: cs.backgroundColor }]; })))()")
    def hsl(rgb):
        m = re.findall(r"[\d.]+", rgb); r, g, b = [float(x) / 255 for x in m[:3]]
        h, l, s = colorsys.rgb_to_hls(r, g, b); return h * 360, s, l
    # グループ内の段数はグリッドの並び順で決まる (スイートの前半で並べ替えているので ID 順ではない)
    order = [i for i in E("[...document.querySelectorAll('#pin-grid .pin:not(.add)')].map(t => t.dataset.id)") if i in "abc"]
    base, s1, s2 = order
    check("duplicate icons get alternating hue steps (0, +1, -1 in grid order) and a different icon stays at 0",
          [info[i]["step"] for i in (base, s1, s2, "d")] == ["0", "1", "-1", "0"] and info[s1]["dup"] and not info[base]["dup"] and not info["d"]["dup"], json.dumps(info))
    if all(info[i]["tinted"] for i in "abc"):
        hb, _, lb = hsl(info[base]["bg"]); h1, _, l1 = hsl(info[s1]["bg"]); h2, _, l2 = hsl(info[s2]["bg"])
        dh = lambda x, y: min(abs(x - y), 360 - abs(x - y))
        check("hue shifts by about 12 degrees per step in opposite directions, lightness by about 4%",
              6 <= dh(hb, h1) <= 18 and 6 <= dh(hb, h2) <= 18 and 18 <= dh(h1, h2) <= 30 and 0.02 <= abs(lb - l1) <= 0.07 and abs(l1 - l2) < 0.01,
              f"base={hb:.0f}/{lb:.2f} +1={h1:.0f}/{l1:.2f} -1={h2:.0f}/{l2:.2f}")
    else:
        check("duplicate tiles are tinted", False, json.dumps(info))
    # 同じアイコンのタイルにだけ、短い名前が薄く出る
    E("chrome.storage.sync.set({ pins: ['a','b','c','d'].map(i => ({ id: i, url: `https://${i}.invalid/`, title: i === 'a' ? '請求書 2026 - Google ドキュメント' : i === 'd' ? 'Only one - Site' : 'Spec ' + i })) })")
    time.sleep(1.2)
    hints = E("Object.fromEntries(['a','b','c','d'].map(i => { const el = document.querySelector('.pin[data-id=\"' + i + '\"]'); const l = el.querySelector('.hint-label'); const cs = l && getComputedStyle(l); return [i, l ? { text: l.textContent, size: cs.fontSize, color: cs.color } : null]; }))")
    check("every tile shows a short hint", all(hints[i] for i in "abcd"), json.dumps(hints, ensure_ascii=False))
    check("hint drops the service-name suffix, is bold-ish 11px and translucent", hints["a"]["text"] == "請求書 2026" and hints["d"]["text"] == "Only one" and float(hints["a"]["size"][:-2]) >= 12 and ("/ " in hints["a"]["color"] or "rgba" in hints["a"]["color"]), json.dumps(hints["a"], ensure_ascii=False))

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:300])
finally:
    c.close()
print(f"\n{sum(oks)}/{len(oks)} passed")
