import type { ReactNode } from 'react';
const paths = {
  more: 'M4 10h.01 M10 10h.01 M16 10h.01',
  share: 'M10 13V2 M6 6l4-4 4 4 M5 9H3v9h14V9h-2',
  message: 'M18 13a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3Z M7 7h7 M7 11h4',
  hosts: 'M3 3h14v10H3Z M7 17h6 M10 13v4 M6 7l2 2-2 2 M11 10h3',
  folder: 'M2 5h6l2 2h8v10H2Z',
  file: 'M4 2h7l5 5v11H4Z M11 2v5h5 M7 11h6 M7 14h4',
  history: 'M3 8a7 7 0 1 1 0 5 M3 3v5h5 M10 6v4l3 2',
  settings: 'M3 5h14 M3 10h14 M3 15h14 M7 3v4 M13 8v4 M8 13v4',
  send: 'M10 16V4 M5 9l5-5 5 5',
  stop: 'M5 5h10v10H5Z',
  close: 'M5 5l10 10 M15 5L5 15',
  chevron: 'm7 4 6 6-6 6',
  back: 'M16 10H4 M9 5l-5 5 5 5',
  refresh: 'M17 8a7 7 0 1 0 0 5 M17 3v5h-5',
  lock: 'M4 9h12v9H4Z M6 9V6a4 4 0 0 1 8 0v3 M10 13v2',
  sun: 'M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M10 1v2 M10 17v2 M1 10h2 M17 10h2 M4 4l1 1 M15 15l1 1 M4 16l1-1 M15 5l1-1',
  moon: 'M17 12A7 7 0 0 1 8 3a7 7 0 1 0 9 9Z',
  logout: 'M8 3H3v14h5 M9 10h9 M14 6l4 4-4 4',
  check: 'm4 10 4 4 8-8',
  sidebar: 'M3 3h14v14H3Z M8 3v14',
  search: 'M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0 M12 12l5 5',
  copy: 'M7 7h10v10H7Z M13 7V3H3v10h4',
  down: 'M10 3v14 M5 12l5 5 5-5',
  plus: 'M10 4v12 M4 10h12',
  edit: 'm13 3 4 4-10 10H3v-4Z M11 5l4 4',
} as const;
export function Icon({ name, className }: { name: keyof typeof paths; className?: string }) {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}><path d={paths[name]} /></svg>;
}
export function BusyLabel({ children }: { children: ReactNode }) {
  return <><span className="button-content">{children}</span><span className="button-loading" aria-hidden="true"><svg className="cafe-steam" viewBox="0 0 64 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false"><path pathLength="1" d="M23 20C15 15 29 11 21 4" /><path pathLength="1" d="M33 20C25 15 39 11 31 4" /><path pathLength="1" d="M43 20C35 15 49 11 41 4" /></svg></span></>;
}
