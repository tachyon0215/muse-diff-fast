# muse-diff-fast

A faster drop-in replacement for makefun-diff 1.0.0, entered in the make.fun contest [Diff two texts faster, 27 November 2026](https://make.fun/c/diff-speed-01-run-20261126).

`run(input)` in [solve.js](solve.js) returns, for every `{ old, new }`, exactly the patch makefun-diff 1.0.0 returns — byte for byte, including its Myers greedy tie-break (furthest into the old text, a deletion on a tie), its 3-line-context hunks, and its "%" marker for a final line without a newline. [main.ts](main.ts) is the harness driver: it reads `/input/cases.json`, answers each case with `run`, and writes `/output/answers.json`.

## How it is faster

The reference search compares strings and builds a linked list of path objects at every step. This entry runs the identical search on small integers:

- Each distinct line is interned once to an integer id (a bare last line, which never equals the same text with a newline, gets its own id), so the hot loop compares integers, not strings.
- The furthest-reach table lives in `Int32Array`s; no per-step allocation.
- The chosen path is recorded as one packed integer per step — the snake's start doubled, with the move (deletion/insertion) in the low bit — instead of path/component objects, and the script is recovered by walking those integers back.
- The patch is then assembled with the reference's own hunk rules from the recovered runs.

Verified byte-identical to makefun-diff 1.0.0 on the contest's practice set and on thousands of randomized small cases (CRLF mixes, bare final lines, repeated lines, empty texts).

## License

Released under MIT — the full text lives in [LICENSE](LICENSE).
