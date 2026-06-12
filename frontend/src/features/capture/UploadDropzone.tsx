/* Upload dropzone — ports setupDropzone + handleFile (app.js:410-559):
   click-anywhere/browse picker, drag-state class, .wav + 500 MB client
   checks, the duplicate-handling 3-way modal (Keep existing / Replace /
   Save as <suggested>), spec-rejection problems toast, and the busy
   hand-off to the auto-clean on success. */

import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { useCleanRun } from '../../hooks/useCleanStream';
import { goLibrary } from '../../hooks/useHashRoute';
import { api } from '../../lib/api';
import type { UploadResult } from '../../lib/types';
import { showModal } from '../../state/modals';
import { useSession } from '../../state/session';
import { toast } from '../../state/toasts';

export default function UploadDropzone() {
  const queryClient = useQueryClient();
  const runClean = useCleanRun();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [drag, setDrag] = useState(false);

  const openPicker = (): void => fileRef.current?.click();

  const handleFile = async (file: File): Promise<void> => {
    if (!file.name.toLowerCase().endsWith('.wav')) {
      toast(`Please drop a .wav file (got: ${file.name})`, 'error');
      return;
    }
    // Client-side size sanity check (server caps at 500 MB) — app.js:438-442
    if (file.size > 500 * 1024 * 1024) {
      toast(`File too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Maximum is 500 MB.`, 'error');
      return;
    }

    const session = useSession.getState();
    if (!session.acquire(`uploading ${file.name}`)) return;

    // Inner uploader so "Replace" and "Save with new name" reuse it.
    const doUpload = (uploadFile: File, opts?: { overwrite?: boolean }): Promise<UploadResult> => {
      session.showProgress(`Uploading ${uploadFile.name}...`);
      return api.upload(uploadFile, opts);
    };

    try {
      let j = await doUpload(file);

      // Duplicate handling - friendly modal with 3 choices (app.js:464-514).
      if (!j.ok && j.duplicate) {
        session.hideProgress();
        const dupName = j.name ?? file.name;
        const suggested = j.suggested_name ?? file.name;
        const sizeMb = ((j.existing_size_kb ?? 0) / 1024).toFixed(1);
        const dur = (j.existing_duration ?? 0).toFixed(1);
        const choice = await showModal({
          icon: 'FILE',
          iconType: 'warn',
          title: 'A file with this name already exists',
          body: (
            <>
              <p>
                You already have <code>{dupName}</code> in your input folder. What would you like
                to do?
              </p>
              <div className="modal-info">
                <div className="mi-row"><span>Existing file size</span><b>{sizeMb} MB</b></div>
                <div className="mi-row"><span>Existing duration</span><b>{dur} s</b></div>
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                Tip - saving as <code>{suggested}</code> keeps both files so you can compare
                results.
              </p>
            </>
          ),
          buttons: [
            { id: 'cancel', label: 'Keep existing', variant: 'ghost' },
            { id: 'replace', label: 'Replace', variant: 'danger' },
            { id: 'rename', label: `Save as ${suggested}`, variant: 'primary' },
          ],
        });

        if (choice === 'cancel') {
          // "Kept existing" flow — release BEFORE refreshing so the row is
          // interactive, then guide the user to it (app.js:490-508).
          session.release();
          await queryClient.invalidateQueries({ queryKey: ['files'] });
          goLibrary();
          // TODO(flash): when features/library exports flashFile(name), flash
          // the kept row and restore the context-aware hint ("Click View to
          // open its existing results." / "Click Run to analyse it.").
          toast(`Kept ${dupName} - your original file is safe.`);
          return;
        }
        if (choice === 'replace') {
          j = await doUpload(file, { overwrite: true });
        } else if (choice === 'rename') {
          j = await doUpload(new File([file], suggested, { type: file.type }));
        }
      }

      // Spec mismatch or other backend rejection (app.js:517-528).
      if (!j.ok) {
        session.hideProgress();
        if (j.problems && j.problems.length) {
          const details = j.problems.map((p) => `- ${p}`).join('\n');
          toast(`File rejected (doesn't match sensiBel spec):\n${details}`, 'error');
        } else {
          toast(`Upload failed: ${j.error || 'unknown error'}`, 'error');
        }
        return;
      }

      // Success: surface warnings, refresh files, then hand the busy state
      // off to the clean run (app.js:530-541).
      const fname = j.name ?? file.name;
      (j.warnings || []).forEach((w) => toast(w, 'warn'));
      toast(j.replaced ? `Replaced ${fname}` : `Uploaded ${fname}`);
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      session.release();
      await runClean(fname);
    } catch (err) {
      console.error('[handleFile]', err);
      session.hideProgress();
      const msg = err instanceof Error ? err.message : 'unknown error';
      toast(`Upload failed: ${msg}`, 'error');
    } finally {
      // Belt-and-suspenders: if we still hold the upload lock (didn't hand
      // off and didn't manually release), free it now (app.js:546-552).
      const s = useSession.getState();
      if (s.busy && s.busyWhat != null && s.busyWhat.startsWith('uploading')) s.release();
    }
  };

  const onZoneClick = (e: MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName !== 'BUTTON') openPicker();
  };

  const onDragIn = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDrag(true);
  };
  const onDragOut = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDrag(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) void handleFile(f);
  };

  return (
    <div
      className={`cap-dz${drag ? ' drag' : ''}`}
      onClick={onZoneClick}
      onDragEnter={onDragIn}
      onDragOver={onDragIn}
      onDragLeave={onDragOut}
      onDrop={onDrop}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".wav"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = ''; // same file can be re-picked (app.js:418-421)
        }}
      />
      <div className="cap-dz-glyph">WAV</div>
      <div className="cap-dz-title">
        Drop an 8-channel <code>.wav</code>
      </div>
      <div className="cap-dz-sub">
        or{' '}
        <button
          className="cap-link"
          onClick={(e) => {
            e.stopPropagation();
            openPicker();
          }}
        >
          browse files
        </button>
      </div>
      <div className="cap-dz-meta">8 ch / 48 kHz / 24-bit / sensiBel SB-POLARIS</div>
    </div>
  );
}
