import styles from './CoffeeActivityMark.module.scss';

/** Decorative vector artwork: no font glyphs, emoji or network image assets. */
export function CoffeeActivityMark({ steaming }: { steaming: boolean }) {
  return <svg className={styles.coffee} data-coffee-indicator data-steaming={steaming} width="20" height="20" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <g className={styles.steam}>
      <path d="M10 11c-2-2 2-3 0-5" />
      <path d="M15 10c-2-2 2-3 0-6" />
      <path d="M20 11c-2-2 2-3 0-5" />
    </g>
    <path className={styles.liquid} d="M6 15h16v5a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z" fill="currentColor" stroke="none" />
    <path d="M6 15h16v5a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z M22 16h1.5a3.5 3.5 0 0 1 0 7H22 M4 29h20" />
  </svg>;
}
