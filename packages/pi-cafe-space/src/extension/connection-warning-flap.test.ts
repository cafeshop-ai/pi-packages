import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionWarningReporter, CONNECTION_WARNING_GRACE_MS, CONNECTION_RECOVERY_STABLE_MS } from './connection-warning.js';
afterEach(()=>vi.useRealTimers());
it('short recovered intervals do not print alternating warning/recovered pairs',()=>{
 vi.useFakeTimers();const warning=vi.fn(),recovered=vi.fn(),reporter=new ConnectionWarningReporter(warning,recovered);
 reporter.reportTransient('first outage');vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS);expect(warning).toHaveBeenCalledOnce();
 reporter.onAuthenticatedWelcome();vi.advanceTimersByTime(2000);expect(recovered).not.toHaveBeenCalled();
 reporter.reportTransient('same unstable episode');vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS);expect(warning).toHaveBeenCalledOnce();expect(recovered).not.toHaveBeenCalled();
 reporter.onAuthenticatedWelcome();vi.advanceTimersByTime(CONNECTION_RECOVERY_STABLE_MS);expect(recovered).toHaveBeenCalledOnce();
 reporter.reportTransient('another short outage');vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS);expect(warning).toHaveBeenCalledOnce();reporter.onExplicitStop();expect(vi.getTimerCount()).toBe(0);
});
it('a long outage never creates periodic warning spam and recovery must stay stable',()=>{
 vi.useFakeTimers();const warning=vi.fn(),recovered=vi.fn(),reporter=new ConnectionWarningReporter(warning,recovered);
 for(let i=0;i<60;i++){reporter.reportTransient('listener unavailable');vi.advanceTimersByTime(10000);}
 expect(warning).toHaveBeenCalledOnce();expect(recovered).not.toHaveBeenCalled();
 reporter.onAuthenticatedWelcome();vi.advanceTimersByTime(CONNECTION_RECOVERY_STABLE_MS-1);reporter.reportTransient('still unstable');vi.advanceTimersByTime(10000);expect(recovered).not.toHaveBeenCalled();expect(warning).toHaveBeenCalledOnce();
 reporter.onAuthenticatedWelcome();vi.advanceTimersByTime(CONNECTION_RECOVERY_STABLE_MS);expect(recovered).toHaveBeenCalledOnce();reporter.onExplicitStop();expect(vi.getTimerCount()).toBe(0);
});
it('a routine five-second restart updates status elsewhere but needs no warning notification',()=>{
 vi.useFakeTimers();const warning=vi.fn(),recovered=vi.fn(),reporter=new ConnectionWarningReporter(warning,recovered);
 reporter.reportTransient('local listener restarting');vi.advanceTimersByTime(5000);reporter.onAuthenticatedWelcome();vi.advanceTimersByTime(20000);
 expect(warning).not.toHaveBeenCalled();expect(recovered).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
