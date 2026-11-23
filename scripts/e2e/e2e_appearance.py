# 見た目 (テーマ・色味・アクセント色・背景画像) の E2E (使い捨てプロファイルのヘッドレス Chrome)
# 使い方: python3 scripts/e2e/e2e_appearance.py <拡張のディレクトリ>   (ネットワーク不要)
# OS のライト / ダークは Emulation.setEmulatedMedia で切り替え、画像は DOM.setFileInputFiles で実際に選ぶ。
import sys, time, json, os, re, struct, zlib, tempfile, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
ext = sys.argv[1]
oks = []
def check(name, cond, info=""):
    oks.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))

def write_png(path, w, h, row, level):
    """RGB の PNG を書く。row(y) は 1 行分 (w * 3 バイト)。level 0 なら圧縮しない (ファイルを大きくしたいとき)"""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\0" + row(y) for y in range(h))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, level)) + chunk(b"IEND", b""))
    return path

tmp = tempfile.mkdtemp(prefix="arcsp-e2e-img-", dir=os.environ.get("TMPDIR"))
SMALL = write_png(os.path.join(tmp, "small.png"), 32, 32, lambda y: bytes([y * 8 % 256, 120, 200]) * 32, 9)
# 1.5 MB を超える (圧縮しない) なめらかな画像: 縮めて WebP にする経路を通る
LARGE = write_png(os.path.join(tmp, "large.png"), 2800, 1800, lambda y: bytes([y % 256, 90, 160]) * 2800, 0)
NOT_IMAGE = os.path.join(tmp, "notes.txt")
open(NOT_IMAGE, "w").write("not an image")
BROKEN = os.path.join(tmp, "broken.png")  # 種類は image/png だが中身が画像ではない (Chrome が描けない TIFF・HEIC と同じ経路)
open(BROKEN, "w").write("not really a png")
def write_svg(path, w, h, pad):
    with open(path, "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><!-- {"x" * pad} --><rect width="{w}" height="{h}" fill="#3a7"/></svg>')
    return path
SMALL_SVG = write_svg(os.path.join(tmp, "small.svg"), 40, 20, 0)
LARGE_SVG = write_svg(os.path.join(tmp, "large.svg"), 3000, 1500, 1700 * 1024)  # 1.5 MB 超: createImageBitmap では読めない経路

c = Chrome(ext)
try:
    URL = f"chrome-extension://{c.ext_id}/sidepanel.html"
    tid_sp, sp = c.open(URL)
    c.send("Emulation.setDeviceMetricsOverride", {"width": 320, "height": 900, "deviceScaleFactor": 1, "mobile": False}, session=sp)
    media = lambda scheme, s=sp: c.send("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": scheme}]}, session=s)
    media("light")
    time.sleep(1.5)
    E = lambda expr, s=sp: c.eval(s, expr, timeout=60)
    scheme = lambda s=sp: E("document.documentElement.dataset.scheme || ''", s)
    accent_attr = lambda s=sp: E("document.documentElement.dataset.accent || ''", s)
    var = lambda name: E(f"getComputedStyle(document.documentElement).getPropertyValue('{name}').trim()")
    primary_bg = lambda: E("getComputedStyle(document.querySelector('button.primary')).backgroundColor")
    stored = lambda: E("chrome.storage.local.get('settings').then(r => r.settings || {})")
    stored_image = lambda: E("chrome.storage.local.get('backgroundImage').then(r => r.backgroundImage ?? null)")
    backdrop = lambda: E("(() => { const el = document.querySelector('#backdrop'), s = el.style; return { hidden: el.hidden, image: s.backgroundImage.slice(0, 30), opacity: s.opacity, position: s.backgroundPosition, repeat: s.backgroundRepeat, size: s.backgroundSize }; })()")
    def choose(sel, value):  # select の値を変えて change を送る (ユーザーの操作と同じ経路)
        E(f"(() => {{ const el = document.querySelector('{sel}'); el.value = {json.dumps(value)}; el.dispatchEvent(new Event('change', {{ bubbles: true }})); }})()")
        time.sleep(0.5)
    def pick_file(path):
        oid = c.send("Runtime.evaluate", {"expression": "document.querySelector('#in-bg-file')"}, session=sp)["result"]["objectId"]
        c.send("DOM.setFileInputFiles", {"files": [path], "objectId": oid}, session=sp)
    def wait(cond_expr, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            if E(cond_expr): return True
            time.sleep(0.2)
        return False

    # --- テーマ: 既定は自動。OS に従い、OS の切り替えにもその場で追従する ---
    check("auto theme follows a light OS", scheme() == "light" and var("--bg") == "#eef0f6", f"{scheme()} {var('--bg')}")
    check("the default accent adds no data-accent", accent_attr() == "")
    media("dark"); time.sleep(0.4)
    check("auto theme follows the OS switching to dark live", scheme() == "dark" and var("--bg") == "#1c1e26", f"{scheme()} {var('--bg')}")

    # --- 設定ボタンは下端のフッタバーにあり、GitHub セクションの頭には無い ---
    check("the settings gear lives in the footer bar, not the GitHub head",
          E("!!document.querySelector('.panel-foot #btn-settings')") and not E("document.querySelector('.github #btn-settings')"))
    E("document.querySelector('#btn-settings').click()"); time.sleep(0.3)
    check("the footer gear opens the settings view", not E("document.querySelector('#view-settings').hidden"))
    check("the footer hides with the main view", not E("document.querySelector('.panel-foot').checkVisibility()"))
    E("document.querySelector('#btn-back').click()"); time.sleep(0.3)
    check("back returns to the main view with the footer", E("document.querySelector('.panel-foot').checkVisibility()"))

    E("showSettings()"); time.sleep(0.3)
    check("the theme select lists auto / light / dark", E("[...document.querySelectorAll('#in-theme option')].map(o => o.value).join()") == "auto,light,dark")
    choose("#in-theme", "light")
    check("theme light wins over a dark OS", scheme() == "light" and var("--bg") == "#eef0f6", scheme())
    media("light"); time.sleep(0.4); media("dark"); time.sleep(0.4)
    check("theme light ignores the OS switching", scheme() == "light", scheme())
    check("the theme is saved right away (no Save click)", stored().get("theme") == "light", json.dumps(stored()))
    check("the theme is cached in localStorage for the next open", json.loads(E("localStorage.getItem('appearance')") or "{}").get("theme") == "light")
    media("light"); choose("#in-theme", "dark")
    check("theme dark wins over a light OS", scheme() == "dark" and var("--bg") == "#1c1e26", scheme())
    media("dark"); time.sleep(0.4); media("light"); time.sleep(0.4)
    check("theme dark ignores the OS switching", scheme() == "dark" and var("--bg") == "#1c1e26", scheme())

    # --- 開き直した直後 (storage を読む前) から前回のテーマになっている (ちらつかない) ---
    c.send("Page.enable", session=sp)
    c.send("Page.addScriptToEvaluateOnNewDocument", {"source": "document.addEventListener('DOMContentLoaded', () => { window.__schemeAtDcl = document.documentElement.dataset.scheme; }, { once: true });"}, session=sp)
    c.send("Page.reload", {}, session=sp); time.sleep(2)
    check("a reopened panel has the saved theme before settings load", E("window.__schemeAtDcl") == "dark" and scheme() == "dark", f"dcl={E('window.__schemeAtDcl')} now={scheme()}")
    E("showSettings()"); time.sleep(0.3)
    check("the settings show the saved theme", E("document.querySelector('#in-theme').value") == "dark")
    choose("#in-theme", "auto")
    check("back to auto follows the OS again", scheme() == "light", scheme())

    # --- アクセント色: 見本をクリックすると、ライト / ダークそれぞれの色になる ---
    check("seven accent swatches", E("document.querySelectorAll('#in-accent input[type=radio]').length") == 7)
    check("the default accent swatch is checked", E("document.querySelector('#in-accent input:checked')?.value") == "indigo")
    E("document.querySelector('#in-accent input[value=teal]').click()"); time.sleep(0.5)
    check("choosing teal sets data-accent", accent_attr() == "teal" and stored().get("accent") == "teal", accent_attr())
    check("teal is used for the accent in light", primary_bg() == "rgb(14, 143, 132)", primary_bg())
    media("dark"); time.sleep(0.3)
    check("teal has its dark value in dark", primary_bg() == "rgb(31, 165, 150)", primary_bg())
    E("document.querySelector('#in-accent input[value=indigo]').click()"); time.sleep(0.5)
    check("back to the default accent removes data-accent", accent_attr() == "" and primary_bg() == "rgb(124, 138, 255)", f"{accent_attr()} {primary_bg()}")
    media("light"); time.sleep(0.3)

    # --- カラーテーマ (サイドバーの色味): 面の色が一式で変わる。アクセント色 (強調) とは独立 ---
    tint_attr = lambda s=sp: E("document.documentElement.dataset.tint || ''", s)
    check("seven tint swatches", E("document.querySelectorAll('#in-tint input[type=radio]').length") == 7)
    check("the default tint is neutral with no data-tint", E("document.querySelector('#in-tint input:checked')?.value") == "neutral" and tint_attr() == "", tint_attr())
    E("document.querySelector('#in-tint input[value=sakura]').click()"); time.sleep(0.5)
    check("choosing sakura sets data-tint and saves right away", tint_attr() == "sakura" and stored().get("tint") == "sakura", tint_attr())
    check("sakura repaints the surfaces in light",
          all(v != d for v, d in [(var("--bg"), "#eef0f6"), (var("--fg"), "#1f2330"), (var("--muted"), "#6b7280"),
                                  (var("--tile"), "rgba(255, 255, 255, 0.85)"), (var("--border"), "rgba(0, 0, 0, 0.06)")]),
          json.dumps([var("--bg"), var("--fg"), var("--muted"), var("--tile"), var("--border")]))
    check("the accent stays indigo under a tint", primary_bg() == "rgb(91, 108, 255)", primary_bg())
    check("the tint is cached in localStorage for the next open", json.loads(E("localStorage.getItem('appearance')") or "{}").get("tint") == "sakura")
    sakura_light_bg = var("--bg")
    media("dark"); time.sleep(0.3)
    check("sakura has its dark palette in dark", var("--bg") != sakura_light_bg and var("--bg") != "#1c1e26" and var("--fg") != "#e6e8ef", f"{var('--bg')} {var('--fg')}")
    media("light"); time.sleep(0.3)

    # --- どの色味でも、ライト / ダークとも本文と補足文字が読めるコントラストを保つ (WCAG 相当) ---
    def lum(rgb):
        vals = [float(x) / 255 for x in re.search(r"rgba?\(([^)]*)\)", rgb).group(1).split(",")[:3]]
        f = lambda ch: ch / 12.92 if ch <= 0.04045 else ((ch + 0.055) / 1.055) ** 2.4
        r, g, b = (f(ch) for ch in vals)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    def contrast(a, b):
        hi, lo = sorted((lum(a), lum(b)), reverse=True)
        return (hi + 0.05) / (lo + 0.05)
    def rgba_of(color):  # "rgb(...)" / "rgba(...)" -> ([r,g,b], alpha)
        v = [float(x) for x in re.search(r"rgba?\(([^)]*)\)", color).group(1).split(",")[:4]]
        return v[:3], (v[3] if len(v) > 3 else 1.0)
    def over(top, base):  # 半透明色 top を不透明色 base に重ねたときの見た目色
        (r, g, b), a = top
        return [a * x + (1 - a) * y for x, y in zip((r, g, b), base)]
    def as_rgb(rgb):  # contrast() は文字列を読むので整数へ丸めて戻す
        return "rgb(%d, %d, %d)" % tuple(round(x) for x in rgb)
    body_fg = lambda: E("getComputedStyle(document.body).color")
    body_bg = lambda: E("getComputedStyle(document.body).backgroundColor")
    muted_fg = lambda: E("getComputedStyle(document.querySelector('.muted')).color")
    count_fg = lambda: E("getComputedStyle(document.querySelector('.count')).color")
    count_bg = lambda: E("getComputedStyle(document.querySelector('.count')).backgroundColor")
    grad_stops = lambda: re.findall(r"rgba?\([^)]*\)", E("getComputedStyle(document.body).backgroundImage"))
    for tname in ["sakura", "amber", "matcha", "sora", "fuji", "grape"]:
        E(f"document.querySelector('#in-tint input[value={tname}]').click()"); time.sleep(0.4)
        for scheme_name in ["light", "dark"]:
            media(scheme_name); time.sleep(0.3)
            fg_c, muted_c = contrast(body_fg(), body_bg()), contrast(muted_fg(), body_bg())
            check(f"{tname} stays readable in {scheme_name}", fg_c >= 4.5 and muted_c >= 4.0, f"fg={fg_c:.2f} muted={muted_c:.2f}")
            # .count は hover した .folder-head の面 (--tile) の上に自分の面 (--tile) をさらに重ねる。
            # グラデーションのどの位置にあっても読めるよう、両端のストップで測る
            count_c = min(contrast(count_fg(), as_rgb(over(rgba_of(count_bg()), over(rgba_of(count_bg()), rgba_of(stop)[0])))) for stop in grad_stops())
            check(f"{tname} keeps the count readable on a hovered folder head in {scheme_name}", count_c >= 4.0, f"count={count_c:.2f}")
    media("light"); time.sleep(0.3)
    E("document.querySelector('#in-tint input[value=neutral]').click()"); time.sleep(0.5)
    check("back to neutral removes data-tint and restores the surfaces", tint_attr() == "" and var("--bg") == "#eef0f6" and var("--fg") == "#1f2330", f"{tint_attr()} {var('--bg')}")
    check("neutral keeps the tint key stored as the default", stored().get("tint") == "neutral", json.dumps(stored().get("tint")))

    # --- 背景の質感 (ノイズ): 既定は on、チェックを外すと層ごと消える ---
    noise_attr = lambda: E("document.documentElement.dataset.noise || ''")
    noise_content = lambda: E("getComputedStyle(document.body, '::before').content")
    check("noise is on by default", noise_attr() == "" and noise_content() != "none" and E("document.querySelector('#in-bg-noise').checked"))
    E("document.querySelector('#in-bg-noise').click()"); time.sleep(0.5)
    check("unchecking removes the noise layer", noise_attr() == "off" and noise_content() == "none" and stored().get("bgNoise") == False, f"{noise_attr()} {noise_content()}")
    E("document.querySelector('#in-bg-noise').click()"); time.sleep(0.5)
    check("checking restores the noise layer", noise_attr() == "" and noise_content() != "none" and stored().get("bgNoise") == True, noise_attr())

    # --- 背景画像: 小さい画像はそのまま保存し、既定の見た目で敷く ---
    check("no image: the image options are hidden", E("document.querySelector('#bg-options').hidden") and backdrop()["hidden"])
    pick_file(SMALL)
    check("a small image is stored as is", wait("chrome.storage.local.get('backgroundImage').then(r => (r.backgroundImage || '').startsWith('data:image/png'))"))
    b = backdrop()
    check("the backdrop shows the image with the defaults (60% transparent, centered, no repeat, cover)",
          not b["hidden"] and "data:image/png" in b["image"] and b["opacity"] == "0.4" and b["position"] == "center center" and b["repeat"] == "no-repeat" and b["size"] == "cover", json.dumps(b))
    check("the image options and thumbnail appear", not E("document.querySelector('#bg-options').hidden") and not E("document.querySelector('#bg-thumb').hidden"))

    # --- 透明度: 動かしている間は見た目だけ、離したら保存 ---
    E("(() => { const r = document.querySelector('#in-bg-transparency'); r.value = '20'; r.dispatchEvent(new Event('input', { bubbles: true })); })()"); time.sleep(0.3)
    check("dragging the slider previews without saving", backdrop()["opacity"] == "0.8" and stored().get("bgTransparency") == 60 and E("document.querySelector('#out-bg-transparency').value") == "20%", f"{backdrop()['opacity']} {stored().get('bgTransparency')}")
    E("document.querySelector('#in-bg-transparency').dispatchEvent(new Event('change', { bubbles: true }))"); time.sleep(0.5)
    check("releasing the slider saves the transparency", stored().get("bgTransparency") == 20)

    # --- 寄せ・繰り返し・大きさ ---
    check("nine alignment cells, center checked", E("document.querySelectorAll('#in-bg-position input').length") == 9 and E("document.querySelector('#in-bg-position input:checked').value") == "center center")
    E("document.querySelector('#in-bg-position input[value=\"right bottom\"]').click()"); time.sleep(0.5)
    check("alignment right-bottom", backdrop()["position"] == "right bottom" and stored().get("bgPosition") == "right bottom", backdrop()["position"])
    choose("#in-bg-repeat", "repeat-x")
    check("repeat horizontally", backdrop()["repeat"] == "repeat-x" and stored().get("bgRepeat") == "repeat-x", backdrop()["repeat"])
    choose("#in-bg-size", "width")
    check("size: fit the width", backdrop()["size"] == "100% auto" and stored().get("bgSize") == "width", backdrop()["size"])
    choose("#in-bg-size", "auto")
    check("size: original", backdrop()["size"] == "auto", backdrop()["size"])

    # --- 大きい画像は長辺 2560px の WebP に縮めて保存する ---
    pick_file(LARGE)
    check("a large image is shrunk to WebP", wait("chrome.storage.local.get('backgroundImage').then(r => (r.backgroundImage || '').startsWith('data:image/webp'))", 40))
    dims = E("chrome.storage.local.get('backgroundImage').then(r => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res(null); i.src = r.backgroundImage; }))")
    check("the shrunk image's long edge is 2560px", dims == [2560, 1646], json.dumps(dims))
    check("the backdrop switches to the new image", "data:image/webp" in backdrop()["image"])

    # --- 画像でないファイルは断り、前の画像を残す ---
    before = stored_image()
    pick_file(NOT_IMAGE)
    check("a non-image file shows an error", wait("!document.querySelector('#bg-status').hidden") and E("document.querySelector('#bg-status').textContent") == E("t('errBgNotImage')"))
    check("a non-image file keeps the previous image", stored_image() == before)
    danger = E("(() => { const d = document.createElement('span'); d.style.color = 'var(--danger)'; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; })()")
    check("the error is shown in the danger colour", E("getComputedStyle(document.querySelector('#bg-status')).color") == danger, danger)
    E("document.querySelector('#bg-status').hidden = true")
    pick_file(BROKEN)
    check("a small file Chrome cannot draw shows an error", wait("!document.querySelector('#bg-status').hidden") and E("document.querySelector('#bg-status').textContent") == E("t('errBgLoadFailed')"))
    check("a small file Chrome cannot draw keeps the previous image", stored_image() == before)

    # --- SVG: 小さいものはそのまま、1.5 MB を超えるものは WebP に縮める ---
    pick_file(SMALL_SVG)
    check("a small SVG is stored as is", wait("chrome.storage.local.get('backgroundImage').then(r => (r.backgroundImage || '').startsWith('data:image/svg+xml'))"))
    pick_file(LARGE_SVG)
    check("a large SVG is shrunk to WebP", wait("chrome.storage.local.get('backgroundImage').then(r => (r.backgroundImage || '').startsWith('data:image/webp'))", 40), E("document.querySelector('#bg-status').textContent"))
    dims = E("chrome.storage.local.get('backgroundImage').then(r => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res(null); i.src = r.backgroundImage; }))")
    check("the shrunk SVG's long edge is 2560px", dims == [2560, 1280], json.dumps(dims))

    # --- 設定画面は 320px でも横にはみ出さない ---
    sw = E("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    check("the settings with the image options do not scroll sideways", sw[0] <= sw[1], f"scrollWidth={sw[0]} clientWidth={sw[1]}")

    # --- 別のパネル (別ウィンドウ) にも追従する ---
    tid2, sp2 = c.open(URL)
    media("light", sp2); time.sleep(1.5)
    check("another panel starts with the same image and alignment", E("document.querySelector('#backdrop').style.backgroundPosition", sp2) == "right bottom" and not E("document.querySelector('#backdrop').hidden", sp2))
    saved_max = stored().get("maxPins")
    unsaved_max = next(v for v in ["12", "16", "20", "24"] if v != str(saved_max))
    choose("#in-maxpins", unsaved_max)
    E("document.querySelector('#in-accent input[value=orange]').click()"); time.sleep(0.8)
    check("another panel follows an accent change", accent_attr(sp2) == "orange", accent_attr(sp2))
    E("document.querySelector('#in-tint input[value=grape]').click()"); time.sleep(0.8)
    check("another panel follows a tint change", tint_attr(sp2) == "grape", tint_attr(sp2))
    shown_max = E("document.querySelector('#in-maxpins').value")
    check("an accent change keeps the unsaved favorites limit", shown_max == unsaved_max and stored().get("maxPins") == saved_max, f"shown={shown_max} stored={stored().get('maxPins')}")

    # --- 外す ---
    E("document.querySelector('#btn-bg-clear').click()"); time.sleep(0.8)
    check("removing deletes the stored image", stored_image() is None)
    check("removing hides the backdrop and the options", backdrop()["hidden"] and E("document.querySelector('#bg-options').hidden"))
    check("another panel drops the image too", E("document.querySelector('#backdrop').hidden", sp2))

    # --- 見た目だけの変更では background が GitHub を取り直さない (トークン無しでも取得のたびに github を書く) ---
    E("window.__ghWrites = 0; chrome.storage.onChanged.addListener((c, a) => { if (a === 'local' && c.github) window.__ghWrites++; }); 0")
    choose("#in-theme", "dark"); choose("#in-theme", "auto")
    E("(() => { const r = document.querySelector('#in-bg-transparency'); r.value = '25'; r.dispatchEvent(new Event('change', { bubbles: true })); })()")
    time.sleep(1.5)
    check("appearance-only changes do not refetch GitHub", E("window.__ghWrites") == 0, E("window.__ghWrites"))

    # --- 保存ボタン (他の設定の保存) で見た目の値が消えない ---
    E("document.querySelector('#settings-form').requestSubmit()"); time.sleep(2)
    s = stored()
    check("saving the form keeps the appearance settings", s.get("accent") == "orange" and s.get("tint") == "grape" and s.get("theme") == "auto" and s.get("bgPosition") == "right bottom" and s.get("bgTransparency") == 25, json.dumps(s))
    check("saving the form stores the favorites limit chosen before the accent change", s.get("maxPins") == int(unsaved_max), json.dumps(s.get("maxPins")))
    check("saving the form still refetches GitHub", E("window.__ghWrites") > 0, E("window.__ghWrites"))

    # --- 壊れた値は既定に戻す ---
    E("chrome.storage.local.get('settings').then(r => chrome.storage.local.set({ settings: { ...r.settings, theme: 'neon', tint: 'neon', accent: 'x', bgTransparency: 'abc', bgPosition: 'nowhere', bgRepeat: 1, bgSize: null, bgNoise: 'loud' } }))"); time.sleep(0.8)
    check("broken values fall back to the defaults", scheme() == "light" and accent_attr() == "" and tint_attr() == "", f"{scheme()} {accent_attr()} {tint_attr()}")
    E("showSettings()"); time.sleep(0.3)
    check("the settings show the defaults for broken values", E("[document.querySelector('#in-theme').value, document.querySelector('#in-tint input:checked')?.value, document.querySelector('#in-bg-transparency').value, document.querySelector('#in-bg-size').value, document.querySelector('#in-bg-noise').checked].join()") == "auto,neutral,60,cover,true")

    exc = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    check("no uncaught exceptions", not exc, json.dumps(exc[:1])[:300])
finally:
    c.close()
    shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{sum(oks)}/{len(oks)} passed")
sys.exit(0 if all(oks) else 1)
