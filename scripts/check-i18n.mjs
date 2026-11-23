// 翻訳キーの整合性チェック:
//  - ソース (manifest / HTML / JS) で参照しているキーが全ロケールに存在するか
//  - カタログにあるのにどこからも参照されていないキーはないか
//  - ロケール間でキー集合とプレースホルダ集合が一致しているか
// 使い方: node scripts/check-i18n.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const locales = readdirSync(join(root, "_locales"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const catalogs = Object.fromEntries(locales.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
const [base, ...others] = locales.sort();

const sources = ["manifest.json", "sidepanel.html", "sidepanel.js", "appearance.js", "background.js", "i18n.js", "arc-import.js", "icons.js", "color.js", "today.js", "split.js", "split-items.js", "split-items-ui.js", "reorder.js", "pinned.js", "ui-icons.js"];
const refs = new Map(); // key -> [where]
const add = (k, where) => refs.set(k, [...(refs.get(k) || []), where]);

for (const f of sources) {
  const src = read(f);
  for (const m of src.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) add(m[1], f);
  for (const m of src.matchAll(/data-i18n(?:-html|-title|-label|-placeholder)?="([^"]+)"/g)) add(m[1], f);
  for (const m of src.matchAll(/data-i18n-plural="([^"]+)"/g)) { add(`${m[1]}_one`, f); add(`${m[1]}_other`, f); }
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) add(m[1], f);
  for (const m of src.matchAll(/\btn\(\s*"([^"]+)"/g)) { add(`${m[1]}_one`, f); add(`${m[1]}_other`, f); }
  for (const m of src.matchAll(/getMessage\(\s*"([^"]+)"/g)) add(m[1], f);
  // t(key || "ciNone") のように変数経由で渡すケース: 文字列リテラルがカタログのキーと一致すれば参照とみなす
  for (const m of src.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) if (catalogs[base][m[1]]) add(m[1], `${f} (literal)`);
}

let errors = 0;
const err = (msg) => { errors++; console.error("✗", msg); };

for (const [k, where] of refs) {
  for (const l of locales) if (!catalogs[l][k]) err(`missing in ${l}: ${k}  (used in ${[...new Set(where)].join(", ")})`);
}
for (const k of Object.keys(catalogs[base])) {
  if (!refs.has(k)) err(`unused key: ${k}`);
}
const phSet = (entry) => new Set(Object.keys(entry.placeholders || {}).map((p) => p.toLowerCase()));
const phInMsg = (entry) => new Set([...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()));
for (const l of locales) {
  for (const [k, e] of Object.entries(catalogs[l])) {
    const declared = phSet(e), used = phInMsg(e);
    for (const p of used) if (!declared.has(p)) err(`${l}/${k}: placeholder $${p}$ used but not declared`);
    for (const p of declared) if (!used.has(p)) err(`${l}/${k}: placeholder ${p} declared but unused in message`);
  }
}
for (const l of others) {
  const a = new Set(Object.keys(catalogs[base])), b = new Set(Object.keys(catalogs[l]));
  for (const k of a) if (!b.has(k)) err(`${l} lacks key ${k}`);
  for (const k of b) if (!a.has(k)) err(`${l} has extra key ${k}`);
  for (const k of a) if (b.has(k)) {
    const pa = [...phSet(catalogs[base][k])].sort().join(","), pb = [...phSet(catalogs[l][k])].sort().join(",");
    if (pa !== pb) err(`${k}: placeholders differ (${base}: ${pa} / ${l}: ${pb})`);
  }
}

console.log(`${locales.length} locales, ${Object.keys(catalogs[base]).length} keys, ${refs.size} referenced, ${errors} error(s)`);
process.exit(errors ? 1 : 0);
