# 担当タブの細かい挙動の E2E (使い捨てプロファイルのヘッドレス Chrome)
# 使い方: python3 scripts/e2e/e2e_owned.py <拡張のディレクトリ>   (github.com への接続が必要)
import sys, time, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
oks = []
def check(name, cond, info=""):
    oks.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

c = Chrome(ext)
try:
    tid_sp, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    time.sleep(1.2)
    E = lambda expr: c.eval(sp, expr, timeout=60)
    tab = lambda tid: E(f"chrome.tabs.get({tid}).then(t => ({{ url: t.url || t.pendingUrl, pinned: t.pinned }})).catch(() => null)")
    owned = lambda: E("chrome.storage.session.get('ownedTabs').then(r => r.ownedTabs || {})")
    PR = "https://github.com/cli/cli/pull/1"

    # --- 未認証: 更新ボタンが本当に隠れる ([hidden] が .icon-btn の display に勝つ) ---
    disp = E("getComputedStyle(document.querySelector('#btn-refresh')).display")
    check("no-token: refresh button is hidden", disp == "none", disp)
    check("no-token: 'Open settings' is a focusable button", E("document.querySelector('#gh-error button.link-btn') !== null"))

    # --- PR の担当先は「一覧に見えている PR」だけなので、トークンと PR 1 件を storage に置いておく (ネットワークは使わない) ---
    GH = "gh:" + PR
    E(f"chrome.storage.local.set({{ settings: {{ token: 'x' }}, github: {{ mine: [{{ url: '{PR}', title: 't', repo: 'cli/cli', number: 1, updatedAt: new Date().toISOString(), ci: null }}], reviews: [], fetchedAt: Date.now() }} }})")
    time.sleep(1.5)

    # --- 自分で固定した github.com/notifications を GitHub 担当が奪わない ---
    mine = E("chrome.tabs.create({ url: 'https://github.com/notifications', pinned: true, active: false }).then(t => t.id)")
    time.sleep(3)
    E(f"openOwned('{GH}', '{PR}', {{ navigate: true, chromePin: false }})")
    time.sleep(4)
    o = owned()
    # 未ログインの使い捨てプロファイルでは notifications がログインページへ飛ぶので、return_to も許容する
    mine_url = (tab(mine) or {}).get("url", "")
    check("PR click does not hijack the user's own pinned github tab",
          o.get(GH) not in (None, mine) and "notifications" in mine_url and "/pull/" not in mine_url, f"owned={o} mine={mine_url}")
    gh = o.get(GH)

    # --- 同じ PR のサブページを表示中なら移動しない ---
    E(f"chrome.tabs.update({gh}, {{ url: '{PR}/files' }})")
    time.sleep(4)
    E("chrome.tabs.create({ url: 'about:blank', active: true })")  # 別のタブを見ている状態にする
    time.sleep(0.5)
    E(f"openOwned('{GH}', '{PR}', {{ navigate: true, chromePin: false }})")
    time.sleep(2)
    u = tab(gh)["url"]
    check("switching back to the same PR keeps Files changed", u.rstrip("/").endswith("/pull/1/files"), u)
    E(f"openOwned('{GH}', '{PR}', {{ navigate: true, chromePin: false }})")  # 表示中にもう一度 → Conversation に戻る
    time.sleep(3)
    u = tab(gh)["url"]
    check("clicking again while viewing it returns to the PR conversation", u.rstrip("/").endswith("/pull/1"), u)

    # --- ピン: ダブルクリックでリセットしない ---
    E("chrome.storage.sync.set({ pins: [{ id: 'p1', url: 'https://github.com/cli', title: 'cli' }] })")
    time.sleep(1.5)
    E("document.querySelector('.pin[data-id=\"p1\"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))")
    time.sleep(3)
    p1 = owned().get("p1")
    E(f"chrome.tabs.update({p1}, {{ url: 'https://github.com/cli/cli' }})")
    time.sleep(4)
    E(f"chrome.tabs.update({p1}, {{ active: true }})")
    time.sleep(0.5)
    E("document.querySelector('.pin[data-id=\"p1\"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))")
    time.sleep(2)
    u = tab(p1)["url"]
    check("double-click (2nd click) does not reset the browsed tab", u.rstrip("/").endswith("/cli/cli"), u)

    # --- 再起動相当: session を消してパネルを開き直すと、閲覧先 URL で結び直す ---
    time.sleep(1)
    urls = E("chrome.storage.local.get('ownedUrls').then(r => r.ownedUrls || {})")
    check("background records the owned tab's last URL", (urls.get("p1") or "").rstrip("/").endswith("/cli/cli"), json.dumps(urls))
    E("chrome.storage.session.remove('ownedTabs')")
    c.send("Target.closeTarget", {"targetId": tid_sp})
    time.sleep(0.5)
    tid_sp, sp = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    time.sleep(2)
    o = owned()
    check("after a session wipe, the browsed pin tab is rebound via its last URL", o.get("p1") == p1, f"{o} expected p1={p1}")
    check("after a session wipe, the GitHub tab is rebound too", o.get(GH) == gh, f"{o} expected {GH}={gh}")

    # --- 自分で固定していたタブは、ピン削除で固定解除しない ---
    own_pinned = E("chrome.tabs.create({ url: 'https://github.com/about', pinned: true, active: false }).then(t => t.id)")
    time.sleep(3)
    E("chrome.storage.sync.set({ pins: [{ id: 'p1', url: 'https://github.com/cli', title: 'cli' }, { id: 'p2', url: 'https://github.com/about', title: 'about' }] })")
    time.sleep(1.5)
    E("openOwned('p2', 'https://github.com/about')")
    time.sleep(1.5)
    check("a user-pinned tab with the exact URL is adopted", owned().get("p2") == own_pinned, json.dumps(owned()))
    # 別の端末でピンが削除された想定 (sync の変更だけ)
    E("chrome.storage.sync.set({ pins: [{ id: 'p1', url: 'https://github.com/cli', title: 'cli' }] })")
    time.sleep(2)
    check("pin deleted elsewhere releases its binding", "p2" not in owned(), json.dumps(owned()))
    check("user-pinned tab stays pinned after release", (tab(own_pinned) or {}).get("pinned") is True, json.dumps(tab(own_pinned)))
    # 拡張が固定したタブは解除される
    E("chrome.storage.sync.set({ pins: [] })")
    time.sleep(2)
    check("extension-pinned tab is unpinned when its pin is removed", (tab(p1) or {}).get("pinned") is False, json.dumps(tab(p1)))

    # --- トークンが無くなると PR の担当は外れる ---
    E("chrome.storage.local.set({ settings: { token: '' } })")
    time.sleep(1.5)
    check("PR binding is released once the token is gone", GH not in owned(), json.dumps(owned()))

    # --- トークン無しで設定を保存すると成功表示でメインに戻る ---
    E("showSettings()")
    E("document.querySelector('#in-pin-owned').checked = true; document.querySelector('#settings-form').requestSubmit()")
    time.sleep(2.5)
    check("saving settings without a token returns to main", E("!document.querySelector('#view-main').hidden"))

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:300])
finally:
    c.close()
print(f"\n{sum(oks)}/{len(oks)} passed")
