# Today 欄・アーカイブ・自動アーカイブ・ピンのライブなアイコンの E2E (使い捨てプロファイルのヘッドレス Chrome)
# 使い方: python3 scripts/e2e/e2e_today.py <拡張のディレクトリ>   (github.com への接続が必要)
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
    # 自動アーカイブは背景のサービスワーカーにメッセージで頼む (モジュール形式なので関数を直接は呼べない)
    run_archive = lambda: E("chrome.runtime.sendMessage({ type: 'archive-run' })")

    win = E("chrome.windows.getCurrent().then(w => w.id)")
    mk = lambda url, active=False, pinned=False: E(f"chrome.tabs.create({{ url: '{url}', active: {str(active).lower()}, pinned: {str(pinned).lower()}, windowId: {win} }}).then(t => t.id)")
    t1 = mk("https://example.com/?a=1"); t2 = mk("https://example.com/?a=2"); t3 = mk("https://example.com/?a=3")
    time.sleep(3)
    rows = lambda: E("[...document.querySelectorAll('#today-list .tab-row')].map(r => Number(r.dataset.tabId))")
    chrome_order = lambda: E(f"chrome.tabs.query({{ windowId: {win} }}).then(ts => ts.sort((a, b) => a.index - b.index).map(t => t.id))")
    r = rows()
    check("Today lists this window's tabs in Chrome's order", [x for x in chrome_order() if x in r] == r and all(x in r for x in (t1, t2, t3)), f"rows={r}")

    # --- クリックで切り替え ---
    # 実際のマウス操作 (pointerdown → pointerup → click) で行をクリックする。el.click() では並べ替え部品との相互作用を見逃す
    rx, ry = E(f"(() => {{ const r = document.querySelector('.tab-row[data-tab-id=\"{t2}\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
    for typ, btns in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
        c.send("Input.dispatchMouseEvent", {"type": typ, "x": rx, "y": ry, "button": "left", "buttons": btns, "clickCount": 1}, session=sp)
    for _ in range(30):  # 切り替えと描き直しは非同期なので最大 3 秒待つ
        time.sleep(0.1)
        if E(f"document.querySelector('.tab-row[data-tab-id=\"{t2}\"]').classList.contains('active')"): break
    check("clicking a row activates the tab", E(f"chrome.tabs.get({t2}).then(t => t.active)"))
    check("active row is highlighted", E(f"document.querySelector('.tab-row[data-tab-id=\"{t2}\"]').classList.contains('active')"))

    # --- ドラッグで並べ替え → Chrome のタブの並びにも反映 ---
    center = lambda tid: E(f"(() => {{ const r = document.querySelector('.tab-row[data-tab-id=\"{tid}\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
    mouse = lambda typ, x, y, b=1: c.send("Input.dispatchMouseEvent", {"type": typ, "x": x, "y": y, "button": "left", "buttons": b, "clickCount": 1}, session=sp)
    (x3, y3), (x1, y1) = center(t3), center(t1)
    # 相手の行の真ん中は分割の帯 (e2e_split.py) なので、並べ替えは相手の奥側 (上へなら上端寄り) まで動かす
    y1 -= E(f"document.querySelector('.tab-row[data-tab-id=\"{t1}\"]').getBoundingClientRect().height") * 0.4
    c.send("Page.bringToFront", session=sp); time.sleep(0.3)  # 行のクリックでサイドパネルのタブが裏に回ると、ヘッドレス Chrome は入力イベントに応答しなくなる
    mouse("mousePressed", x3, y3)
    for k in range(1, 13):
        mouse("mouseMoved", x3, y3 + (y1 - y3) * k / 12); time.sleep(0.03)
    time.sleep(0.2)
    live = rows()
    check("Today rows reorder live while dragging", live.index(t3) < live.index(t1), f"{live}")
    mouse("mouseReleased", x1, y1, 0)
    time.sleep(1.2)
    co = chrome_order()
    check("drop moves the Chrome tab too", co.index(t3) < co.index(t1), f"chrome={co}")
    check("rows match Chrome's order after the move", [x for x in co if x in rows()] == rows(), f"rows={rows()}")

    # --- × で閉じる ---
    t4 = mk("https://example.com/?a=4"); time.sleep(2)
    E(f"document.querySelector('.tab-row[data-tab-id=\"{t4}\"] .tab-close').click()")
    time.sleep(1)
    check("× closes the tab", E(f"chrome.tabs.get({t4}).then(() => false).catch(() => true)") and t4 not in rows())

    # --- 一括アーカイブ (表示中・固定は残す) → アーカイブ画面から開き直す ---
    pinned_t = mk("https://example.com/?pinned", pinned=True); time.sleep(2)
    E(f"chrome.tabs.update({t2}, {{ active: true }})"); time.sleep(2.5)  # bringToFront で表に出したサイドパネルの一覧が、t2 の表示中に追従するのを待つ
    E("document.querySelector('#btn-clear-today').click()")
    time.sleep(2)
    alive = lambda tid: E(f"chrome.tabs.get({tid}).then(() => true).catch(() => false)")
    check("clear archives inactive tabs", not alive(t1) and not alive(t3))
    check("clear keeps the active tab and pinned tabs", alive(t2) and alive(pinned_t))
    arch = E("chrome.storage.local.get('archive').then(r => (r.archive || []).map(e => e.url))")
    check("archived tabs are recorded", "https://example.com/?a=1" in arch and "https://example.com/?a=3" in arch, json.dumps(arch))
    check("toast reports the count", "2" in E("document.querySelector('#toast').textContent"), E("document.querySelector('#toast').textContent"))
    E("document.querySelector('#btn-archive').click()"); time.sleep(0.8)
    n_rows = E("document.querySelectorAll('#archive-list .archive-row').length")
    check("archive view lists the archived tabs", n_rows >= 2, str(n_rows))
    E("document.querySelector('#archive-list .archive-row').click()"); time.sleep(2)
    arch2 = E("chrome.storage.local.get('archive').then(r => (r.archive || []).length)")
    reopened = E(f"chrome.tabs.query({{ windowId: {win} }}).then(ts => ts.some(t => /a=[13]$/.test(t.url || t.pendingUrl || '')))")
    check("clicking an archived tab reopens it and removes it from the archive", reopened and arch2 == len(arch) - 1, f"{arch2}")
    E("document.querySelector('#btn-archive-back').click()"); time.sleep(0.3)
    check("back returns to main", E("!document.querySelector('#view-main').hidden"))

    # --- 自動アーカイブ: 対象外の判定 ---
    old1 = mk("https://example.com/?old1"); old2 = mk("https://example.com/?old2")
    time.sleep(2.5)
    E("chrome.storage.sync.set({ pins: [{ id: 'po', url: 'https://example.com/?owned', title: 'owned' }] })"); time.sleep(0.8)
    E("openOwned('po', 'https://example.com/?owned')"); time.sleep(2.5)
    owned_tab = E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs.po)")
    E(f"chrome.tabs.update({t2}, {{ active: true }})"); time.sleep(0.5)
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...(r.settings || {}), autoArchiveHours: 0.0003 } }))")
    E("chrome.storage.session.set({ archiveGraceFrom: 0 })")
    time.sleep(1.5)
    run_archive()
    time.sleep(2)
    check("auto-archive closes tabs not viewed for the set time", not alive(old1) and not alive(old2))
    check("auto-archive keeps the active, pinned and owned tabs", alive(t2) and alive(pinned_t) and alive(owned_tab), f"{alive(t2)} {alive(pinned_t)} {alive(owned_tab)}")
    check("owned pin tab is not shown in Today", owned_tab not in rows())
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...(r.settings || {}), autoArchiveHours: 12 } }))")
    E("chrome.storage.session.set({ archiveGraceFrom: Date.now() })")
    run_archive(); time.sleep(1)
    check("grace period protects tabs right after startup/install", alive(t2) and all(alive(x) for x in rows() if x not in (owned_tab,)))

    # --- メモリセーバーの破棄 (discard) でタブ ID が変わっても担当は保たれ、自動アーカイブに閉じられない ---
    nid = E(f"chrome.tabs.discard({owned_tab}).then(t => t.id)"); time.sleep(1.5)
    check("discard keeps the owned binding on the new tab id", E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs.po)") == nid and nid not in rows(), f"new={nid}")
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...(r.settings || {}), autoArchiveHours: 0.0003 } }))")
    E("chrome.storage.session.set({ archiveGraceFrom: 0 })"); time.sleep(1)
    run_archive(); time.sleep(2)
    check("auto-archive keeps a discarded owned tab", alive(nid))
    E("chrome.storage.sync.get('settings').then(r => chrome.storage.sync.set({ settings: { ...(r.settings || {}), autoArchiveHours: 12 } }))")
    E("chrome.storage.session.set({ archiveGraceFrom: Date.now() })"); time.sleep(0.5)

    # --- beforeunload で閉じられないタブが 1 件あっても、ほかのタブは閉じて記録され、応答も返る ---
    import http.server, threading, socketserver
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"<html><body><h1>draft</h1><script>window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });</script></body></html>"
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        def log_message(self, *a): pass
    srv = socketserver.TCPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    bu_url = f"http://127.0.0.1:{port}/draft"
    bu_tid = c.send("Target.createTarget", {"url": bu_url})["targetId"]
    bu_sid = c.send("Target.attachToTarget", {"targetId": bu_tid, "flatten": True})["sessionId"]
    c.send("Page.enable", session=bu_sid); time.sleep(1.5)
    # ユーザー操作 (クリック) があると beforeunload の確認が出るようになる
    c.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 50, "y": 50, "button": "left", "clickCount": 1}, session=bu_sid)
    c.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": 50, "y": 50, "button": "left", "clickCount": 1}, session=bu_sid)
    time.sleep(0.3)
    bu_tab = E(f"chrome.tabs.query({{ url: '{bu_url}' }}).then(ts => ts[0].id)")
    plain1 = mk("https://example.com/?plain1"); plain2 = mk("https://example.com/?plain2"); time.sleep(2.5)
    E(f"chrome.tabs.update({t2}, {{ active: true }})"); time.sleep(0.5)
    before_n = E("chrome.storage.local.get('archive').then(r => (r.archive || []).length)")
    # 応答を待たずに送り (CDP ドライバはスレッド安全でないのでスレッドは使わない)、結果は window 変数で受ける
    c.send("Runtime.evaluate", {"expression": f"window.__archResp = undefined; chrome.runtime.sendMessage({{ type: 'archive-tabs', tabIds: [{plain1}, {bu_tab}, {plain2}] }}).then(r => {{ window.__archResp = r; }}, e => {{ window.__archResp = {{ error: String(e) }}; }})", "awaitPromise": False, "returnByValue": True}, session=sp)
    t0 = time.time(); dialog_seen = False; resp = {}
    for _ in range(100):
        time.sleep(0.1)
        r = E("window.__archResp")  # イベントもこの往復で受信される
        for ev in list(c.events):
            if ev.get("method") == "Page.javascriptDialogOpening" and ev.get("sessionId") == bu_sid:
                c.events.remove(ev)
                c.send("Page.handleJavaScriptDialog", {"accept": False}, session=bu_sid)  # 「キャンセル」
                dialog_seen = True
        if r is not None: resp["r"] = r; break
    took = time.time() - t0
    check("beforeunload tab prompts and is left open when cancelled", dialog_seen and alive(bu_tab), f"dialog={dialog_seen}")
    check("the other tabs in the batch are closed and recorded", not alive(plain1) and not alive(plain2) and E("chrome.storage.local.get('archive').then(r => (r.archive || []).length)") == before_n + 2)
    check("archive request still answers within the cutoff", "r" in resp and took < 9, f"took={took:.1f}s resp={resp.get('r')}")
    check("stuck tab is skipped by auto-archive until viewed again", E(f"chrome.storage.session.get('archiveSkip').then(r => String({bu_tab}) in (r.archiveSkip || {{}}))"))
    srv.shutdown()

    # --- ピンのライブなアイコン ---
    E("chrome.storage.sync.set({ pins: [{ id: 'pg', url: 'https://github.com/', title: 'GitHub' }] })"); time.sleep(0.8)
    E("openOwned('pg', 'https://github.com/')")
    time.sleep(7)
    fav = E("chrome.storage.session.get('ownedTabs').then(r => chrome.tabs.get(r.ownedTabs.pg)).then(t => t.favIconUrl || '')")
    live_src = E("(() => { const i = document.querySelector('.pin[data-id=\"pg\"] img.live-icon'); return i && !i.hidden ? i.src : null; })()")
    check("pin shows the owned tab's current favicon while it is open", bool(fav) and live_src == fav, f"fav={fav[:60]} live={str(live_src)[:60]}")
    E("chrome.storage.session.get('ownedTabs').then(r => chrome.tabs.remove(r.ownedTabs.pg))"); time.sleep(1.5)
    check("live favicon goes away when the tab is closed", E("!document.querySelector('.pin[data-id=\"pg\"] img.live-icon')"))

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:400])
finally:
    c.close()
print(f"\n{sum(oks)}/{len(oks)} passed")
