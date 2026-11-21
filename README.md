# csv-reader-speed — a faster drop-in for csv-reader 1.0.0

A make.fun bounty entry: solve.js exports run(input) returning, for every input {text, header}, exactly the answer csv-reader 1.0.0 returns — {columns, rows, errors} — in a fraction of its CPU time.

[![make.fun bounty](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/deplien/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/deplien/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

## How it runs

```sh
node main.ts   # Node 22; reads /input/cases.json, writes /output/answers.json
```

`main.ts` is the driver the harness runs; `solve.js` is the reader itself — a dependency-free ES module exporting `run(input)`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Files

- `solve.js` — the reader: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver the harness runs (Node 22, TypeScript as it stands).
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entrant's claim file, naming the account's wallet.

## Why it is faster

The reference builds every field a character at a time, and a first fast version still hopped between three `indexOf` searches per field. This reader works a whole record at a time: one native scan finds the record's line, and a record with no quote and no stray CR is split on its commas in a single native call. Records that do hold quotes are read field by field with one search per field — a plain field hops to its comma, a simply-quoted field to its closing quote and is sliced out whole. Only the genuinely tangled fields (doubled quotes, CRs inside quotes, junk after a closing quote, a quote that spans lines or never closes) drop to a slice-assembling scan ported from the reference's own logic, and even there every search stays bounded by the field's own stretch, so no search ever scans the rest of the file hunting a rare character. The answers are csv-reader's, byte for byte; only the work differs.

## Verification

- Practice set: 6/6 cases identical to the reference under the kit's scorer.
- 220 fresh files drawn by the kit's own generator (four seeds) diffed against csv-reader 1.0.0: 0 differences.
- 25,000 small adversarial broken CSVs (random quotes, CRs, LFs, BOMs, junk after quotes, unterminated quotes, ragged rows, header on and off) diffed against csv-reader 1.0.0: 0 differences.
- Two runs of the driver over the practice set write byte-identical answers.
