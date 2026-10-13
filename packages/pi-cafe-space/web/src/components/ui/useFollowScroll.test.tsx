import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useFollowScroll } from './useFollowScroll';
function Fixture({ text }: { text: string }) { const ref = useRef<HTMLDivElement>(null); useFollowScroll(ref, 'scope'); return <div ref={ref}><div role="log">{text}</div></div>; }
it('follows within 80px but does not steal an earlier reading position', async () => {
  const { rerender } = render(<Fixture text="first" />); const log = screen.getByRole('log');
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  log.scrollTop = 750; fireEvent.scroll(log);
  await act(async () => rerender(<Fixture text="near bottom" />));
  expect(log.scrollTop).toBe(1000);
  log.scrollTop = 200; fireEvent.scroll(log);
  await act(async () => rerender(<Fixture text="reading earlier" />));
  expect(log.scrollTop).toBe(200);
});
