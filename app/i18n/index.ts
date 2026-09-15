// Lightweight i18n for the B2B admin UI.
// Design: the ENGLISH STRING IS THE KEY. t("Customer Groups") looks the string
// up in the active locale dictionary and returns the translation, or falls back
// to the English key itself. This means the app is NEVER broken during a partial
// migration: an unwrapped string stays English, and a wrapped string with a
// missing translation stays English. Supported set is deliberately small
// (Pratham 2026-08-13): en + de/es/it/fr/ar/ja/zh.
import en from "./locales/en.json";
import de from "./locales/de.json";
import es from "./locales/es.json";
import it from "./locales/it.json";
import fr from "./locales/fr.json";
import ar from "./locales/ar.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

export const SUPPORTED = ["en", "de", "es", "it", "fr", "ar", "ja", "zh"] as const;
export type Locale = (typeof SUPPORTED)[number];

// Right-to-left locales. Only Arabic in our set.
export const RTL_LOCALES: Locale[] = ["ar"];
export const isRtl = (l: Locale) => RTL_LOCALES.includes(l);

const DICTS: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  de: de as Record<string, string>,
  es: es as Record<string, string>,
  it: it as Record<string, string>,
  fr: fr as Record<string, string>,
  ar: ar as Record<string, string>,
  ja: ja as Record<string, string>,
  zh: zh as Record<string, string>,
};

// Map Shopify's locale param (de-DE, es-ES, zh-CN, zh-Hant, ar-SA, ...) to our set.
export function normalizeLocale(raw?: string | null): Locale {
  if (!raw) return "en";
  const l = raw.toLowerCase();
  if (l.startsWith("de")) return "de";
  if (l.startsWith("es")) return "es";
  if (l.startsWith("it")) return "it";
  if (l.startsWith("fr")) return "fr";
  if (l.startsWith("ar")) return "ar";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("zh")) return "zh";
  return "en";
}

export function getDict(locale: Locale): Record<string, string> {
  return DICTS[locale] || DICTS.en;
}

// Polaris ships zh-CN (not "zh") and has no Arabic; Arabic uses English Polaris
// strings + our Arabic content + dir=rtl.
export function polarisLocaleCode(locale: Locale): string {
  if (locale === "zh") return "zh-CN";
  if (locale === "ar") return "en";
  return locale;
}
