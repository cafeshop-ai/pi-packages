import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ui } from './ui';
export const resources = {
  'zh-CN': { translation: { ...ui['zh-CN'], appName: 'Pi Cafe Space', disconnected: '尚未连接到 Relay', description: '通过原生 Pi 会话协作；浏览器不执行工具。', language: '语言' } },
  en: { translation: { ...ui.en, appName: 'Pi Cafe Space', disconnected: 'Not connected to Relay', description: 'Collaborate with native Pi sessions. Tools run in Pi, not in your browser.', language: 'Language' } },
};
export function createI18n() {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({ resources, showSupportNotice: false, lng: 'zh-CN', fallbackLng: 'en', initAsync: false, interpolation: { escapeValue: false } });
  return instance;
}
