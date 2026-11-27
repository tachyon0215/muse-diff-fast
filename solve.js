// muse-diff-fast: a faster drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly the patch makefun-diff 1.0.0 returns for
// { old, new }, byte for byte: same line splitting (cut after every "\n",
// "\r" belongs to its line, a trailing line without "\n" is a line of its
// own and differs from the same text with one), same common prefix/suffix
// trim, same Myers greedy search (furthest into the old text wins, a
// deletion wins a tie), same patch format with 3 lines of context, hunks
// merged across at most 6 kept lines, deletions before insertions in each
// change run, and a "%" line after any line written without its newline.
//
// The speed comes from doing the same search on small integers instead of
// strings and objects: each distinct line is interned once to an integer
// id, the search keeps its furthest-reach table in Int32Arrays, and the
// chosen path is recorded as one packed integer per step (the snake's
// start doubled, plus the move in the low bit) instead of a linked list
// of path objects, so the hot loop allocates nothing per step.

/** Lines of a text as split parts, plus whether the last line lacks "\n". */
function splitLines(text) {
  const parts = text.split('\n');
  let bare = false;
  if (parts[parts.length - 1] === '') parts.pop();
  else bare = true;
  if (text === '') { parts.length = 0; bare = false; }
  return { parts, bare };
}

/**
 * Intern both texts' lines to integer ids in one shared map.
 * Lines carrying their "\n" intern by their part text. A bare last line
 * never equals a line with a newline, so it gets a fresh unmapped id,
 * shared only with the other text's bare line when the parts are equal.
 */
function internPair(oldT, newT) {
  const map = new Map();
  let next = 0;
  const build = (t, otherBare) => {
    const { parts, bare } = t;
    const ids = new Int32Array(parts.length);
    const lastWithNewline = bare ? parts.length - 1 : parts.length;
    for (let i = 0; i < lastWithNewline; i++) {
      const p = parts[i];
      let id = map.get(p);
      if (id === undefined) { id = next++; map.set(p, id); }
      ids[i] = id;
    }
    let bareInfo = null;
    if (bare) {
      const p = parts[parts.length - 1];
      const bareId = otherBare !== null && otherBare.part === p ? otherBare.id : next++;
      ids[parts.length - 1] = bareId;
      bareInfo = { part: p, id: bareId };
    }
    return { ids, bareInfo };
  };
  const o = build(oldT, null);
  const n = build(newT, o.bareInfo);
  return { aIds: o.ids, bIds: n.ids };
}

// ---------------------------------------------------------------- Myers

const KEEP = 0;
const DEL = 1;
const INS = 2;

/**
 * The edit runs of aIds[aOff, aOff+N) into bIds[bOff, bOff+M), exactly the
 * runs makefun-diff's greedy search produces: for d = 0, 1, 2, ... and
 * each diagonal k = x - y, the candidate reaching furthest into the old
 * text (the deletion on a tie), no candidate past either text's end, then
 * the snake of lines equal in both. Returns a flat array
 * [kind, count, kind, count, ...] with adjacent kinds merged.
 */
function editRuns(aIds, aOff, N, bIds, bOff, M) {
  // One side empty: the other side is one pure run.
  if (N === 0) return M === 0 ? [] : [INS, M];
  if (M === 0) return [DEL, N];

  // Contiguous copies keep the hot loop free of base offsets.
  const a = aIds.slice(aOff, aOff + N);
  const b = bIds.slice(bOff, bOff + M);

  const width = N + M + 3;
  const off = M + 1; // diagonal k lives at index k + off
  const INVALID = -1073741824;
  let vPrev = new Int32Array(width).fill(INVALID);
  let vCur = new Int32Array(width).fill(INVALID);

  // The recorded path: step (d, s) with s = (k + d) / 2 sits at index
  // d*(d+1)/2 + s and packs the move that led onto it with the old-lines
  // count where its snake began: rec = startX * 2 + (move === INS).
  let cap = 1 << 20;
  let rec = new Int32Array(cap);

  // d = 0: the opening snake from (0, 0).
  let x = 0;
  while (x < N && x < M && a[x] === b[x]) x++;
  vPrev[off] = x;
  rec[0] = 0;
  if (x >= N && x >= M) return x > 0 ? [KEEP, x] : [];

  let foundD = -1;
  for (let d = 1; foundD < 0; d++) {
    const need = ((d + 1) * (d + 2)) / 2;
    if (need > cap) {
      while (cap < need) cap *= 2;
      const r2 = new Int32Array(cap); r2.set(rec); rec = r2;
    }
    const base = (d * (d + 1)) / 2;
    // No clearing pass: both tables start INVALID-filled and every
    // diagonal in [-d, d] is written below at each level (the dead branch
    // writes INVALID), while the reads one level later reach at most one
    // diagonal past either end, which no level has ever written a reach
    // into. So a stale reach can never be read.
    let vi = off - d;
    for (let s = 0, k = -d; k <= d; s++, k += 2, vi += 2) {
      const xDelPrev = vPrev[vi - 1];
      const xInsPrev = vPrev[vi + 1];
      const canDel = xDelPrev !== INVALID && xDelPrev < N;
      const canIns = xInsPrev !== INVALID && xInsPrev - k - 1 < M;
      if (!canDel && !canIns) { vCur[vi] = INVALID; continue; }
      let xs; // old-lines count right after the edit move, before the snake
      if (canDel && (!canIns || xDelPrev + 1 >= xInsPrev)) {
        xs = xDelPrev + 1;
        rec[base + s] = xs * 2; // DEL in the low bit as 0
      } else {
        xs = xInsPrev;
        rec[base + s] = xs * 2 + 1; // INS
      }
      // The snake: ny = nx - k stays in bounds while nx < min(N, M + k).
      const xLim = M + k < N ? M + k : N;
      let nx = xs;
      while (nx < xLim && a[nx] === b[nx - k]) nx++;
      vCur[vi] = nx;
      if (nx >= N && nx - k >= M) { foundD = d; break; }
    }
    const t = vPrev; vPrev = vCur; vCur = t;
    if (d > N + M) throw new Error('makefun-diff: the search ended without reaching both ends');
  }

  // Walk the recorded path back from (foundD, N, M), collecting segments
  // in reverse, then merge neighbours of the same kind.
  const rev = [];
  let cx = N;
  let cy = M;
  for (let d = foundD; d >= 1; d--) {
    const k = cx - cy;
    const code = rec[(d * (d + 1)) / 2 + (k + d) / 2];
    const xs = code >> 1;
    const snake = cx - xs;
    if (snake > 0) rev.push(KEEP, snake);
    const ys = xs - k;
    if ((code & 1) === 0) { rev.push(DEL, 1); cx = xs - 1; cy = ys; }
    else { rev.push(INS, 1); cx = xs; cy = ys - 1; }
  }
  if (cx > 0) rev.push(KEEP, cx);
  const runs = [];
  for (let i = rev.length - 2; i >= 0; i -= 2) {
    const kind = rev[i];
    const count = rev[i + 1];
    if (runs.length >= 2 && runs[runs.length - 2] === kind) runs[runs.length - 1] += count;
    else runs.push(kind, count);
  }
  return runs;
}

// ---------------------------------------------------------------- patch

const CONTEXT = 3;

/**
 * makefun-diff 1.0.0's patch of input.old into input.new.
 * Mirrors the reference's own construction: prefix/suffix trim, the
 * search above on what is left, change runs (deletions before insertions
 * — the runs already alternate so a change run just totals each stretch),
 * hunks merged across at most 2 * CONTEXT kept lines with CONTEXT kept
 * lines of margin, and the header line.
 */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldT = splitLines(input.old);
  const newT = splitLines(input.new);
  const { aIds, bIds } = internPair(oldT, newT);
  const aParts = oldT.parts;
  const bParts = newT.parts;
  const n = aParts.length;
  const m = bParts.length;

  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  // Flat run list for the whole script: prefix keep, the middle search,
  // suffix keep. Kinds at the seams may repeat; the change scan below
  // treats consecutive keeps as one, exactly like the reference's runs.
  const runs = [];
  if (prefix > 0) runs.push(KEEP, prefix);
  const mid = editRuns(aIds, prefix, n - prefix - suffix, bIds, prefix, m - prefix - suffix);
  for (let i = 0; i < mid.length; i++) runs.push(mid[i]);
  if (suffix > 0) runs.push(KEEP, suffix);

  // Change runs: each stretch of deletions/insertions between keeps, at
  // old line o and new line p, with its deleted and inserted totals.
  const chO = [];
  const chP = [];
  const chD = [];
  const chI = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const kind = runs[i];
    const count = runs[i + 1];
    if (kind === KEEP) { o += count; p += count; continue; }
    const last = chO.length - 1;
    if (last < 0 || chO[last] + chD[last] !== o || chP[last] + chI[last] !== p) {
      chO.push(o); chP.push(p); chD.push(0); chI.push(0);
    }
    if (kind === DEL) { chD[chD.length - 1] += count; o += count; deleted += count; }
    else { chI[chI.length - 1] += count; p += count; inserted += count; }
  }

  // Hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunkFirst = [];
  const hunkLast = [];
  for (let c = 0; c < chO.length; c++) {
    if (c > 0 && chO[c] - (chO[c - 1] + chD[c - 1]) <= 2 * CONTEXT) hunkLast[hunkLast.length - 1] = c;
    else { hunkFirst.push(c); hunkLast.push(c); }
  }
  const hunks = hunkFirst.length;

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks} deleted=${deleted} inserted=${inserted}\n`];
  // A line as written: its op and text with a newline, plus "%\n" when the
  // line is its text's bare last line (no newline of its own).
  const aBare = oldT.bare;
  const bBare = newT.bare;
  const writeKeep = (at) => { out.push('=' + aParts[at] + '\n'); if (aBare && at === n - 1) out.push('%\n'); };
  const writeDel = (at) => { out.push('-' + aParts[at] + '\n'); if (aBare && at === n - 1) out.push('%\n'); };
  const writeIns = (at) => { out.push('+' + bParts[at] + '\n'); if (bBare && at === m - 1) out.push('%\n'); };

  for (let h = 0; h < hunks; h++) {
    const first = hunkFirst[h];
    const last = hunkLast[h];
    const oldStart = Math.max(0, chO[first] - CONTEXT);
    const newStart = chP[first] - (chO[first] - oldStart);
    const after = Math.min(CONTEXT, n - (chO[last] + chD[last]));
    const oldEnd = chO[last] + chD[last] + after;
    const newEnd = chP[last] + chI[last] + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let c = first; c <= last; c++) {
      for (; at < chO[c]; at++) writeKeep(at);
      for (let i = 0; i < chD[c]; i++) writeDel(chO[c] + i);
      for (let i = 0; i < chI[c]; i++) writeIns(chP[c] + i);
      at = chO[c] + chD[c];
    }
    for (; at < oldEnd; at++) writeKeep(at);
  }
  return out.join('');
}
