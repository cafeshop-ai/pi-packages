import { createContext, useContext, useState, type ReactNode } from 'react';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { TooltipProvider } from './shadcn/tooltip';
const PortalContext = createContext<HTMLElement | undefined>(undefined);
export const useUiPortal = () => useContext(PortalContext);
// Portals stay inside the theme/language scope, outside inert workspace panels.
// Base UI's supported CSP opt-out uses our external stylesheet, not a nonce or
// unsafe-inline exception. No runtime style elements are needed.
export function UiProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return <CSPProvider disableStyleElements><PortalContext.Provider value={container ?? undefined}><TooltipProvider delay={450}>
    {children}<div ref={setContainer} className="contents" data-ui-portal="" />
  </TooltipProvider></PortalContext.Provider></CSPProvider>;
}
