# 拡張の E2E 検証 (使い捨てプロファイルのヘッドレス Chrome)
# 使い方: python3 scripts/e2e/e2e.py <拡張のディレクトリ>
# github.com へのネットワーク接続が必要。Arc のデータ (macOS) があれば Arc インポートも検証し、無ければその節を飛ばす。
# Arc のデータは使い捨てプロファイル内でだけ使い、外部には送らない。
import sys, time, json, os, base64, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome

ext = sys.argv[1]
ARC = os.path.expanduser("~/Library/Application Support/Arc")
results = []
def check(name, cond, info=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

c = Chrome(ext)
try:
    _, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    time.sleep(1.2)
    E = lambda expr, **kw: c.eval(sp, expr, **kw)

    # ---------- 1. 実サイトのアイコン取得 ----------
    tid, page = c.open("https://github.com/")
    for _ in range(40):
        time.sleep(0.5)
        try:
            if c.eval(page, "document.readyState") == "complete": break
        except Exception: pass
    time.sleep(2)
    v = E("realFaviconDataUrl('https://github.com/', { fresh: true }).then(v => v === null ? 'null' : v === undefined ? 'undef' : v.slice(0, 22))")
    check("visited site returns a real icon as data URL", isinstance(v, str) and v.startswith("data:image/png;base64"), v)
    c.send("Target.closeTarget", {"targetId": tid})

    # ---------- 2. ピンの描画: 未訪問は頭文字タイル、訪問済みは画像 ----------
    E("""chrome.storage.sync.set({ pins: [
        { id: 'p-gh', url: 'https://github.com/', title: 'GitHub' },
        { id: 'p-unk', url: 'https://never-visited.invalid/', title: 'Unknown' } ] })""")
    time.sleep(2.5)
    state = E("""(() => [...document.querySelectorAll('#pin-grid .pin')].map(el => ({
        id: el.dataset.id, img: el.querySelector('img')?.src.slice(0, 22) || null, letter: el.querySelector('.fallback')?.textContent || null })))()""")
    gh = next((s for s in state if s["id"] == "p-gh"), {}); unk = next((s for s in state if s["id"] == "p-unk"), {})
    check("visited pin shows stored data URL icon", (gh.get("img") or "").startswith("data:image/png"), json.dumps(gh))
    check("never-visited pin shows a letter tile instead of the globe", unk.get("letter") == "N", json.dumps(unk))
    stored = E("chrome.storage.local.get('icons').then(r => Object.keys(r.icons || {}))")
    check("icon persisted in storage.local", "https://github.com/" in stored, stored)

    # ---------- 3. 担当タブ ----------
    count_tabs = lambda: E("chrome.tabs.query({}).then(ts => ts.filter(t => /^https?:/.test(t.url || t.pendingUrl || '')).length)")
    before = count_tabs()
    # 実際のマウス操作でタイルをクリック (pointerdown → pointerup → click)
    px, py = E("(() => { const r = document.querySelector('.pin[data-id=\"p-gh\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    for typ, btns in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
        c.send("Input.dispatchMouseEvent", {"type": typ, "x": px, "y": py, "button": "left", "buttons": btns, "clickCount": 1}, session=sp)
    time.sleep(3)
    after1 = count_tabs()
    owned = E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    pinned = E(f"chrome.tabs.get({owned.get('p-gh', -1)}).then(t => t.pinned).catch(() => null)") if "p-gh" in owned else None
    check("first click opens one tab and binds it", after1 == before + 1 and "p-gh" in owned, f"{before}->{after1} owned={owned}")
    check("owned tab is Chrome-pinned", pinned is True, str(pinned))
    E("document.querySelector('.pin[data-id=\"p-gh\"]').click()")
    time.sleep(2)
    check("second click does not open another tab", count_tabs() == after1)
    gh_tab = owned.get("p-gh")
    c.send("Target.createTarget", {"url": "about:blank"})  # 別タブを作ってフォーカスを外す
    time.sleep(0.5)
    E(f"chrome.tabs.update({gh_tab}, {{ url: 'https://github.com/features' }})")
    time.sleep(4)
    E(f"chrome.tabs.update({gh_tab}, {{ active: true }})")
    time.sleep(0.5)
    E("document.querySelector('.pin[data-id=\"p-gh\"]').click()")
    time.sleep(4)
    url_now = E(f"chrome.tabs.get({gh_tab}).then(t => t.url || t.pendingUrl)")
    check("re-click while viewing a navigated owned tab resets to the pin URL", url_now.rstrip('/') == "https://github.com", url_now)
    E(f"chrome.tabs.remove({gh_tab})")
    time.sleep(1.5)
    E("document.querySelector('.pin[data-id=\"p-gh\"]').click()")
    time.sleep(3)
    owned2 = E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    reopened = E(f"chrome.tabs.get({owned2.get('p-gh', -1)}).then(t => t.url || t.pendingUrl).catch(() => null)")
    check("after closing, click reopens the pin URL in a new owned tab", owned2.get("p-gh") not in (None, gh_tab) and (reopened or "").startswith("https://github.com"), f"{owned2} {reopened}")

    # ---------- 4. Arc のアイコン取り込み ----------
    if not os.path.exists(os.path.join(ARC, "SidebarItemsFaviconCache")):
        print("SKIP Arc import (no Arc data on this machine)")
    else:
        sidebar = open(os.path.join(ARC, "StorableSidebar.json"), "rb").read()
        icon_dir = os.path.join(ARC, "SidebarItemsFaviconCache")
        icons = {n: base64.b64encode(open(os.path.join(icon_dir, n), "rb").read()).decode() for n in os.listdir(icon_dir)}
        E("showSettings()")
        E(f"""(async () => {{
            const sb = new File([Uint8Array.from(atob({json.dumps(base64.b64encode(sidebar).decode())}), ch => ch.charCodeAt(0))], 'StorableSidebar.json');
            const dt = new DataTransfer(); dt.items.add(sb);
            const input = document.querySelector('#in-arc-file'); input.files = dt.files;
            input.dispatchEvent(new Event('change'));
        }})()""")
        time.sleep(1.5)
        n_cand = E("importCandidates.length")
        check("Arc sidebar parsed into candidates", n_cand >= 1, str(n_cand))
        check("icon-folder step is offered", E("!document.querySelector('#import-icons').hidden"))
        E(f"""(async () => {{
            const m = {json.dumps(icons)};
            const dt = new DataTransfer();
            for (const [n, b] of Object.entries(m)) dt.items.add(new File([Uint8Array.from(atob(b), ch => ch.charCodeAt(0))], n));
            const input = document.querySelector('#in-arc-icons'); input.files = dt.files;
            input.dispatchEvent(new Event('change'));
        }})()""")
        time.sleep(2)
        with_icon = E("new Set(importCandidates.filter(c => c.icon).map(c => c.url)).size")
        uniq = E("new Set(importCandidates.map(c => c.url)).size")
        check("Arc icons matched to candidates", with_icon == uniq, f"{with_icon}/{uniq}")
        st = E("document.querySelector('#import-icons-status').textContent")
        check("icon status message shown", bool(st), st)
        rows_with_data = E("[...document.querySelectorAll('#import-groups .import-item img')].filter(i => i.src.startsWith('data:')).length")
        check("preview rows render the Arc icons", rows_with_data >= with_icon, str(rows_with_data))
        E("document.querySelector('#btn-import').click()")
        time.sleep(2)
        pins_now = E("chrome.storage.sync.get('pins').then(r => r.pins.map(p => p.url))")
        icon_keys = E("chrome.storage.local.get('icons').then(r => Object.keys(r.icons || {}))")
        imported = [u for u in pins_now if u not in ("https://github.com/", "https://never-visited.invalid/")]
        check("import added pins", len(imported) >= 1, f"{len(imported)} imported")
        check("imported pins have stored icons", all(u in icon_keys for u in imported), f"{sum(u in icon_keys for u in imported)}/{len(imported)}")
        E("showMain()")
        time.sleep(1)
        grid = E("[...document.querySelectorAll('#pin-grid .pin')].map(el => el.querySelector('img')?.src.startsWith('data:') ? 'img' : (el.querySelector('.fallback') ? 'letter' : 'other'))")
        check("grid shows icons for imported pins", grid.count("img") >= len(imported), json.dumps(grid))

    # ---------- 5. 例外 ----------
    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions in the side panel", not exc, json.dumps(exc[:2])[:400])
finally:
    c.close()
print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed")
