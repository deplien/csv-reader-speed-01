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
// Where the reference builds every field a character at a time, this reader works a record at a time,
// and every search it runs is bounded by the stretch it is reading — a search for a rare character can
// never go scanning the rest of the file. One native search finds the end of the record's first line; a
// record whose line holds no quote and no CR but its own CRLF is split on its commas in one native
// call. A record that does hold quotes is read field by field with one bounded search per field: a
// plain field hops to its comma, a simply-quoted field to its closing quote and is sliced out whole.
// Tangled fields — doubled quotes or CRs inside quotes, junk after a closing quote, a stray CR — are
// assembled from slices of the line. Only a field whose quote outlives its line (a multi-line note, or
// a quote that never closes) falls to the whole-text scanners, and even those first find the field's
// own end and then work inside slices of it, so their searches stay bounded too. The answers are
// identical to the reference's; only the work differs.

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

  // The stretch text[a, b) as a quoted field holds it: each CRLF and lone CR in it is one LF, an LF
  // stands as it is. Returns the stretch so read, and how many line breaks it held.
  function quotedStretch(a, b) {
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1) {
      // No CR: the stretch stands as it is; only its LFs count.
      let breaks = 0;
      let p = seg.indexOf('\n');
      while (p !== -1) {
        breaks += 1;
        p = seg.indexOf('\n', p + 1);
      }
      return { value: seg, breaks };
    }
    const parts = [];
    let last = 0;
    let breaks = 0;
    let p = 0;
    for (;;) {
      const ri = seg.indexOf('\r', p);
      const ni = seg.indexOf('\n', p);
      if (ri === -1 && ni === -1) break;
      if (ni !== -1 && (ri === -1 || ni < ri)) {
        breaks += 1; // an LF stands as it is; only the count moves
        p = ni + 1;
        continue;
      }
      parts.push(seg.slice(last, ri), '\n');
      breaks += 1;
      p = seg.charCodeAt(ri + 1) === 10 ? ri + 2 : ri + 1;
      last = p;
    }
    parts.push(seg.slice(last));
    return { value: parts.join(''), breaks };
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF
  // is dropped (stray_cr). Returns the field and how it ended; `added` counts the characters kept.
  // Whole-text scanner: used for junk after a closing quote that spans lines, and for the re-read of a
  // quote that never closes. It first finds the field's end, then drops the CRs inside that stretch.
  function readUnquoted(value) {
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end;
    let ended;
    if (ci !== -1 && (ni === -1 || ci < ni)) {
      end = ci;
      ended = COMMA;
    } else if (ni !== -1) {
      end = ni;
      ended = LINE_BREAK;
    } else {
      end = n;
      ended = END;
    }
    // The field's characters end at end, less the CR of a CRLF the break is made of.
    const contentEnd = ended === LINE_BREAK && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const seg = text.slice(pos, contentEnd);
    let added = seg.length;
    if (seg.indexOf('\r') === -1) {
      value += seg;
    } else {
      // Every CR left in the stretch is a lone one (a CR followed by LF would have been the break):
      // each is dropped, with its error.
      const parts = [];
      let from = 0;
      let p = seg.indexOf('\r');
      while (p !== -1) {
        error('stray_cr');
        parts.push(seg.slice(from, p));
        added -= 1;
        from = p + 1;
        p = seg.indexOf('\r', from);
      }
      parts.push(seg.slice(from));
      value += parts.join('');
    }
    pos = ended === COMMA ? end + 1 : ended === LINE_BREAK ? ni + 1 : n;
    if (ended === LINE_BREAK) line += 1;
    return { value, ended, added };
  }

  // Reads a quoted field whose opening quote is at pos, wherever it closes — a later line, or never.
  // The closing quote is found first, and the content before it is read stretch by stretch between
  // quote candidates, so no search runs past the field itself.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let segStart = open + 1; // the start of the content stretch not yet read
    let scan = segStart; // where the next quote candidate is sought
    let parts = null; // stretches read so far, once a break or a doubled quote has split the field
    for (;;) {
      const qi = text.indexOf('"', scan);
      if (qi === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as
        // unquoted (the line count of the failed scan is given back first).
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(qi + 1) === 34) {
        // A doubled quote: the content before it, then one quote of the field's own.
        const seg = quotedStretch(segStart, qi);
        line += seg.breaks;
        if (parts === null) parts = [];
        parts.push(seg.value, '"');
        scan = qi + 2;
        segStart = scan;
        continue;
      }
      // The closing quote.
      const seg = quotedStretch(segStart, qi);
      line += seg.breaks;
      const value = parts === null ? seg.value : parts.join('') + seg.value;
      pos = qi + 1;
      if (pos >= n) return { value, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
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

  // Reads an unquoted stretch of lineStr from `a` to its comma or the line's content end, dropping
  // lone CRs (stray_cr). Shared by plain fields that hold a CR and by junk after a closing quote.
  // eof says the line runs to the text's end (its fields end END, not LINE_BREAK).
  function scanBareInLine(lineStr, contentLimit, eof, a) {
    let js = a;
    let segStart = a;
    let parts = null;
    let kept = 0;
    for (;;) {
      let ci = lineStr.indexOf(',', js);
      if (ci === -1 || ci >= contentLimit) ci = -1;
      let ri = lineStr.indexOf('\r', js);
      if (ri === -1 || ri >= contentLimit) ri = -1; // a CR at contentLimit is the CRLF's: the stretch ends there
      if (ri !== -1 && (ci === -1 || ri < ci)) {
        error('stray_cr');
        if (parts === null) parts = [];
        parts.push(lineStr.slice(segStart, ri));
        kept += ri - segStart;
        js = ri + 1;
        segStart = js;
        continue;
      }
      const end = ci === -1 ? contentLimit : ci;
      const tail = lineStr.slice(segStart, end);
      kept += tail.length;
      const value = parts === null ? tail : parts.join('') + tail;
      if (ci !== -1) return { value, kept, ended: COMMA, next: ci + 1 };
      return { value, kept, ended: eof ? END : LINE_BREAK, next: -1 };
    }
  }

  // Reads the quoted field opening at i in lineStr, when it closes on that same line: returns the
  // field (with lineDelta, the lines its own CRs added, and crOut, the line's first CR at or after
  // the field), or null — having changed nothing — when the quote outlives the line and readQuoted
  // must read it instead. crIn is the line's first CR at or after i, or -1.
  function scanQuotedInLine(lineStr, contentLimit, eof, i, crIn) {
    let s = i + 1;
    let segStart = s;
    let parts = null;
    let lineDelta = 0;
    let crInLine = crIn;
    for (;;) {
      const qi = lineStr.indexOf('"', s);
      if (qi === -1) return null; // no closing quote on this line
      let ri = crInLine;
      if (ri !== -1 && ri < s) {
        ri = lineStr.indexOf('\r', s);
        crInLine = ri;
      }
      if (ri !== -1 && ri < qi) {
        // A lone CR inside the quotes (a CR before the closing quote is never the line's CRLF, which
        // sits at contentLimit, past every quote on the line): it reads as one LF.
        if (parts === null) parts = [];
        parts.push(lineStr.slice(segStart, ri), '\n');
        lineDelta += 1;
        s = ri + 1;
        segStart = s;
        continue;
      }
      if (lineStr.charCodeAt(qi + 1) === 34) {
        // A doubled quote is one quote in the value.
        if (parts === null) parts = [];
        parts.push(lineStr.slice(segStart, qi), '"');
        s = qi + 2;
        segStart = s;
        continue;
      }
      // The closing quote.
      const value = parts === null ? lineStr.slice(segStart, qi) : parts.join('') + lineStr.slice(segStart, qi);
      const a = qi + 1;
      if (a >= contentLimit) return { value, ended: eof ? END : LINE_BREAK, next: -1, lineDelta, crOut: crInLine };
      if (lineStr.charCodeAt(a) === 44) return { value, ended: COMMA, next: a + 1, lineDelta, crOut: crInLine };
      // What follows the closing quote is appended as it stands.
      const junk = scanBareInLine(lineStr, contentLimit, eof, a);
      if (junk.kept > 0) error('quote_junk');
      return { value: value + junk.value, ended: junk.ended, next: junk.next, lineDelta, crOut: crInLine };
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first line, as a window: searches inside it never scan past its end. contentLimit
    // is the line's length without the CR of its own CRLF ending, when it has one.
    let nl = text.indexOf('\n', pos);
    let lineEnd = nl === -1 ? n : nl;
    let lineStr = text.slice(pos, lineEnd);
    let hasCRLF = nl !== -1 && lineStr.charCodeAt(lineStr.length - 1) === 13;
    let contentLimit = hasCRLF ? lineStr.length - 1 : lineStr.length;
    let crInLine = lineStr.indexOf('\r'); // the line's first CR, or -1

    let fields;
    let lastQuoted = false;

    if (lineStr.indexOf('"') === -1 && (crInLine === -1 || crInLine >= contentLimit)) {
      // A plain record: no quote anywhere on its line, and no CR but its ending's. Split it whole.
      fields = lineStr.slice(0, contentLimit).split(',');
      pos = nl === -1 ? n : lineEnd + 1;
      if (nl !== -1) line += 1;
    } else {
      fields = [];
      let winStart = pos; // the absolute position lineStr starts at
      let i = 0; // the next field's start within lineStr

      for (;;) {
        if (crInLine !== -1 && crInLine < i) crInLine = lineStr.indexOf('\r', i);
        let value;
        let ended;
        let next = -1;
        if (i < lineStr.length && lineStr.charCodeAt(i) === 34) {
          lastQuoted = true;
          const r = scanQuotedInLine(lineStr, contentLimit, nl === -1, i, crInLine);
          if (r === null) {
            // The quote outlives this line: readQuoted reads the field from its opening quote, and
            // the record goes on from wherever it leaves the text.
            pos = winStart + i;
            const w = readQuoted();
            fields.push(w.value);
            if (w.ended !== COMMA) break;
            winStart = pos;
            nl = text.indexOf('\n', pos);
            lineEnd = nl === -1 ? n : nl;
            lineStr = text.slice(pos, lineEnd);
            hasCRLF = nl !== -1 && lineStr.charCodeAt(lineStr.length - 1) === 13;
            contentLimit = hasCRLF ? lineStr.length - 1 : lineStr.length;
            crInLine = lineStr.indexOf('\r');
            i = 0;
            continue;
          }
          line += r.lineDelta;
          crInLine = r.crOut;
          value = r.value;
          ended = r.ended;
          next = r.next;
        } else {
          lastQuoted = false;
          let ci = lineStr.indexOf(',', i);
          if (ci === -1 || ci >= contentLimit) ci = -1;
          const fieldEnd = ci === -1 ? contentLimit : ci;
          if (crInLine !== -1 && crInLine >= i && crInLine < fieldEnd) {
            const r = scanBareInLine(lineStr, contentLimit, nl === -1, i);
            value = r.value;
            ended = r.ended;
            next = r.next;
          } else {
            value = lineStr.slice(i, fieldEnd);
            ended = ci === -1 ? (nl === -1 ? END : LINE_BREAK) : COMMA;
            next = ci + 1;
          }
        }
        fields.push(value);
        if (ended === COMMA) {
          i = next;
          continue;
        }
        pos = ended === LINE_BREAK ? lineEnd + 1 : n;
        if (ended === LINE_BREAK) line += 1;
        break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
