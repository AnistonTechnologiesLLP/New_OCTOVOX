/* Library toolbar — live filter (clear affordance), the four legacy sorts and
   the file-count readout (legacy files-toolbar, index.html:176-192 and
   app.js:707-746). */

import type { RefObject } from 'react';

export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name', label: 'Name A-Z' },
  { value: 'winrate', label: 'Recently cleaned' },
] as const;

export type SortMode = (typeof SORT_OPTIONS)[number]['value'];

export function isSortMode(v: string): v is SortMode {
  return SORT_OPTIONS.some((o) => o.value === v);
}

interface FilesToolbarProps {
  filter: string;
  onFilterChange: (v: string) => void;
  onClearFilter: () => void;
  sort: SortMode;
  onSortChange: (v: SortMode) => void;
  countText: string;
  filterRef: RefObject<HTMLInputElement>;
}

export default function FilesToolbar({
  filter,
  onFilterChange,
  onClearFilter,
  sort,
  onSortChange,
  countText,
  filterRef,
}: FilesToolbarProps) {
  return (
    <div className="files-toolbar">
      <div className="files-filter">
        <input
          ref={filterRef}
          type="text"
          placeholder="Filter files...  ( / )"
          autoComplete="off"
          spellCheck={false}
          aria-label="Filter files"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
        />
        {filter !== '' && (
          <button
            type="button"
            className="filter-clear"
            title="Clear"
            aria-label="Clear filter"
            onClick={onClearFilter}
          >
            &times;
          </button>
        )}
      </div>
      <label className="files-sort">
        <span className="files-sort-label">sort</span>
        <select
          value={sort}
          aria-label="Sort files"
          onChange={(e) => {
            const v = e.target.value;
            if (isSortMode(v)) onSortChange(v);
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="files-count">{countText}</div>
    </div>
  );
}
