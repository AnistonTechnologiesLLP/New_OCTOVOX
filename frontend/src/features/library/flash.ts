/* Cross-feature "flash this Library row" hand-off (legacy flash-highlight,
   app.js:497-508 and shell.js:137-149). Another feature (e.g. the Capture
   duplicate "Kept existing" flow) calls flashFile(name) before/after
   navigating to #/library; the Library consumes the pending name on its next
   render, scrolls the row into view and pulses it for 2.4 s. */

import { create } from 'zustand';

interface FlashStore {
  pending: string | null;
  request: (name: string) => void;
  clear: () => void;
}

export const useFlashStore = create<FlashStore>((set) => ({
  pending: null,
  request: (name) => set({ pending: name }),
  clear: () => set({ pending: null }),
}));

/** Ask the Library to flash + scroll the row for `name` (full filename, e.g.
 *  "rec_1.wav"). Safe to call from any feature at any time — the request is
 *  held until the Library renders that row, and dropped if the file does not
 *  exist once the list has settled. */
export function flashFile(name: string): void {
  useFlashStore.getState().request(name);
}
