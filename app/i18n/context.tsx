import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { Locale } from "./index";

type I18nCtx = { locale: Locale; dict: Record<string, string> };

const I18nContext = createContext<I18nCtx>({ locale: "en", dict: {} });

export function I18nProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: Record<string, string>;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, dict }), [locale, dict]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// useT returns t(englishText, vars?). The English text is the lookup key.
// Interpolation: t("Save {n} items", { n: 3 }) replaces {n}. Missing keys fall
// back to the English text, so the UI is never blank or broken.
export function useT() {
  const { dict } = useContext(I18nContext);
  return (key: string, vars?: Record<string, string | number>) => {
    let s = dict[key] ?? key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
      }
    }
    return s;
  };
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
