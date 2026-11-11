import { getActiveStudioLocale } from "./locale";
import { getLocaleDefinition } from "./registry";

function resolveFormattingLocale(localeCode?: string): string {
  return (
    getLocaleDefinition(localeCode)?.code ??
    getActiveStudioLocale().code
  );
}

export function formatLocalizedDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = {},
  localeCode?: string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(resolveFormattingLocale(localeCode), options).format(date);
}

export function formatLocalizedNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  localeCode?: string,
): string {
  return new Intl.NumberFormat(resolveFormattingLocale(localeCode), options).format(value);
}

export function formatLocalizedRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options: Intl.RelativeTimeFormatOptions = { numeric: "auto" },
  localeCode?: string,
): string {
  return new Intl.RelativeTimeFormat(
    resolveFormattingLocale(localeCode),
    options,
  ).format(value, unit);
}

export function getLocalizedPluralCategory(
  value: number,
  options: Intl.PluralRulesOptions = {},
  localeCode?: string,
): Intl.LDMLPluralRule {
  return new Intl.PluralRules(
    resolveFormattingLocale(localeCode),
    options,
  ).select(value);
}
