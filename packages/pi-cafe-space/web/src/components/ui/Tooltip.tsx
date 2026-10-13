import type { ReactElement } from 'react';
import { Tooltip as Root, TooltipContent, TooltipTrigger } from './shadcn/tooltip';
import { useUiPortal } from './UiProvider';
export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const container = useUiPortal();
  return <Root><TooltipTrigger render={children} /><TooltipContent role="tooltip" container={container} sideOffset={8}>{label}</TooltipContent></Root>;
}
