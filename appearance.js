// 見た目: テーマ (ライト / ダーク)、色味 (カラーテーマ)、アクセント色、背景画像。
// <head> で読み込み、最初の描画より前に <html> の data-scheme / data-tint / data-accent を付ける。設定は storage にあって読むのが
// 非同期なので、前回の値を localStorage に控えておき、パネルを開いたときのちらつきを防ぐ (控えが無ければ OS に従う)。
// このファイルのトップレベルは他のファイルより先に動くので、トップレベルでは他のファイルの関数や変数に触れない。

const THEMES = [["auto", "themeAuto"], ["light", "themeLight"], ["dark", "themeDark"]];
// サイドバー全体の色味 (カラーテーマ)。Arc のスペース色相当。面の色の値は sidepanel.css の
// :root[data-tint] (ライト) と :root[data-scheme="dark"][data-tint] (ダーク) にだけ書く。先頭が既定 (無彩色)
const TINTS = [
  ["neutral", "tintNeutral"], ["sakura", "tintSakura"], ["amber", "tintAmber"], ["matcha", "tintMatcha"],
  ["sora", "tintSora"], ["fuji", "tintFuji"], ["grape", "tintGrape"],
];
// アクセント色。色の値は sidepanel.css の --accent-<id> (ライトとダークで別の値) にだけ書く。先頭が既定
const ACCENTS = [
  ["indigo", "accentIndigo"], ["blue", "accentBlue"], ["teal", "accentTeal"], ["purple", "accentPurple"],
  ["pink", "accentPink"], ["orange", "accentOrange"], ["graphite", "accentGraphite"],
];
// 背景画像の寄せ (background-position の値)。3x3 のマスに左上から並べる
const BG_POSITIONS = [
  ["left top", "bgPosTopLeft"], ["center top", "bgPosTop"], ["right top", "bgPosTopRight"],
  ["left center", "bgPosLeft"], ["center center", "bgPosCenter"], ["right center", "bgPosRight"],
  ["left bottom", "bgPosBottomLeft"], ["center bottom", "bgPosBottom"], ["right bottom", "bgPosBottomRight"],
];
const BG_REPEATS = [["no-repeat", "bgRepeatNone"], ["repeat", "bgRepeatBoth"], ["repeat-x", "bgRepeatX"], ["repeat-y", "bgRepeatY"]];
// 大きさ: 設定の値 → background-size
const BG_SIZES = [["cover", "bgSizeCover", "cover"], ["width", "bgSizeWidth", "100% auto"], ["auto", "bgSizeAuto", "auto"]];
// 「原寸」の拡大率 (%) の範囲。繰り返しの有無にかかわらず効く
const BG_SCALE_MIN = 10;
const BG_SCALE_MAX = 400;

const BG_KEEP_BYTES = 1.5 * 1024 * 1024; // これ以下の画像はそのまま保存する (GIF のアニメ、SVG、ドット絵を崩さない)
const BG_MAX_EDGE = 2560;                // 大きい画像は長辺をここまで縮め、WebP にして保存する
const BG_MAX_BYTES = 3 * 1024 * 1024;    // 縮めてもこれを超える画像は断る (storage.local は 10 MB で、アイコンと共有)
const APPEARANCE_CACHE_KEY = "appearance";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

let shownTheme = "auto";      // いま反映しているテーマ (auto なら OS の切り替えに追従する)
let shownAccent = ACCENTS[0][0];
let backdropImage = "";       // 背景画像 (data URL)。storage.local の backgroundImage
let backdropWidth = 0;        // その幅 (px)。「原寸」の拡大率の計算に使う。測れない・無いときは 0

const ids = (list) => list.map(([id]) => id);
const oneOf = (value, list) => (ids(list).includes(value) ? value : list[0][0]);

// 保存された設定から見た目の値を取り出す。壊れた値や古い値は既定に戻す
function appearanceOf(s) {
  const tr = Number(s.bgTransparency);
  const sc = Number(s.bgScale);
  return {
    theme: oneOf(s.theme, THEMES),
    tint: oneOf(s.tint, TINTS),
    accent: oneOf(s.accent, ACCENTS),
    bgNoise: s.bgNoise !== false, // 既定は on (false だけオフ)
    bgTransparency: Number.isFinite(tr) ? Math.min(100, Math.max(0, tr)) : 60,
    bgScale: Number.isFinite(sc) ? Math.min(BG_SCALE_MAX, Math.max(BG_SCALE_MIN, sc)) : 100,
    bgPosition: ids(BG_POSITIONS).includes(s.bgPosition) ? s.bgPosition : "center center",
    bgRepeat: oneOf(s.bgRepeat, BG_REPEATS),
    bgSize: oneOf(s.bgSize, BG_SIZES),
  };
}

function resolvedScheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return darkQuery.matches ? "dark" : "light";
}

function applyTheme(theme, accent) {
  shownTheme = theme;
  shownAccent = accent;
  const root = document.documentElement;
  root.dataset.scheme = resolvedScheme(theme);
  if (accent === ACCENTS[0][0]) delete root.dataset.accent;
  else root.dataset.accent = accent;
}

// 面の色味 (body のグラデーション・タイル・文字のトーン)。既定 (neutral) は属性を付けない
// (icons.js にもタイルのアイコン色を付ける applyTint があるので別名にする)
function applyColorTheme(tint) {
  const root = document.documentElement;
  if (tint === TINTS[0][0]) delete root.dataset.tint;
  else root.dataset.tint = tint;
}

// 背景の質感 (body::before のノイズ層)。オフのときだけ data-noise を付ける
function applyNoise(on) {
  const root = document.documentElement;
  if (on) delete root.dataset.noise;
  else root.dataset.noise = "off";
}

function cachedAppearance() {
  try { return appearanceOf(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) || "{}")); }
  catch { return appearanceOf({}); } // 控えが壊れている・読めないときは OS に従う
}

// 設定の見た目をパネルに反映し、次に開いたとき用に控える
function applyAppearance(s) {
  const a = appearanceOf(s);
  applyTheme(a.theme, a.accent);
  applyColorTheme(a.tint);
  applyNoise(a.bgNoise);
  try { localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ theme: a.theme, tint: a.tint, accent: a.accent, bgNoise: a.bgNoise })); }
  catch { /* 控えられなくても、次に開いたとき一瞬 OS の配色になるだけ */ }
  applyBackdrop(a);
}

function applyBackdrop(a) {
  const el = document.getElementById("backdrop");
  if (!el) return;
  el.hidden = !backdropImage;
  el.style.backgroundImage = backdropImage ? `url("${backdropImage}")` : "";
  el.style.opacity = String(1 - a.bgTransparency / 100);
  el.style.backgroundPosition = a.bgPosition;
  el.style.backgroundRepeat = a.bgRepeat;
  el.style.backgroundSize = bgSizeValue(a);
}

// 大きさの設定値 → background-size の値。「原寸」は拡大率を掛けたピクセル幅にする
// (background-size には内在サイズの割合を書けないので、画像の幅を測って計算する)
function bgSizeValue(a) {
  if (a.bgSize === "auto" && a.bgScale !== 100 && backdropWidth)
    return `${Math.max(1, Math.round(backdropWidth * a.bgScale / 100))}px auto`; // 小さい画像を小さい率にしても 0px にはしない
  return BG_SIZES.find(([id]) => id === a.bgSize)[2];
}

// 画像の内在サイズの幅。大きさを持たない SVG や壊れた画像は 0 (拡大率は効かず原寸のまま)
async function measuredWidth(src) {
  if (!src) return 0;
  try { return (await decodedImage(src)).naturalWidth || 0; }
  catch { return 0; }
}

async function loadBackdropImage() {
  const { backgroundImage } = await chrome.storage.local.get("backgroundImage");
  backdropImage = typeof backgroundImage === "string" ? backgroundImage : "";
  backdropWidth = await measuredWidth(backdropImage);
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// <img> で読めるか確かめる。Chrome が描けない形式 (TIFF・HEIC) や壊れたファイルは、大きさにかかわらずここで断る。
// createImageBitmap は SVG の Blob を読めないので使わない
async function decodedImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => { throw new Error("errBgLoadFailed"); });
  return img;
}

// 長辺 BG_MAX_EDGE の WebP に縮める
async function shrunkDataUrl(img) {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) throw new Error("errBgLoadFailed"); // 大きさを持たない SVG は縮められない
  const scale = Math.min(1, BG_MAX_EDGE / Math.max(w, h));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  if (blob.size > BG_MAX_BYTES) throw new Error("errBgTooLarge");
  return blobDataUrl(blob);
}

// 選んだファイルを保存用の data URL にする。失敗の理由は Error の message (翻訳キー) で返す
async function backgroundDataUrl(file) {
  if (!file.type.startsWith("image/")) throw new Error("errBgNotImage");
  const url = URL.createObjectURL(file);
  try {
    const img = await decodedImage(url);
    return await (file.size <= BG_KEEP_BYTES ? blobDataUrl(file) : shrunkDataUrl(img));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 設定画面の「見た目」 ----------
// 見た目はその場で反映して保存する (保存ボタンを待たない)。他の項目の未保存の入力には触れない
let appearanceWrites = Promise.resolve();
function saveAppearance(patch) {
  settings = { ...settings, ...patch };
  applyAppearance(settings);
  // 書き込みは直列にする (前の書き込みの失敗は次の書き込みを止めない)
  appearanceWrites = appearanceWrites.catch(() => {}).then(async () => {
    const { settings: stored } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(stored || {}), ...patch } });
  });
  return appearanceWrites;
}

function fillSelect(sel, list) {
  sel.replaceChildren(...list.map(([value, label]) => Object.assign(document.createElement("option"), { value, textContent: t(label) })));
}

function radioGroup(container, name, list, className, decorate) {
  container.replaceChildren(...list.map(([value, label]) => {
    const input = Object.assign(document.createElement("input"), { type: "radio", name, value, className, title: t(label) });
    input.setAttribute("aria-label", t(label));
    decorate?.(input, value);
    return input;
  }));
}

function showBgStatus(key) {
  const el = $("#bg-status");
  el.hidden = !key;
  el.textContent = key ? t(key) : "";
}

// 設定画面を開いたときと、別のパネルが見た目を変えたときに、入力欄を今の設定に合わせる
function syncAppearanceControls() {
  const a = appearanceOf(settings);
  $("#in-theme").value = a.theme;
  document.querySelectorAll('input[name="tint"]').forEach((r) => { r.checked = r.value === a.tint; });
  document.querySelectorAll('input[name="accent"]').forEach((r) => { r.checked = r.value === a.accent; });
  $("#in-bg-transparency").value = String(a.bgTransparency);
  $("#out-bg-transparency").value = `${a.bgTransparency}%`;
  document.querySelectorAll('input[name="bg-position"]').forEach((r) => { r.checked = r.value === a.bgPosition; });
  $("#in-bg-repeat").value = a.bgRepeat;
  $("#in-bg-size").value = a.bgSize;
  $("#in-bg-scale").value = String(a.bgScale);
  $("#out-bg-scale").value = `${a.bgScale}%`;
  $("#in-bg-scale").disabled = a.bgSize !== "auto"; // 「全体を覆う」「幅に合わせる」とは意味が重なるので効かない
  $("#in-bg-noise").checked = a.bgNoise;
  $("#bg-options").hidden = !backdropImage;
  $("#btn-bg-clear").hidden = !backdropImage;
  $("#bg-thumb").hidden = !backdropImage;
  $("#bg-thumb").style.backgroundImage = backdropImage ? `url("${backdropImage}")` : "";
}

// 失敗の理由 → 表示する文言のキー。backgroundDataUrl が投げたキーはそのまま、容量超過 (storage.local の quota) は専用の文言
function bgErrorKey(err) {
  const message = String(err?.message || "");
  if (message.startsWith("errBg")) return message;
  if (/quota/i.test(message)) return "errBgStorageFull";
  return "errBgLoadFailed";
}

async function onBackgroundChosen(e) {
  const file = e.target.files?.[0];
  e.target.value = ""; // 同じファイルを選び直しても change が来るように
  if (!file) return;
  showBgStatus("");
  try {
    const dataUrl = await backgroundDataUrl(file);
    await chrome.storage.local.set({ backgroundImage: dataUrl });
    backdropImage = dataUrl;
    backdropWidth = await measuredWidth(dataUrl); // 保存した (縮めた後の) 画像の幅が拡大率の基準
  } catch (err) {
    showBgStatus(bgErrorKey(err));
    return;
  }
  applyAppearance(settings);
  syncAppearanceControls();
}

async function clearBackground() {
  await chrome.storage.local.remove("backgroundImage");
  backdropImage = "";
  backdropWidth = 0;
  showBgStatus("");
  applyAppearance(settings);
  syncAppearanceControls();
}

function setupAppearanceSettings() {
  fillSelect($("#in-theme"), THEMES);
  fillSelect($("#in-bg-repeat"), BG_REPEATS);
  fillSelect($("#in-bg-size"), BG_SIZES);
  radioGroup($("#in-tint"), "tint", TINTS, "tint-swatch", (input, id) => input.style.setProperty("--swatch", `var(--chip-${id})`));
  radioGroup($("#in-accent"), "accent", ACCENTS, "swatch", (input, id) => input.style.setProperty("--swatch", `var(--accent-${id})`));
  radioGroup($("#in-bg-position"), "bg-position", BG_POSITIONS, "position-cell");

  $("#in-theme").addEventListener("change", (e) => saveAppearance({ theme: e.target.value }));
  $("#in-tint").addEventListener("change", (e) => saveAppearance({ tint: e.target.value }));
  $("#in-accent").addEventListener("change", (e) => saveAppearance({ accent: e.target.value }));
  $("#in-bg-position").addEventListener("change", (e) => saveAppearance({ bgPosition: e.target.value }));
  $("#in-bg-repeat").addEventListener("change", (e) => saveAppearance({ bgRepeat: e.target.value }));
  $("#in-bg-size").addEventListener("change", (e) => {
    saveAppearance({ bgSize: e.target.value });
    $("#in-bg-scale").disabled = e.target.value !== "auto"; // 保存の往復を待たず、効く・効かないをすぐ反映する
  });
  $("#in-bg-noise").addEventListener("change", (e) => saveAppearance({ bgNoise: e.target.checked }));
  // スライダーは動かしている間は見た目だけ変え、離したときに保存する
  const range = $("#in-bg-transparency");
  range.addEventListener("input", () => {
    $("#out-bg-transparency").value = `${range.value}%`;
    applyBackdrop(appearanceOf({ ...settings, bgTransparency: range.value }));
  });
  range.addEventListener("change", () => saveAppearance({ bgTransparency: Number(range.value) }));
  const scale = $("#in-bg-scale");
  scale.addEventListener("input", () => {
    $("#out-bg-scale").value = `${scale.value}%`;
    applyBackdrop(appearanceOf({ ...settings, bgScale: scale.value }));
  });
  scale.addEventListener("change", () => saveAppearance({ bgScale: Number(scale.value) }));

  $("#btn-bg-pick").addEventListener("click", () => $("#in-bg-file").click());
  $("#in-bg-file").addEventListener("change", onBackgroundChosen);
  $("#btn-bg-clear").addEventListener("click", clearBackground);
  darkQuery.addEventListener("change", () => applyTheme(shownTheme, shownAccent));
}

// 最初の描画より前に、前回の配色を付ける
{
  const cached = cachedAppearance();
  applyTheme(cached.theme, cached.accent);
  applyColorTheme(cached.tint);
  applyNoise(cached.bgNoise);
}
