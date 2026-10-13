import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
// Observe only this owned transcript subtree. No document-wide mutation queue,
// scroll reset on each render, or synthetic viewport measurements in production.
export function useFollowScroll(root: RefObject<HTMLElement | null>, scope: string, enabled = true) {
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const scrollToBottom = useCallback(() => {
    const log = root.current?.querySelector<HTMLElement>('[role="log"]');
    follow.current = true; setFollowing(true);
    if (log) log.scrollTop = log.scrollHeight;
  }, [root]);
  useEffect(() => {
    const container = root.current; if (!container || !enabled) return;
    let log: HTMLElement | null = null; follow.current = true; setFollowing(true);
    const onScroll = () => { if (log) { follow.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 80; setFollowing(follow.current); } };
    const refresh = () => {
      const next = container.querySelector<HTMLElement>('[role="log"]');
      if (next !== log) { log?.removeEventListener('scroll', onScroll); log = next; follow.current = true; setFollowing(true); log?.addEventListener('scroll', onScroll, { passive: true }); }
      if (log && follow.current) log.scrollTop = log.scrollHeight;
    };
    const observer = new MutationObserver(refresh); observer.observe(container, { childList: true, subtree: true, characterData: true }); refresh();
    const onResize = () => refresh(); window.addEventListener('resize', onResize);
    return () => { observer.disconnect(); log?.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize); };
  }, [root, scope, enabled]);
  return { following, scrollToBottom };
}
