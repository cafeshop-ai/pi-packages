import { useRef, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from './shadcn/sheet';
import { Button } from './Controls';
import { Icon } from './Icon';
import { useUiPortal } from './UiProvider';
import styles from './Drawer.module.scss';
function drawerTabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')].filter(node => {
    if (node.tabIndex < 0 || node.matches(':disabled, input[type="hidden"]')) return false;
    // Preserve the native-browser regression guard for closed details and
    // hidden/inert descendants independently of the primitive's focus scope.
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (parent.hidden || parent.inert || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parent instanceof HTMLDetailsElement && !parent.open) {
        const summary = [...parent.children].find(child => child.tagName === 'SUMMARY');
        if (!summary?.contains(node)) return false;
      }
      if (parent === root) break;
    }
    return true;
  });
}
export function Drawer({ label, closeLabel, children, onClose, restoreFocusTo, compact = false, room = false }: { room?: boolean; compact?: boolean; label: string; closeLabel: string; children: ReactNode; onClose: () => void; restoreFocusTo: HTMLElement | null }) {
  const container = useUiPortal(); const content = useRef<HTMLDivElement>(null);
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
    <SheetContent ref={content} container={container} showCloseButton={false} className={`${styles.drawer} gap-0 overflow-auto overscroll-contain p-4 data-[side=right]:w-[min(380px,calc(100vw-24px))] [&_button]:max-w-full [&_a]:max-w-full ${compact ? styles.compact : ''} ${room ? styles.room : ''}`}
      aria-label={label} aria-modal="true" aria-describedby={undefined}
      initialFocus={() => {
        if (!content.current) return false;
        const nodes = drawerTabStops(content.current);
        return (compact && nodes.find(node => node.matches('input, textarea'))) || nodes[0] || false;
      }}
      finalFocus={() => restoreFocusTo?.isConnected ? restoreFocusTo : false}
      onClick={event => { if ((event.target as Element).closest('a, [data-close-drawer]')) onClose(); }}
      onKeyDownCapture={event => {
        if (event.key !== 'Tab') return;
        const nodes = drawerTabStops(event.currentTarget); const first = nodes[0]; const last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <SheetHeader className={`mb-5 flex-row items-center justify-between gap-3 p-0 pb-3 ${room ? styles.roomHeader : ''}`}><SheetTitle>{label}</SheetTitle><SheetClose render={<Button variant="quiet" aria-label={closeLabel} />}><Icon name="close" />{!compact && closeLabel}</SheetClose></SheetHeader>
      {children}
    </SheetContent>
  </Sheet>;
}
