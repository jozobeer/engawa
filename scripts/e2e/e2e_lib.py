# 分割項目の E2E (e2e_split_items.py) 用の共有ヘルパー。e2e_split.py のヘルパー (check / wait_for / mk / strip / paired / box / mouse / grab ...) を
# 1 回だけ複製してまとめたもの。既存の 4 スイート (e2e_split / e2e_dnd / e2e_pinned / e2e_reorder) は自前のヘルパーのまま (技術的負債)。
import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome


class Lib:
    def __init__(self, ext):
        self.oks = []
        if os.environ.get("E2E_CHROME_LOG"):  # Chrome の stderr を残す (落ちる原因の調査用)
            import subprocess
            real = subprocess.Popen
            subprocess.Popen = lambda *a, **k: real(*a, **{**k, "stderr": open(os.environ["E2E_CHROME_LOG"], "ab")})
        self.c = Chrome(ext)
        c = self.c
        _, self.sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
        c.send("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=self.sp)
        time.sleep(1.2)
        self.E("window.__errs = []; addEventListener('error', e => __errs.push(String(e.message))); addEventListener('unhandledrejection', e => __errs.push(String(e.reason)))")
        self.win = self.E("chrome.windows.getCurrent().then(w => w.id)")

    def E(self, expr):
        return self.c.eval(self.sp, expr, timeout=60)

    def check(self, name, cond, info=""):
        self.oks.append(bool(cond))
        print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)

    def finish(self):
        print(f"\n{sum(self.oks)}/{len(self.oks)} passed")
        return 0 if all(self.oks) else 1

    def close(self):
        self.c.close()

    # ---- タブ ----
    def mk(self, url, pinned=False):
        return self.E(f"chrome.tabs.create({{ url: '{url}', active: false, windowId: {self.win}, pinned: {str(pinned).lower()} }}).then(t => t.id)")

    def strip(self):
        return self.E(f"chrome.tabs.query({{ windowId: {self.win} }}).then(ts => ts.sort((a, b) => a.index - b.index).map(t => [t.id, t.splitViewId]))")

    def order(self):
        return [t for t, _ in self.strip()]

    def split_of(self, tid):
        return dict((t, s) for t, s in self.strip()).get(tid)

    def paired(self, a, b):
        s = self.split_of(a)
        o = self.order()
        return s is not None and s != -1 and s == self.split_of(b) and a in o and b in o and abs(o.index(a) - o.index(b)) == 1

    def tab(self, tid):
        return self.E(f"chrome.tabs.get({tid}).catch(() => null)")

    def active(self, tid):
        return self.E(f"chrome.tabs.get({tid}).then(t => t.active).catch(() => false)")

    def tab_count(self):
        return len(self.strip())

    def today(self):
        return self.E("[...document.querySelectorAll('#today-list > .tab-row')].map(r => r.classList.contains('split-row') ? [...r.querySelectorAll(':scope > .split-pane')].map(p => Number(p.dataset.tabId)) : Number(r.dataset.tabId))")

    # ---- 保存形 ----
    def tree(self):
        # ピン留めタブの木。split は ["split", id, [pane id, pane id]]、tab は id、folder は ["folder", id, [...]]
        return self.E("""chrome.storage.sync.get('pinnedTabs').then(r => {
          const f = (ns) => ns.map(n => n.type === 'folder' ? ['folder', n.id, f(n.children || [])] : n.type === 'split' ? ['split', n.id, n.children.map(c => c.id)] : n.id);
          return f(r.pinnedTabs || []); })""")

    def pinned_raw(self):
        return self.E("chrome.storage.sync.get('pinnedTabs').then(r => r.pinnedTabs || [])")

    def set_pinned(self, nodes):
        self.E("chrome.storage.sync.set({ pinnedTabs: %s })" % json.dumps(nodes))
        self.wait_for(lambda: self.E("pinnedTabs.length") == len(nodes))

    def owned(self):
        return self.E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")

    def owner_of(self, tid):
        return next((k for k, v in self.owned().items() if v == tid), None)

    def errors(self):
        return self.E("window.__errs")

    # ---- 待ち ----
    def wait_for(self, fn, timeout=4.0):
        end = time.time() + timeout
        while time.time() < end:
            v = fn()
            if v: return v
            time.sleep(0.1)
        return fn()

    # ---- 座標 ----
    def box(self, expr):
        return self.E("(() => { const r = (%s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()" % expr)

    def row(self, sel):
        return self.box("document.querySelector(%s)" % json.dumps(sel))

    def has_cls(self, sel, cls):
        return self.E("document.querySelector(%s)?.classList.contains(%s) === true" % (json.dumps(sel), json.dumps(cls)))

    # ---- マウス ----
    def mouse(self, typ, x, y, b=1, mods=0):
        return self.c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": b, "clickCount": 1, "modifiers": mods}, session=self.sp)

    def click(self, x, y, mods=0):
        self.mouse("mouseMoved", x, y, 0); self.mouse("mousePressed", x, y, 1, mods); self.mouse("mouseReleased", x, y, 0, mods); time.sleep(0.6)

    def dblclick(self, x, y):
        self.mouse("mouseMoved", x, y, 0)
        for n in (1, 2):
            self.c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": n}, session=self.sp)
            self.c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": n}, session=self.sp)
        time.sleep(0.6)

    def move_to(self, x1, y1, x2, y2, steps=14):
        for k in range(1, steps + 1):
            self.mouse("mouseMoved", x1 + (x2 - x1) * k / steps, y1 + (y2 - y1) * k / steps); time.sleep(0.03)
        time.sleep(0.25)

    def grab(self, x, y):
        # 押して少し動かし、ドラッグを始める (5px 未満はクリック扱い)。始まった後の位置を返す
        self.mouse("mousePressed", x, y); self.mouse("mouseMoved", x, y + 4); self.mouse("mouseMoved", x, y + 8); time.sleep(0.2)
        return x, y + 8

    def drag_to(self, x1, y1, x2, y2):
        sx, sy = self.grab(x1, y1); self.move_to(sx, sy, x2, y2)

    def drop(self, x, y):
        self.mouse("mouseReleased", x, y, 0); time.sleep(1.5)

    def key(self, k, vk):
        return [self.c.send("Input.dispatchKeyEvent", {"type": t, "key": k, "code": k, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}, session=self.sp) for t in ("keyDown", "keyUp")]
