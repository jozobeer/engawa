import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
ok_all = []
def check(name, cond, info=""):
    ok_all.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))
c = Chrome(ext)
try:
    _, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    time.sleep(1.2)
    E = lambda expr: c.eval(sp, expr)
    tile = lambda pid: E(f"(() => {{ const el = document.querySelector('.pin[data-id=\"{pid}\"]'); return el ? (el.querySelector('img:not(.live-icon)')?.src.startsWith('data:') ? 'img' : (el.querySelector('.fallback') ? 'letter' : 'other')) : 'missing'; }})()")  # 保存済みアイコン (担当タブのライブなアイコンは除く)
    E("""chrome.storage.sync.set({ pins: [
        { id: 'p-wiki', url: 'https://www.wikipedia.org/', title: 'Wikipedia' },
        { id: 'p-redir', url: 'http://github.com/', title: 'GitHub via http' } ] })""")
    time.sleep(2.5)
    check("never-visited pin starts as a letter tile", tile("p-wiki") == "letter", tile("p-wiki"))
    # ピンを使わず、普通のタブでサイトを開く
    tid, _ = c.open("https://www.wikipedia.org/")
    time.sleep(7)
    check("opening the site in an ordinary tab refreshes the pin icon without reopening the panel", tile("p-wiki") == "img", tile("p-wiki"))
    # リダイレクトするピン (http -> https) をピンからクリック
    check("redirecting pin starts as a letter tile", tile("p-redir") == "letter", tile("p-redir"))
    E("document.querySelector('.pin[data-id=\"p-redir\"]').click()")
    time.sleep(8)
    check("redirecting pin gets the landing page icon after opening it from the pin", tile("p-redir") == "img", tile("p-redir"))
    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:300])
finally:
    c.close()
print(f"\n{sum(ok_all)}/{len(ok_all)} passed")
