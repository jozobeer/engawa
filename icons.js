// ピン (と Arc インポート候補) のアイコン管理。sidepanel.js より前に読み込む。
//
// Chrome 内蔵の _favicon は「Chrome で開いたことがあるページ」の本物のアイコンしか返さず、
// それ以外には既定の地球儀アイコンを返す。また <img> は同じ URL の画像をキャッシュするので、
// 後から Chrome がアイコンを覚えても表示が更新されない。そこで:
//  - 本物のアイコンが取れた時点で data URL にして chrome.storage.local の "icons" に URL ごとに保存し、以後はそれを使う
//  - 既定アイコンかどうかは、存在しないページの _favicon とバイト列を比べて判定する
//  - 本物が無いあいだは地球儀ではなく、サイト名の頭文字のタイルを出す
//  - Arc から取り込んだアイコンも同じ場所に保存する

const ICON_FETCH_SIZE = 64;
let iconStore = {};            // { [pageUrl]: dataUrl }
let defaultIconBytes = null;   // Promise<Uint8Array|null>  既定アイコン (比較用)
const iconProbes = new Map();  // pageUrl -> Promise<string|null|undefined>  (同じページへの問い合わせをまとめる)

function faviconUrl(url, size = ICON_FETCH_SIZE) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", String(size));
  return u.href;
}

async function loadIconStore() {
  const { icons } = await chrome.storage.local.get("icons");
  iconStore = icons || {};
}

async function fetchFaviconBytes(pageUrl) {
  const res = await fetch(faviconUrl(pageUrl), { cache: "no-store" });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

function getDefaultIconBytes() {
  if (!defaultIconBytes) {
    defaultIconBytes = fetchFaviconBytes("https://no-favicon.invalid/").catch(() => null);
  }
  return defaultIconBytes;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToDataUrl(bytes, type = "image/png") {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

// pageUrl について Chrome が本物のアイコンを持っていれば data URL、持っていなければ null。
// 判定できない (fetch が使えない等) ときは undefined を返し、呼び出し側は従来どおり _favicon を表示する。
async function realFaviconDataUrl(pageUrl, { fresh = false } = {}) {
  if (!fresh && iconProbes.has(pageUrl)) return iconProbes.get(pageUrl);
  const p = (async () => {
    try {
      const [bytes, def] = await Promise.all([fetchFaviconBytes(pageUrl), getDefaultIconBytes()]);
      if (!def) return undefined;
      if (!bytes || !bytes.length || sameBytes(bytes, def)) return null;
      return bytesToDataUrl(bytes);
    } catch {
      return undefined;
    }
  })();
  iconProbes.set(pageUrl, p);
  return p;
}

// { [pageUrl]: dataUrl } を保存する。変化があれば true
async function saveIcons(updates) {
  const changed = Object.entries(updates).filter(([u, d]) => typeof d === "string" && iconStore[u] !== d);
  if (!changed.length) return false;
  iconStore = { ...iconStore, ...Object.fromEntries(changed) };
  await chrome.storage.local.set({ icons: iconStore });
  return true;
}

// どのピンにも使われていない URL のアイコンを消す
async function pruneIcons(keepUrls) {
  const keep = new Set(keepUrls);
  const kept = Object.fromEntries(Object.entries(iconStore).filter(([u]) => keep.has(u)));
  if (Object.keys(kept).length !== Object.keys(iconStore).length) {
    iconStore = kept;
    await chrome.storage.local.set({ icons: iconStore });
  }
}

function letterTile(url) {
  const el = document.createElement("div");
  el.className = "fallback";
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  el.textContent = (host[0] || "?").toUpperCase();
  // ホスト名から色相を決めて、頭文字タイル同士を見分けやすくする (color.js)
  el.style.background = `hsl(${hostHue(url)} 55% 52%)`;
  return el;
}

// ---------- タイルの背景色 (color.js の iconTint) ----------
// アイコン画像から代表色を求め、ピンのタイルに淡く敷く。結果はアイコンごとにメモリへ覚えておき、
// 再描画のたびに計算し直さない (同期で適用できるので、描画のたびに色がちらつかない)。
const tintResolved = new Map(); // key -> tint | null
const tintPending = new Map();  // key -> Promise

function tintKey(url) {
  const d = iconStore[url];
  return d ? `${url}|${d.length}|${d.slice(-24)}` : `${url}|`;
}

// 計算済みなら結果 (null を含む)、未計算なら undefined
function cachedTint(url) {
  return tintResolved.get(tintKey(url));
}

function imagePixels(src, size) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        resolve(ctx.getImageData(0, 0, size, size).data);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// url のピンに使う背景色。アイコンが無いサイトは頭文字タイルと同じ色相、判定できなければ null
function computeTint(url) {
  const key = tintKey(url);
  if (tintResolved.has(key)) return Promise.resolve(tintResolved.get(key));
  if (tintPending.has(key)) return tintPending.get(key);
  const p = (async () => {
    let src = iconStore[url];
    if (!src) {
      const d = await realFaviconDataUrl(url);
      if (d === null) return { kind: "hue", h: hostHue(url), s: 55 };
      if (d === undefined) return null;
      src = d;
    }
    const rgba = await imagePixels(src, 32);
    return rgba ? iconTint(rgba) : null;
  })().then((tint) => {
    tintResolved.set(key, tint);
    tintPending.delete(key);
    return tint;
  });
  tintPending.set(key, p);
  return p;
}

function applyTint(el, tint) {
  el.classList.remove("tinted", "tone-light", "tone-dark");
  el.style.removeProperty("--tint-h");
  el.style.removeProperty("--tint-s");
  if (!tint) return;
  if (tint.kind === "hue") {
    el.classList.add("tinted");
    el.style.setProperty("--tint-h", String(tint.h));
    el.style.setProperty("--tint-s", String(tint.s));
  } else if (tint.tone === "light") {
    el.classList.add("tone-light");
  } else if (tint.tone === "dark") {
    el.classList.add("tone-dark");
  }
}

// アイコン要素を作る。保存済みならそれを、無ければ _favicon を出しつつ裏で確認し、
// 本物が取れれば保存 (storage.onChanged 経由で再描画)、既定アイコンなら頭文字タイルに差し替える。
function iconElement(url, { override = null } = {}) {
  const stored = override || iconStore[url];
  const img = document.createElement("img");
  img.alt = "";
  if (stored) {
    img.src = stored;
    return img;
  }
  img.src = faviconUrl(url);
  img.addEventListener("error", () => { if (img.isConnected) img.replaceWith(letterTile(url)); });
  realFaviconDataUrl(url).then((dataUrl) => {
    if (dataUrl) {
      saveIcons({ [url]: dataUrl });
      img.src = dataUrl;
    } else if (dataUrl === null && img.isConnected) {
      img.replaceWith(letterTile(url));
    }
  });
  return img;
}

// タブが読み込みを終えたとき、そのタブのアイコンを関係するピンに保存する。
// targets: [{ url, overwrite }]。overwrite=false のものは未保存のときだけ保存する。
// favicon の DB への書き込みは非同期なので、少し待ってから取り、取れなければもう一度試す。
async function captureIconForTab(tab, targets) {
  if (!targets.length || !/^https?:/.test(tab.url || "")) return;
  for (const delay of [700, 2500]) {
    await new Promise((r) => setTimeout(r, delay));
    const dataUrl = await realFaviconDataUrl(tab.url, { fresh: true });
    if (dataUrl) {
      const updates = {};
      for (const tg of targets) if (tg.overwrite || !iconStore[tg.url]) updates[tg.url] = dataUrl;
      // 同じページの問い合わせ結果も更新しておく (登録 URL と同じページなら次の描画で使われる)
      for (const tg of targets) iconProbes.delete(tg.url);
      await saveIcons(updates);
      return;
    }
    if (dataUrl === undefined) return;
  }
}

// Arc の SidebarItemsFaviconCache フォルダ (webkitdirectory で選んだ File の配列) から、
// ファイル名 -> data URL の対応を作る。PNG 以外は無視する。
async function readArcIconFolder(files) {
  const out = new Map();
  for (const f of files) {
    if (!/^[0-9a-f]{32}$/.test(f.name) || f.size > 512 * 1024) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (isPng) out.set(f.name, bytesToDataUrl(bytes));
  }
  return out;
}
