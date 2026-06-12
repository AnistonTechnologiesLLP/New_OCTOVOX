/* Promise-based modal — ports legacy showModal() (app.js:2052-2106):
   resolves with the clicked button id, or "cancel" on Esc / backdrop click;
   only one modal at a time (opening a new one cancels the old). */

import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface ModalButton {
  id: string;
  label: string;
  variant?: 'primary' | 'danger' | 'ghost';
}

export interface ModalSpec {
  icon?: string;
  iconType?: 'warn' | 'error' | '';
  title: string;
  body: ReactNode;
  buttons: ModalButton[];
}

interface ModalStore {
  active: (ModalSpec & { resolve: (id: string) => void }) | null;
  open: (spec: ModalSpec) => Promise<string>;
  close: (id: string) => void;
  isOpen: () => boolean;
}

export const useModal = create<ModalStore>((set, get) => ({
  active: null,
  open: (spec) =>
    new Promise<string>((resolve) => {
      const prev = get().active;
      if (prev) prev.resolve('cancel');
      set({ active: { ...spec, resolve } });
    }),
  close: (id) => {
    const a = get().active;
    if (!a) return;
    set({ active: null });
    a.resolve(id);
  },
  isOpen: () => get().active != null,
}));

/** Imperative helper mirroring the legacy global `showModal(spec)`. */
export function showModal(spec: ModalSpec): Promise<string> {
  return useModal.getState().open(spec);
}

/** Close the active modal as "cancel" (Esc / backdrop). Returns whether one was open. */
export function cancelActiveModal(): boolean {
  if (!useModal.getState().isOpen()) return false;
  useModal.getState().close('cancel');
  return true;
}
