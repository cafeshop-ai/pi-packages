import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import './styles/tailwind.css';
import './styles/global.scss';
import { App } from './app/App';
import { createI18n } from './i18n';

const element = document.getElementById('root');
if (!element) throw new Error('Missing Web root');
const root = createRoot(element);
root.render(<StrictMode><I18nextProvider i18n={createI18n()}><App /></I18nextProvider></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
