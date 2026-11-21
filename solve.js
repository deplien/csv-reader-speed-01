// solve.js — a fast, dependency-free CSV reader whose run(input) returns, for an input {text, header},
// exactly what csv-reader 1.0.0 returns: {columns, rows, errors}. The reading policy is csv-reader's own:
//
//   - the text is read once, left to right; a U+FEFF at its very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled: "" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF; what follows the closing quote, up to the
//     next comma or line break, is appended as it stands (error quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it is read again as unquoted
//     (error unterminated_quote); a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (error short_row, with fields: its field count)
//     or cut (error long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on
//     (counting every LF, CRLF and lone CR inside quotes), row its record's index in rows, null for the
//     header; a record's short_row or long_row is recorded when the record ends.
//
// Where the reference builds every field a character at a time, this reader scans with indexOf: a record
// whose line holds no quote and no stray CR is split on its commas directly, and quoted or broken fields
// are assembled from slices between the few characters that matter. The answers are identical to the
// reference's; only the work differs.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF
  // is dropped (stray_cr). Returns the field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let start = pos; // the start of the not-yet-copied stretch
    let parts = null; // stretches copied so far, once a stray CR has split the field
    let added = 0;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      const ri = text.indexOf('\r', pos);
      let m = -1;
      let ch = '';
      if (ci !== -1) { m = ci; ch = ','; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; ch = '\n'; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; ch = '\r'; }
      if (m === -1) {
        const seg = text.slice(start, n);
        added += seg.length;
        pos = n;
        return { value: parts === null ? value + seg : value + parts.join('') + seg, ended: END, added };
      }
      if (ch === '\r' && text[m + 1] !== '\n') {
        // A lone CR outside quotes is dropped, and the field is read on in stretches.
        error('stray_cr');
        if (parts === null) parts = [];
        parts.push(text.slice(start, m));
        added += m - start;
        pos = m + 1;
        start = pos;
        continue;
      }
      const seg = text.slice(start, m);
      added += seg.length;
      const out = parts === null ? value + seg : value + parts.join('') + seg;
      if (ch === ',') {
        pos = m + 1;
        return { value: out, ended: COMMA, added };
      }
      // LF, or CRLF read as one line break.
      line += 1;
      pos = ch === '\n' ? m + 1 : m + 2;
      return { value: out, ended: LINE_BREAK, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let scan = pos + 1; // the next character to examine
    let segStart = scan; // the start of the stretch not yet copied
    let parts = null; // stretches copied so far, once a doubled quote or a CR has split the field
    for (;;) {
      const qi = text.indexOf('"', scan);
      const ri = text.indexOf('\r', scan);
      const ni = text.indexOf('\n', scan);
      let m = -1;
      let ch = '';
      if (qi !== -1) { m = qi; ch = '"'; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; ch = '\r'; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; ch = '\n'; }
      if (m === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as
        // unquoted (the line count of the failed scan is given back first).
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (ch === '\n') {
        // An LF inside quotes stays in the stretch as it stands; only the line count moves.
        line += 1;
        scan = m + 1;
        continue;
      }
      if (ch === '\r') {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, m), '\n');
        line += 1;
        scan = text[m + 1] === '\n' ? m + 2 : m + 1;
        segStart = scan;
        continue;
      }
      if (text[m + 1] === '"') {
        // A doubled quote is one quote in the value.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, m), '"');
        scan = m + 2;
        segStart = scan;
        continue;
      }
      // The closing quote.
      const value = parts === null ? text.slice(segStart, m) : parts.join('') + text.slice(segStart, m);
      pos = m + 1;
      if (pos >= n) return { value, ended: END };
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        return { value, ended: COMMA };
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;

    // Fast path: when the record's own line holds no quote and no CR but its line break's, the record
    // is read by splitting the line on its commas — no field of it can be quoted, junked or stray.
    let lineEnd = text.indexOf('\n', pos);
    const eofLine = lineEnd === -1;
    if (eofLine) lineEnd = n;
    const qi = text.indexOf('"', pos);
    const ri = text.indexOf('\r', pos);
    const crlf = ri === lineEnd - 1 && !eofLine; // the line's only CR is its own CRLF ending
    const plain = (qi === -1 || qi > lineEnd) && (ri === -1 || ri > lineEnd || crlf);
    if (plain) {
      const contentEnd = crlf ? lineEnd - 1 : lineEnd;
      fields = [];
      let f = pos;
      for (;;) {
        const cm = text.indexOf(',', f);
        if (cm === -1 || cm > contentEnd) {
          fields.push(text.slice(f, contentEnd));
          break;
        }
        fields.push(text.slice(f, cm));
        f = cm + 1;
      }
      pos = eofLine ? n : lineEnd + 1;
      if (!eofLine) line += 1;
    } else {
      fields = [];
      let field;
      do {
        quoted = text[pos] === '"';
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
