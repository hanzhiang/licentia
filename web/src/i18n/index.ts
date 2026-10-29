import { createI18n } from 'vue-i18n';
import { messages } from './messages';

export { messages };

/**
 * 界面语言: 默认跟随浏览器, 可手动切换并记住。
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const STORAGE_KEY = 'lp_locale';

/** 浏览器语言 → 支持的语言; 非中文一律回落英文 */
export function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh-CN' || saved === 'en') return saved;
  const nav = navigator.language || 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages,
});

export function currentLocale(): Locale {
  return i18n.global.locale.value as Locale;
}

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.setAttribute('lang', locale);
}
