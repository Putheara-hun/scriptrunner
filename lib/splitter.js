// Splits a script into what each database's own client would send to the server.
//
// Drivers run one statement at a time, so the jobs normally done by sqlcmd,
// SQL*Plus, psql and the mysql client have to happen here: finding statement
// boundaries without being fooled by strings or comments, and dealing with
// client-only commands such as GO, "/", DELIMITER, \connect or SPOOL.
//
// Returns a list of items in script order:
//   { kind: 'sql',   text, line, repeat? }  send this to the server
//   { kind: 'note',  text, line, message }  client command that was not run
//   { kind: 'error', text, line, message }  something that cannot be run here

const ORACLE_PLSQL_START =
  /^(?:DECLARE\b|BEGIN\b|<<|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY)\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:AND\s+(?:RESOLVE|COMPILE)\s+)?(?:NOFORCE\s+)?JAVA\b)/i;

// SQL*Plus commands that only affect display or session formatting.
const SQLPLUS_IGNORED =
  /^(?:REM(?:ARK)?|PRO(?:MPT)?|SET\s+(?!TRANSACTION\b|ROLE\b|CONSTRAINTS?\b)\S+|SPO(?:OL)?|COL(?:UMN)?|TTI(?:TLE)?|BTI(?:TLE)?|BRE(?:AK)?|COMP(?:UTE)?|CL(?:EAR)?|SHO(?:W)?|DESC(?:RIBE)?|PAU(?:SE)?|TIMING|UNDEF(?:INE)?|WHENEVER)\b/i;

// SQL*Plus commands that change what the script does. Skipping these matters.
const SQLPLUS_NOT_RUN =
  /^(?:@|(?:STA(?:RT)?|CONN(?:ECT)?|DISC(?:ONNECT)?|HO(?:ST)?|ACC(?:EPT)?|VAR(?:IABLE)?|PRINT|DEF(?:INE)?)\b)/i;

const SQLPLUS_EXIT = /^(?:EXIT|QUIT)\b/i;
const SQLPLUS_EXEC = /^EXEC(?:UTE)?\s+(.+?)\s*;?\s*$/i;

const PSQL_IGNORED = /^\\(?:set|unset|echo|qecho|timing|pset|encoding|x|t|a|f|o|restrict|unrestrict)\b/i;
const COPY_FROM_STDIN = /^COPY\b[\s\S]*\bFROM\s+STDIN\b/i;

const NOT_RUN_MESSAGE = 'Client command, not run by this tool.';

function isIdentifierChar(ch) {
  return ch !== undefined && /[\w$#\u0080-￿]/.test(ch);
}

function endOfLine(text, from) {
  const eol = text.indexOf('\n', from);
  return eol === -1 ? text.length : eol;
}

function skipClosing(text, from, closing) {
  const end = text.indexOf(closing, from);
  return end === -1 ? text.length : end + closing.length;
}

function skipBackslashString(text, from, quote) {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === quote) return i + 1;
    else i++;
  }
  return text.length;
}

function skipNestedComment(text, from) {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    if (text[i] === '/' && text[i + 1] === '*') {
      depth++;
      i += 2;
    } else if (text[i] === '*' && text[i + 1] === '/') {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

const ORACLE_Q_CLOSERS = { '[': ']', '{': '}', '(': ')', '<': '>' };
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;

// If a comment or quoted token starts at `i`, returns where it ends. Nothing
// inside one of these can end a statement.
function skipLexeme(text, i, type) {
  const c = text[i];
  const next = text[i + 1];

  if (c === '-' && next === '-') {
    // MySQL only treats "--" as a comment when whitespace follows it.
    const after = text[i + 2];
    if (type !== 'mysql' || after === undefined || /\s/.test(after)) {
      return { end: endOfLine(text, i), comment: true };
    }
  }
  if (c === '#' && type === 'mysql') {
    return { end: endOfLine(text, i), comment: true };
  }
  if (c === '/' && next === '*') {
    if (type === 'mssql' || type === 'postgres') {
      return { end: skipNestedComment(text, i + 2), comment: true };
    }
    // MySQL runs the contents of /*! ... */ and /*M! ... */, so they are code.
    const executable =
      type === 'mysql' && (text[i + 2] === '!' || (text[i + 2] === 'M' && text[i + 3] === '!'));
    return { end: skipClosing(text, i + 2, '*/'), comment: !executable };
  }

  if (c === "'") {
    const before = text[i - 1];
    const isEscapeString =
      type === 'postgres' && (before === 'e' || before === 'E') && !isIdentifierChar(text[i - 2]);
    if (type === 'mysql' || isEscapeString) {
      return { end: skipBackslashString(text, i + 1, "'") };
    }
    return { end: skipClosing(text, i + 1, "'") };
  }
  if (c === '"') {
    if (type === 'mysql') return { end: skipBackslashString(text, i + 1, '"') };
    return { end: skipClosing(text, i + 1, '"') };
  }
  if (c === '`' && type === 'mysql') {
    return { end: skipClosing(text, i + 1, '`') };
  }
  if (c === '[' && type === 'mssql') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === ']') {
        if (text[j + 1] !== ']') return { end: j + 1 };
        j += 2;
      } else {
        j++;
      }
    }
    return { end: text.length };
  }
  if ((c === 'q' || c === 'Q') && next === "'" && type === 'oracle') {
    const before = text[i - 1];
    const isPrefixed = before === 'n' || before === 'N';
    if (!isIdentifierChar(before) || (isPrefixed && !isIdentifierChar(text[i - 2]))) {
      const open = text[i + 2];
      if (open !== undefined) {
        return { end: skipClosing(text, i + 3, `${ORACLE_Q_CLOSERS[open] ?? open}'`) };
      }
    }
  }
  if (c === '$' && type === 'postgres' && !isIdentifierChar(text[i - 1])) {
    DOLLAR_TAG.lastIndex = i;
    const tag = DOLLAR_TAG.exec(text);
    if (tag) return { end: skipClosing(text, i + tag[0].length, tag[0]) };
  }
  return null;
}

function makeLineLookup(text) {
  const starts = [0];
  let at = -1;
  while ((at = text.indexOf('\n', at + 1)) !== -1) starts.push(at + 1);
  return (position) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

export function splitScript(text, type) {
  const items = [];
  const lineAt = makeLineLookup(text);
  const length = text.length;

  let i = 0;
  let start = -1; // where the current statement's text begins
  let hasContent = false; // false while it is only comments
  let parenDepth = 0;
  let delimiter = ';';
  let atLineStart = true;
  let finished = false;
  let holes = []; // client-command lines inside a T-SQL batch, cut out on flush

  function flush(end, extra) {
    if (start >= 0 && hasContent) {
      let sql = '';
      let from = start;
      for (const [holeStart, holeEnd] of holes) {
        sql += text.slice(from, holeStart);
        from = holeEnd;
      }
      sql += text.slice(from, end);
      items.push({ kind: 'sql', text: sql.trimEnd(), line: lineAt(start), ...extra });
    }
    start = -1;
    hasContent = false;
    parenDepth = 0;
    holes = [];
  }

  function note(at, lineText) {
    items.push({ kind: 'note', text: lineText, line: lineAt(at), message: NOT_RUN_MESSAGE });
  }

  // A client "exit" ends the script, as it would in the real client. Only worth
  // flagging when there is something after it that will now not run.
  function exitScript(at, eol, lineText) {
    flush(at);
    if (text.slice(eol).trim()) {
      items.push({
        kind: 'note',
        text: lineText,
        line: lineAt(at),
        message: 'The script exits here, so the lines after it were not run.',
      });
    }
    finished = true;
  }

  // Client commands live on their own line. Returns true if this line was one.
  function handleCommandLine(lineStart, eol) {
    const line = text.slice(lineStart, eol).trim();
    if (!line) return false;

    if (type === 'mssql') {
      const go = /^GO(?:\s+(\d+))?\s*(?:--.*)?$/i.exec(line);
      if (go) {
        flush(lineStart, go[1] ? { repeat: Number(go[1]) } : undefined);
        return true;
      }
      if (/^:(?:exit|quit)\b/i.test(line)) {
        exitScript(lineStart, eol, line);
        return true;
      }
      if (/^(?::[a-z]|!!)/i.test(line)) {
        note(lineStart, line);
        if (start >= 0) holes.push([lineStart, eol]);
        return true;
      }
      return false;
    }

    if (type === 'oracle') {
      if (line === '/') {
        flush(lineStart);
        return true;
      }
      if (start >= 0) return false;
      if (SQLPLUS_EXIT.test(line)) {
        exitScript(lineStart, eol, line);
        return true;
      }
      if (SQLPLUS_IGNORED.test(line)) return true;
      if (SQLPLUS_NOT_RUN.test(line)) {
        note(lineStart, line);
        return true;
      }
      const exec = SQLPLUS_EXEC.exec(line);
      if (exec) {
        items.push({ kind: 'sql', text: `BEGIN ${exec[1]}; END;`, line: lineAt(lineStart) });
        return true;
      }
      return false;
    }

    if (start >= 0) return false;

    if (type === 'postgres' && line[0] === '\\') {
      if (/^\\q\b/i.test(line)) exitScript(lineStart, eol, line);
      else if (!PSQL_IGNORED.test(line)) note(lineStart, line);
      return true;
    }

    if (type === 'mysql') {
      const custom = /^DELIMITER\s+(\S+)/i.exec(line);
      if (custom) {
        delimiter = custom[1];
        return true;
      }
      if (/^(?:\\q|(?:quit|exit)\s*;?)$/i.test(line)) {
        exitScript(lineStart, eol, line);
        return true;
      }
      if (line[0] === '\\' || /^source\s/i.test(line)) {
        note(lineStart, line);
        return true;
      }
    }
    return false;
  }

  function isOraclePlsql() {
    return start >= 0 && ORACLE_PLSQL_START.test(text.slice(start, start + 200));
  }

  while (i < length && !finished) {
    if (atLineStart) {
      atLineStart = false;
      const eol = endOfLine(text, i);
      if (handleCommandLine(i, eol)) {
        i = eol;
        continue;
      }
    }

    const c = text[i];
    if (c === '\n') {
      atLineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      i++;
      continue;
    }

    const lexeme = skipLexeme(text, i, type);
    if (lexeme) {
      // T-SQL keeps its leading comments so server line numbers stay accurate.
      if (start < 0 && (!lexeme.comment || type === 'mssql')) start = i;
      if (!lexeme.comment) hasContent = true;
      i = lexeme.end;
      continue;
    }

    if (type === 'postgres') {
      if (c === '(') parenDepth++;
      else if (c === ')' && parenDepth > 0) parenDepth--;
    }

    let isDelimiter = false;
    if (type === 'mysql') isDelimiter = text.startsWith(delimiter, i);
    else if (c === ';' && type === 'oracle') isDelimiter = !isOraclePlsql();
    else if (c === ';' && type === 'postgres') isDelimiter = parenDepth === 0;

    if (isDelimiter) {
      if (type === 'postgres' && start >= 0 && COPY_FROM_STDIN.test(text.slice(start, i))) {
        items.push({
          kind: 'error',
          text: text.slice(start, i),
          line: lineAt(start),
          message:
            'COPY ... FROM stdin cannot be run from this tool, so its data was skipped. Export again with pg_dump --inserts.',
        });
        start = -1;
        hasContent = false;
        parenDepth = 0;
        const terminator = text.indexOf('\n\\.', i);
        i = terminator === -1 ? length : endOfLine(text, terminator + 1);
        continue;
      }
      flush(i);
      i += type === 'mysql' ? delimiter.length : 1;
      continue;
    }

    if (start < 0) start = i;
    hasContent = true;
    i++;
  }

  if (!finished) flush(length);
  return items;
}
