import { useEffect } from 'react';

export function useMobileViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const heightName = '--cafe-viewport-height', topName = '--cafe-viewport-top';
    const originalHeight = root.style.getPropertyValue(heightName), originalTop = root.style.getPropertyValue(topName);
    let frame = 0;
    const update = () => {
      frame = 0;
      if (window.innerWidth >= 768 || Math.abs(viewport.scale - 1) > 0.05) {
        root.style.removeProperty(heightName); root.style.removeProperty(topName); return;
      }
      if (!Number.isFinite(viewport.height) || viewport.height < 160) return;
      root.style.setProperty(heightName, `${Math.round(viewport.height)}px`);
      root.style.setProperty(topName, `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update(); viewport.addEventListener('resize', schedule); viewport.addEventListener('scroll', schedule); window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame); viewport.removeEventListener('resize', schedule); viewport.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      originalHeight ? root.style.setProperty(heightName, originalHeight) : root.style.removeProperty(heightName);
      originalTop ? root.style.setProperty(topName, originalTop) : root.style.removeProperty(topName);
    };
  }, []);
}
