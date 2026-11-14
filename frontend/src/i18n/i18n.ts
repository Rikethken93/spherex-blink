import en from "./en.json";
import es from "./es.json";

type Dict = Record<string, string>;
const DICTS: Record<string, Dict> = { en, es };

let currentLang = "en";

export function setLang(lang: string): void {
  currentLang = DICTS[lang] ? lang : "en";
  document.documentElement.lang = currentLang;
}

export function getLang(): string {
  return currentLang;
}

export function t(key: string): string {
  return DICTS[currentLang]?.[key] ?? DICTS.en[key] ?? key;
}

export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (key && el instanceof HTMLInputElement) el.placeholder = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    const key = el.dataset.i18nAriaLabel;
    if (key) el.setAttribute("aria-label", t(key));
  });
}
