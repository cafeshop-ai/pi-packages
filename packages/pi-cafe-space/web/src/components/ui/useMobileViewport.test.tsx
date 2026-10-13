import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMobileViewport } from './useMobileViewport';
function Probe(){useMobileViewport();return null;}
afterEach(()=>{vi.unstubAllGlobals();document.documentElement.style.removeProperty('--cafe-viewport-height');document.documentElement.style.removeProperty('--cafe-viewport-top');});
it('tracks a smaller mobile visual viewport, respects zoom, and cleans up listeners/styles',()=>{
 const view=Object.assign(new EventTarget(),{height:780,offsetTop:0,scale:1});let pending:FrameRequestCallback|undefined;
 vi.stubGlobal('innerWidth',390);vi.stubGlobal('visualViewport',view);vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{pending=fn;return 1;});vi.stubGlobal('cancelAnimationFrame',vi.fn());
 const remove=vi.spyOn(view,'removeEventListener'),root=document.documentElement;const{unmount}=render(<Probe/>);expect(root.style.getPropertyValue('--cafe-viewport-height')).toBe('780px');
 act(()=>{view.height=410;view.offsetTop=12;view.dispatchEvent(new Event('resize'));pending?.(1);});expect(root.style.getPropertyValue('--cafe-viewport-height')).toBe('410px');expect(root.style.getPropertyValue('--cafe-viewport-top')).toBe('12px');
 act(()=>{view.scale=1.5;view.dispatchEvent(new Event('resize'));pending?.(2);});expect(root.style.getPropertyValue('--cafe-viewport-height')).toBe('');
 unmount();expect(remove).toHaveBeenCalledTimes(2);expect(root.style.getPropertyValue('--cafe-viewport-top')).toBe('');
});
