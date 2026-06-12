/* Clean-run orchestration — ports runProduction (app.js:1503-1534): busy
   acquire, per-file speaker reset, streaming progress with sync fallback,
   result into the session store, files-query invalidation, skipped-stages
   toast, and navigation to the Studio detail for the cleaned stem. */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { goStudio } from './useHashRoute';
import { api } from '../lib/api';
import { cleanStreaming } from '../lib/ndjson';
import { getProdOpts } from '../state/settings';
import { useSession } from '../state/session';
import { toast } from '../state/toasts';

export function useCleanRun(): (filename: string) => Promise<boolean> {
  const queryClient = useQueryClient();

  return useCallback(
    async (filename: string): Promise<boolean> => {
      const session = useSession.getState();
      if (!filename) {
        toast('Clean requested with no filename.', 'error');
        return false;
      }
      if (!session.acquire(`cleaning ${filename}`)) return false;
      // A speaker azimuth detected on a different recording must not bleed
      // into this run (app.js:1506-1508).
      session.resetSpeakersForFile(filename);
      session.setSelectedFile(filename);
      const opts = getProdOpts();
      session.showProgress(`Cleaning voice (${opts.nr})...`);
      try {
        const j = await cleanStreaming(filename, opts, (message, pct, stage) =>
          useSession.getState().updateProgress(message, pct, stage),
        );
        useSession.getState().completeProgress();
        useSession.getState().hideProgress();
        useSession.getState().setResult(j);
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        void queryClient.invalidateQueries({ queryKey: ['verdict'] });
        const skipped = Object.entries(j.stages || {})
          .filter(([, s]) => s && s.ran === false)
          .map(([k]) => k);
        toast(
          `Clean ready in ${j.elapsed_s}s` +
            (skipped.length ? ` - skipped: ${skipped.join(', ')}` : ' - all stages ran'),
          skipped.length ? 'warn' : 'ok',
        );
        goStudio(j.stem);
        maybeAutoDetect(j.stem);
        return true;
      } catch (err) {
        console.error('[useCleanRun]', err);
        useSession.getState().hideProgress();
        const msg = err instanceof Error ? err.message : 'unknown error';
        toast(`Pipeline failed: ${msg}`, 'error');
        return false;
      } finally {
        useSession.getState().release();
      }
    },
    [queryClient],
  );
}

/** Auto-detect talkers after a clean so the picker is pre-populated — but not
 *  during a batch run, not if a target is already chosen, and not if this
 *  file's list is already loaded (app.js:1678-1684). Fire-and-forget. */
function maybeAutoDetect(stem: string): void {
  const s = useSession.getState();
  if (s.runningAll) return;
  if (s.targetAz != null) return;
  const fname = `${stem}.wav`;
  if (s.speakersFile === fname) return;
  api
    .speakers(fname)
    .then((j) => {
      if (j.ok && j.ran) useSession.getState().setSpeakers(j.speakers || [], fname);
    })
    .catch(() => undefined);
}
