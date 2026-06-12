/* Subsequence fuzzy scorer — VERBATIM port of the legacy palette's Cmdk._score
   (shell.js:152-163). Same loop, same constants, same formula:

     score = 100 + bestRun*5 - firstIndex - (label.length - hits) * 0.1

   where bestRun is the longest contiguous matched run, firstIndex is where the
   match starts in the label, and hits is the number of matched chars (the
   query length on success). Returns -1 when the query is not a subsequence of
   the label, 0 for an empty query. */

export function fuzzyScore(label: string, q: string): number {
  label = label.toLowerCase();
  q = q.toLowerCase();
  if (!q) return 0;
  let li = 0;
  let run = 0;
  let best = 0;
  let first = -1;
  let hits = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = false;
    while (li < label.length) {
      if (label[li] === c) {
        if (first < 0) first = li;
        found = true;
        run++;
        best = Math.max(best, run);
        li++;
        hits++;
        break;
      } else {
        run = 0;
        li++;
      }
    }
    if (!found) return -1;
  }
  return 100 + best * 5 - first - (label.length - hits) * 0.1;
}
