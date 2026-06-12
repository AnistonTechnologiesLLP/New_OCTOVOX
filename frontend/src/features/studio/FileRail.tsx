/* Studio file rail (PORTING.md §7 master-detail): a compact, persistent file
   list beside the detail pane so switching files doesn't bounce through
   Library. Desktop-only (hidden < 1080px via studio.css). Cleaned files get
   a dot from the same /api/verdict winner map the Library rows use. */

import { useQuery } from '@tanstack/react-query';
import { goStudio } from '../../hooks/useHashRoute';
import { api } from '../../lib/api';

const stemOf = (name: string): string => name.replace(/\.wav$/i, '');

export default function FileRail({ stem }: { stem: string | null }) {
  const files = useQuery({ queryKey: ['files'], queryFn: api.listInput });
  const verdict = useQuery({ queryKey: ['verdict'], queryFn: api.verdict });

  const cleaned = new Set((verdict.data?.recordings ?? []).map((r) => r.stem));
  const list = [...(files.data?.files ?? [])].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));

  return (
    <aside className="studio-filerail card" aria-label="Files">
      <div className="filerail-head">Files</div>
      <div className="filerail-list">
        {list.map((f) => {
          const s = stemOf(f.name);
          return (
            <button
              key={f.name}
              className={`filerail-row${s === stem ? ' current' : ''}`}
              title={f.name}
              onClick={() => goStudio(s)}
            >
              <span className="filerail-name">{f.name}</span>
              {cleaned.has(s) && <span className="filerail-dot" title="Cleaned" />}
            </button>
          );
        })}
        {files.isSuccess && list.length === 0 && (
          <div className="filerail-empty muted">No files yet - capture or upload one.</div>
        )}
      </div>
    </aside>
  );
}
