/* Command registry for the palette — replaces the legacy clickIf(buttonId)
   wiring (shell.js:119-121): instead of the palette reaching into the DOM for
   a button to click, owning components register a real callback on mount and
   unregister on unmount. Registered commands are only offered while their
   owner is mounted (an accepted IA deviation — see the PORTING.md §5.3
   DECISION note). */

import { useEffect, useRef } from 'react';
import { create } from 'zustand';

export interface ShellCommand {
  /** Stable id, e.g. 'clean-all' — re-registering an id replaces it. */
  id: string;
  label: string;
  /** Right-aligned category hint in the palette row (legacy a.hint). */
  hint?: string;
  run: () => void;
  /** Optional extra gate evaluated at palette-build time. */
  when?: () => boolean;
}

interface CommandStore {
  /** Registration order is presentation order within the registry block. */
  commands: ShellCommand[];
  register: (cmd: ShellCommand) => () => void;
}

export const useCommands = create<CommandStore>((set, get) => ({
  commands: [],
  register: (cmd) => {
    set((s) => ({ commands: [...s.commands.filter((c) => c.id !== cmd.id), cmd] }));
    return () => {
      // Unregister only if this exact registration is still current — a
      // replacement registration must not be torn down by the old owner.
      if (get().commands.some((c) => c === cmd)) {
        set((s) => ({ commands: s.commands.filter((c) => c !== cmd) }));
      }
    };
  },
}));

/** Imperative helper (mirrors toast()/showModal()). Returns the unregister fn. */
export function registerCommand(cmd: ShellCommand): () => void {
  return useCommands.getState().register(cmd);
}

/** Mount-scoped registration: registers once, always runs the LATEST run/when
 *  (props captured via ref), unregisters on unmount. */
export function useShellCommand(cmd: ShellCommand): void {
  const latest = useRef(cmd);
  latest.current = cmd;
  useEffect(() => {
    const unregister = registerCommand({
      id: latest.current.id,
      label: latest.current.label,
      ...(latest.current.hint !== undefined ? { hint: latest.current.hint } : {}),
      run: () => latest.current.run(),
      when: () => latest.current.when?.() ?? true,
    });
    return unregister;
    // Intentionally keyed by id only: label/hint are fixed per call site.
  }, [cmd.id]);
}
