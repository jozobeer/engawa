// chrome.i18n の薄いラッパー (sidepanel 用。background は chrome.i18n.getMessage を直接呼ぶ)。
// - t(key, subs): 単純なメッセージ取得 (未定義ならキー名を返す)
// - tn(key, n): 単数/複数。`${key}_one` / `${key}_other` を試し、無ければ key にフォールバック
// - localizeDocument(): data-i18n* 属性を持つ要素に翻訳を流し込む (sidepanel 専用)

function t(key, subs) {
  const msg = chrome.i18n.getMessage(key, subs === undefined ? undefined : [].concat(subs).map(String));
  return msg || key;
}

function tn(key, n) {
  const suffix = Number(n) === 1 ? "_one" : "_other";
  return chrome.i18n.getMessage(`${key}${suffix}`, [String(n)])
    || chrome.i18n.getMessage(key, [String(n)])
    || key;
}

function localizeDocument() {
  if (typeof document === "undefined") return;
  // 実際に解決されたカタログの言語 (ブラウザの UI 言語そのものではない)。未対応言語では default_locale の "en" になる。
  document.documentElement.lang = t("uiLocale");
  document.title = t("appName");

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // 翻訳文中の静的マークアップ (<code> など) を許可する。ソースは同梱の messages.json のみ。
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  // <option value="5" data-i18n-plural="intervalMinutes"> のように value を数として使う
  document.querySelectorAll("[data-i18n-plural]").forEach((el) => {
    const n = el.dataset.i18nCount ?? el.value;
    el.textContent = tn(el.dataset.i18nPlural, n);
  });
}
