/**
 * yaml-mini — minimal YAML subset parser (~120 LOC, zero deps).
 *
 * Supports exactly what `mpl.config.yaml` needs:
 *   - Top-level + nested block-style mappings (`key: value`)
 *   - Block-style sequences (`- value` or `- key: value`)
 *   - Scalars: int, float, bool, null, single/double-quoted, bare strings
 *   - Inline `{}` (empty map) and `[]` (empty list)
 *   - `#` line + trailing comments (when outside quotes)
 *   - Indentation via leading spaces (tabs rejected)
 *
 * NOT supported (intentionally — keeps surface small):
 *   - Anchors / aliases / tags (`&`, `*`, `!!`)
 *   - Flow-style mappings beyond the empty `{}` / `[]` shapes
 *   - Multi-line scalars (`|`, `>`)
 *   - Document separators (`---`, `...`)
 *
 * Public API:
 *   parseYaml(text: string): object
 *
 * Throws `SyntaxError` with line numbers on malformed input.
 */

const COMMENT = /(?:^|[^"'])#.*$/;

function stripComment(line) {
  // Walk char-by-char to respect quotes.
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inS) inD = !inD;
    else if (c === "'" && !inD) inS = !inS;
    else if (c === '#' && !inS && !inD) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s === '{}') return {};
  if (s === '[]') return [];
  // Quoted strings
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Integers (with optional underscore separators per YAML 1.2)
  if (/^-?\d[\d_]*$/.test(s)) {
    const n = Number(s.replace(/_/g, ''));
    if (Number.isFinite(n)) return n;
  }
  // Floats
  if (/^-?(?:\d+\.\d*|\.\d+|\d+(?:\.\d+)?[eE][-+]?\d+)$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < line.length && line[i] === '\t') {
    throw new SyntaxError(`yaml-mini: tabs not allowed for indentation`);
  }
  return i;
}

export function parseYaml(text) {
  if (typeof text !== 'string') throw new TypeError('parseYaml: text must be string');

  // Tokenize: array of { indent, content, lineNo } for non-blank, non-comment lines.
  const tokens = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripComment(rawLines[i]);
    if (stripped.trim() === '') continue;
    tokens.push({ indent: indentOf(stripped), content: stripped.trimEnd(), lineNo: i + 1 });
  }

  // Recursive descent. `idx` is a cursor object so children mutate it.
  const cursor = { i: 0 };

  function parseBlock(parentIndent) {
    // Decide container shape from first child token.
    if (cursor.i >= tokens.length) return null;
    const first = tokens[cursor.i];
    if (first.indent <= parentIndent) return null;
    const blockIndent = first.indent;
    const isSeq = first.content.slice(blockIndent).startsWith('- ') ||
                  first.content.slice(blockIndent) === '-';
    return isSeq ? parseSeq(blockIndent) : parseMap(blockIndent);
  }

  function parseMap(blockIndent) {
    const out = {};
    while (cursor.i < tokens.length) {
      const tok = tokens[cursor.i];
      if (tok.indent < blockIndent) break;
      if (tok.indent > blockIndent) {
        throw new SyntaxError(`yaml-mini: unexpected indent at line ${tok.lineNo}`);
      }
      const body = tok.content.slice(blockIndent);
      const colon = findKeyColon(body);
      if (colon === -1) {
        throw new SyntaxError(`yaml-mini: expected 'key:' at line ${tok.lineNo}`);
      }
      const key = body.slice(0, colon).trim();
      const after = body.slice(colon + 1).trim();
      cursor.i++;
      if (after === '') {
        // Value lives on subsequent more-indented lines (map | seq | empty).
        const child = parseBlock(blockIndent);
        out[key] = child === null ? null : child;
      } else {
        out[key] = parseScalar(after);
      }
    }
    return out;
  }

  function parseSeq(blockIndent) {
    const out = [];
    while (cursor.i < tokens.length) {
      const tok = tokens[cursor.i];
      if (tok.indent < blockIndent) break;
      if (tok.indent > blockIndent) {
        throw new SyntaxError(`yaml-mini: unexpected indent at line ${tok.lineNo}`);
      }
      const body = tok.content.slice(blockIndent);
      if (!body.startsWith('-')) break;
      const after = body === '-' ? '' : body.slice(2);   // skip '- '
      cursor.i++;
      if (after === '') {
        const child = parseBlock(blockIndent);
        out.push(child === null ? null : child);
      } else if (findKeyColon(after) !== -1) {
        // '- key: value' — inline single-key map; subsequent more-indented
        // lines belong to that same map item.
        const colon = findKeyColon(after);
        const key = after.slice(0, colon).trim();
        const rest = after.slice(colon + 1).trim();
        const item = {};
        item[key] = rest === '' ? (parseBlock(blockIndent + 2) ?? null) : parseScalar(rest);
        // Continue gathering additional keys nested deeper than '- '.
        while (cursor.i < tokens.length) {
          const nxt = tokens[cursor.i];
          if (nxt.indent <= blockIndent) break;
          // Borrow parseMap at the child indent.
          const subMap = parseMap(nxt.indent);
          Object.assign(item, subMap);
        }
        out.push(item);
      } else {
        out.push(parseScalar(after));
      }
    }
    return out;
  }

  // Find the ':' that terminates a mapping key (skip colons inside quotes).
  function findKeyColon(s) {
    let inS = false, inD = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' && !inS) inD = !inD;
      else if (c === "'" && !inD) inS = !inS;
      else if (c === ':' && !inS && !inD) {
        // Must be followed by space or end-of-line to count as key terminator.
        if (i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t') return i;
      }
    }
    return -1;
  }

  if (tokens.length === 0) return {};
  // Top-level always a map for our schema; allow leading indent 0.
  return parseMap(0);
}
