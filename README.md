# csv-reader, read faster

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/deplien/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/deplien/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

An entry for the make.fun bounty [csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
("Read broken CSV files faster, 21 November 2026"): a drop-in replacement for csv-reader 1.0.0 that
returns its exact answer for every input — `{columns, rows, errors}` for an input `{text, header}` —
and reads the text in a fraction of the reference's CPU time.

## The reading policy

The text is read once, left to right, exactly as csv-reader reads it:

- a U+FEFF at the very start is dropped; a record ends at LF or CRLF; a line left with no characters
  is no record;
- outside quotes, a CR not followed by LF is dropped (error `stray_cr`);
- a field that opens with a quote runs to the next quote that is not doubled: `""` inside it is one
  quote, and each CRLF or lone CR inside it is read as LF; what follows the closing quote, up to the
  next comma or line break, is appended as it stands (error `quote_junk`, when the field ends);
- a quote that never closes is a literal character, and the text after it is read again as unquoted
  (error `unterminated_quote`); a quote inside an unquoted field is a literal character;
- fields stay strings, never trimmed or converted;
- `columns` is the first record when `header` is true, else null; `rows` holds the records after it
  (every record when `header` is false), each padded with `""` (error `short_row`, with `fields`: its
  field count) or cut (error `long_row`, with `extra`: the cut fields) to the first record's width;
- each error is `{code, line, row}` in the order met: `line` the 1-based line its record starts on
  (counting every LF, CRLF and lone CR inside quotes), `row` its record's index in `rows`, null for
  the header.

## How it runs

```sh
node main.ts   # Node 22; reads /input/cases.json, writes /output/answers.json
```

`main.ts` is the driver the harness runs; `solve.js` is the reader itself — a dependency-free ES
module exporting `run(input)`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
stand in for `/input` and `/output`.

## Files

- `solve.js` — the reader: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver the harness runs (Node 22, TypeScript as it stands).
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entrant's claim file, naming the account's wallet.

## Why it is faster

The reference builds every field a character at a time. This reader scans with `indexOf` instead: a
record whose line holds no quote and no stray CR — the overwhelming majority — is split on its
commas directly, and quoted or broken fields are assembled from slices between the few characters
that matter (commas, quotes, CRs, LFs), so the per-character work is done by the engine's native
string search rather than by a JavaScript loop. The answers are csv-reader's, byte for byte; only
the work differs.
