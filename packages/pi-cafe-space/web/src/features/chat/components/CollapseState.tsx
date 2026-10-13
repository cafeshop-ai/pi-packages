import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
interface CollapseState { open: ReadonlyMap<string, boolean>; set: (key: string, value: boolean) => void; register: (key: string) => () => void }
const Context = createContext<CollapseState | null>(null);
export function CollapseProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(new Map<string, boolean>());
  const active = useRef(new Map<string, number>());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const register = useCallback((key: string) => {
    active.current.set(key, (active.current.get(key) ?? 0) + 1);
    return () => {
      const count = (active.current.get(key) ?? 1) - 1;
      if (count) active.current.set(key, count); else active.current.delete(key);
      // Allow a same-key renderer replacement in this commit to re-register.
      queueMicrotask(() => { if (mounted.current && !active.current.has(key)) setOpen(previous => {
        if (!previous.has(key)) return previous;
        const next = new Map(previous); next.delete(key); return next;
      }); });
    };
  }, []);
  const set = (key: string, value: boolean) => setOpen(previous => {
    if (previous.get(key) === value) return previous;
    const next = new Map(previous); next.delete(key); next.set(key, value);
    while (next.size > 500) next.delete(next.keys().next().value!);
    return next;
  });
  return <Context.Provider value={{ open, set, register }}>{children}</Context.Provider>;
}
export function useDisclosure(key: string, defaultOpen = false) {
  const state = useContext(Context);
  if (!state) throw new Error('Missing conversation disclosure owner');
  useEffect(() => state.register(key), [state.register, key]);
  return { open: state.open.get(key) ?? defaultOpen, setOpen: (value: boolean) => state.set(key, value) };
}
