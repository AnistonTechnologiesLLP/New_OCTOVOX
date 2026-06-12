/* Toast queue — ports legacy toast() semantics (app.js:1987-2042):
   dedup of the identical message within 1.2 s (action toasts exempt),
   default durations error 7s / warn 6s / ok 3s. */

import { create } from 'zustand';
import type { ToastAction, ToastType } from '../lib/types';

export interface Toast {
  id: number;
  msg: string;
  type: ToastType;
  action?: ToastAction;
  duration: number;
}

interface ToastStore {
  toasts: Toast[];
  add: (msg: string, type?: ToastType, opts?: { action?: ToastAction; duration?: number }) => void;
  dismiss: (id: number) => void;
  dismissNewest: () => boolean;
}

let nextId = 1;
let last: { msg: string; ts: number } | null = null;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  add: (msg, type, opts = {}) => {
    const now = Date.now();
    if (!opts.action && last && last.msg === msg && now - last.ts < 1200) return;
    last = { msg, ts: now };
    const duration =
      opts.duration != null ? opts.duration : type === 'error' ? 7000 : type === 'warn' ? 6000 : 3000;
    const t: Toast = { id: nextId++, msg, type, duration, ...(opts.action ? { action: opts.action } : {}) };
    set((s) => ({ toasts: [...s.toasts, t] }));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissNewest: () => {
    const ts = get().toasts;
    const newest = ts[ts.length - 1];
    if (!newest) return false;
    get().dismiss(newest.id);
    return true;
  },
}));

/** Imperative helper mirroring the legacy global `toast(msg, type, opts)`. */
export function toast(
  msg: string,
  type?: ToastType,
  opts?: { action?: ToastAction; duration?: number },
): void {
  useToasts.getState().add(msg, type, opts);
}
