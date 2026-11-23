# settings の chrome.storage.sync 移行の E2E (使い捨てプロファイルのヘッドレス Chrome、ネットワーク不要)
# 使い方: python3 scripts/e2e/e2e_settings_sync.py <拡張のディレクトリ>
# settings は chrome.storage.sync (端末間で同期)。token だけは同期しないので、storage.local の githubToken に置く。
# 旧版の local.settings からの一度きりの移行は migrateSettings() (loadSettings / getSettings から走る)。
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
    sync_settings = lambda: E("chrome.storage.sync.get('settings').then(r => r.settings ?? null)")
    local_settings = lambda: E("chrome.storage.local.get('settings').then(r => r.settings ?? null)")
    local_token = lambda: E("chrome.storage.local.get('githubToken').then(r => r.githubToken ?? null)")

    # --- 新規プロファイル: local.settings は無く、sync.settings にも token は置かれない ---
    check("fresh profile has no leftover local settings", local_settings() is None, json.dumps(local_settings()))
    check("fresh profile does not put a token in sync", "token" not in (sync_settings() or {}), json.dumps(sync_settings()))

    # --- 旧版の local.settings だけある → sync へ seed (token 抜き)、local は消す ---
    E("chrome.storage.local.set({ settings: { host: 'ghe.example.co.jp', token: 'secret-pat', "
      "intervalMin: 15, showMine: false, theme: 'dark', accent: 'teal', bgTransparency: 25 } })")
    E("migrateSettings()")  # 実際の起動では loadSettings / getSettings から走る
    time.sleep(0.5)
    s = sync_settings()
    check("local-only settings are seeded to sync",
          s is not None and s.get("host") == "ghe.example.co.jp" and s.get("intervalMin") == 15
          and s.get("theme") == "dark" and s.get("accent") == "teal", json.dumps(s))
    check("the token is not seeded to sync", "token" not in (s or {}), json.dumps(s))
    check("the token moves to the local githubToken key", local_token() == "secret-pat", local_token())
    check("local settings is removed after migration", local_settings() is None)
    check("the panel picks up the migrated settings",
          E("settings.theme") == "dark" and E("settings.token") == "secret-pat",
          f"theme={E('settings.theme')} token={E('settings.token')}")

    # --- local と sync の両方ある → sync を正とする。local.settings は消す ---
    E("chrome.storage.sync.set({ settings: { theme: 'light', maxPins: 24 } })")
    E("chrome.storage.local.set({ settings: { theme: 'dark', intervalMin: 1, token: 'other-pat' } })")
    E("migrateSettings()")
    time.sleep(0.5)
    s = sync_settings()
    check("sync wins when both areas have settings",
          s.get("theme") == "light" and s.get("maxPins") == 24 and "intervalMin" not in s and "token" not in s,
          json.dumps(s))
    check("local settings is removed even when sync wins", local_settings() is None)
    check("an existing githubToken is not overwritten", local_token() == "secret-pat", local_token())

    # --- githubToken が無いなら、sync があっても旧トークンはこの端末に残す ---
    E("chrome.storage.local.remove('githubToken')")
    E("chrome.storage.local.set({ settings: { token: 'rescued-pat' } })")
    E("migrateSettings()")
    time.sleep(0.5)
    check("a legacy token is rescued even when sync already has settings", local_token() == "rescued-pat", local_token())
    check("local settings is removed", local_settings() is None)

    # --- 設定フォームの保存は sync に書き、token は local.githubToken だけに ---
    E("showSettings()")
    E("document.querySelector('#in-token').value = 'form-pat'; document.querySelector('#in-maxpins').value = '24'")
    E("document.querySelector('#settings-form').requestSubmit()")
    time.sleep(1)
    s = sync_settings()
    check("saving the form writes settings to sync", s is not None and s.get("maxPins") == 24 and "token" not in s, json.dumps(s))
    check("saving the form writes the token only to local githubToken", local_token() == "form-pat", local_token())
    check("local settings stays absent", local_settings() is None)

    # --- 見た目の変更も sync 領域に行く (token は書かれない) ---
    E("saveAppearance({ theme: 'dark' })")
    time.sleep(0.5)
    s = sync_settings()
    check("appearance changes write to sync", s.get("theme") == "dark" and "token" not in s, json.dumps(s))

    # --- 同じプロファイルの 2 枚目のパネルも sync の設定と local のトークンを拾う ---
    tid2, sp2 = c.open(f"chrome-extension://{c.ext_id}/sidepanel.html")
    time.sleep(1.2)
    E2 = lambda expr: c.eval(sp2, expr, timeout=60)
    check("a second panel loads sync settings and the local token",
          E2("settings.theme") == "dark" and E2("settings.token") == "form-pat" and E2("settings.maxPins") == 24,
          f"theme={E2('settings.theme')} token={E2('settings.token')} maxPins={E2('settings.maxPins')}")
    c.send("Target.closeTarget", {"targetId": tid2})

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:300])
finally:
    c.close()
print(f"\n{sum(oks)}/{len(oks)} passed")
sys.exit(0 if all(oks) else 1)
