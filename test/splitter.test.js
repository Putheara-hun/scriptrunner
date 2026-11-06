import test from 'node:test';
import assert from 'node:assert/strict';
import { splitScript } from '../lib/splitter.js';
import { decodeScript } from '../lib/decode.js';

const sql = (items) => items.filter((item) => item.kind === 'sql').map((item) => item.text);
const notes = (items) => items.filter((item) => item.kind === 'note');

test('SQL Server: splits on GO only, and keeps semicolons inside a batch', () => {
  const items = splitScript('CREATE TABLE a (id int);\nINSERT a VALUES (1);\nGO\nSELECT 1\ngo\n', 'mssql');
  assert.deepEqual(sql(items), ['CREATE TABLE a (id int);\nINSERT a VALUES (1);', 'SELECT 1']);
});

test('SQL Server: GO inside a string or comment is not a separator', () => {
  const script = "SELECT '\nGO\n' AS a\n/*\nGO\n*/\nSELECT 2\n-- GO\nGO\nSELECT 3";
  const items = splitScript(script, 'mssql');
  assert.equal(sql(items).length, 2);
  assert.ok(sql(items)[0].includes("'\nGO\n'"));
  assert.ok(sql(items)[0].includes('SELECT 2'));
});

test('SQL Server: nested block comments, bracket identifiers and a word starting with GO', () => {
  const script = "/* a /* b */\nGO\n*/ SELECT [odd'name] FROM t\nGOTO label\nGO\nSELECT 2";
  const items = splitScript(script, 'mssql');
  assert.equal(sql(items).length, 2);
  assert.ok(sql(items)[0].includes('GOTO label'));
});

test('SQL Server: GO 5 repeats, trailing comment allowed, comment-only batches dropped', () => {
  const items = splitScript('-- only a comment\nGO\nINSERT t DEFAULT VALUES\nGO 5\nSELECT 1\nGO -- done\n', 'mssql');
  const statements = items.filter((item) => item.kind === 'sql');
  assert.equal(statements.length, 2);
  assert.equal(statements[0].repeat, 5);
  assert.equal(statements[0].line, 3);
  assert.equal(statements[1].repeat, undefined);
});

test('SQL Server: leading comments stay in the batch so line numbers match the file', () => {
  const items = splitScript('GO\n-- header\n\nSELECT 1\n', 'mssql');
  assert.equal(items[0].line, 2);
  assert.equal(items[0].text, '-- header\n\nSELECT 1');
});

test('SQL Server: sqlcmd directives are cut out of the batch and reported', () => {
  const items = splitScript('SELECT 1\n:setvar x 1\nSELECT 2\nGO\n:r other.sql\n', 'mssql');
  assert.deepEqual(sql(items), ['SELECT 1\n\nSELECT 2']);
  assert.deepEqual(notes(items).map((note) => note.text), [':setvar x 1', ':r other.sql']);
});

test('CRLF line endings are handled', () => {
  assert.equal(sql(splitScript('SELECT 1\r\nGO\r\nSELECT 2\r\nGO\r\n', 'mssql')).length, 2);
  assert.deepEqual(sql(splitScript('BEGIN x; END;\r\n/\r\nSELECT 1 FROM dual;\r\n', 'oracle')), [
    'BEGIN x; END;',
    'SELECT 1 FROM dual',
  ]);
});

test('Oracle: plain SQL loses its semicolon, a following slash does not run it twice', () => {
  const items = splitScript('CREATE TABLE a (id NUMBER);\n/\nINSERT INTO a VALUES (1);\nCOMMIT;\n', 'oracle');
  assert.deepEqual(sql(items), ['CREATE TABLE a (id NUMBER)', 'INSERT INTO a VALUES (1)', 'COMMIT']);
});

test('Oracle: PL/SQL keeps its semicolons and ends at the slash', () => {
  const script = `CREATE OR REPLACE PROCEDURE p AS
  v NUMBER;
BEGIN
  v := 1;
END;
/
BEGIN
  NULL;
END;
/
DECLARE
  x NUMBER;
BEGIN
  x := 2;
END;
/
SELECT 1 FROM dual;`;
  const statements = sql(splitScript(script, 'oracle'));
  assert.equal(statements.length, 4);
  assert.ok(statements[0].endsWith('END;'));
  assert.ok(statements[0].includes('v := 1;'));
  assert.equal(statements[1], 'BEGIN\n  NULL;\nEND;');
  assert.equal(statements[3], 'SELECT 1 FROM dual');
});

test('Oracle: other PL/SQL object types count as blocks, tables and views do not', () => {
  for (const head of [
    'CREATE TRIGGER t BEFORE INSERT ON a BEGIN NULL; END;',
    'CREATE OR REPLACE EDITIONABLE FUNCTION f RETURN NUMBER AS BEGIN RETURN 1; END;',
    'CREATE OR REPLACE PACKAGE BODY p AS PROCEDURE x IS BEGIN NULL; END; END;',
    'CREATE TYPE o AS OBJECT (a NUMBER);',
  ]) {
    assert.deepEqual(sql(splitScript(`${head}\n/\n`, 'oracle')), [head]);
  }
  assert.deepEqual(sql(splitScript('CREATE VIEW v AS SELECT 1 x FROM dual;\n', 'oracle')), [
    'CREATE VIEW v AS SELECT 1 x FROM dual',
  ]);
});

test('Oracle: q-quotes, and semicolons or slashes in strings and comments', () => {
  const script = "SELECT q'[it's; here]' FROM dual;\nSELECT 'a;\n/\nb' FROM dual;\n/* ;\n/\n*/ SELECT 3 FROM dual;";
  const statements = sql(splitScript(script, 'oracle'));
  assert.equal(statements.length, 3);
  assert.equal(statements[0], "SELECT q'[it's; here]' FROM dual");
  assert.equal(statements[1], "SELECT 'a;\n/\nb' FROM dual");
  assert.equal(statements[2], 'SELECT 3 FROM dual');
});

test('Oracle: SQL*Plus commands are ignored or flagged, real SET statements are kept', () => {
  const script = `SET DEFINE OFF
SPOOL out.log
PROMPT it's; loading
REM a remark
WHENEVER SQLERROR EXIT FAILURE
@other.sql
SET TRANSACTION READ ONLY;
UPDATE a
SET x = 1;
COMMENT ON TABLE a IS 'x';
SPOOL OFF`;
  const items = splitScript(script, 'oracle');
  assert.deepEqual(sql(items), ['SET TRANSACTION READ ONLY', 'UPDATE a\nSET x = 1', "COMMENT ON TABLE a IS 'x'"]);
  assert.deepEqual(notes(items).map((note) => note.text), ['@other.sql']);
});

test('Oracle: EXEC becomes a block', () => {
  assert.deepEqual(sql(splitScript('EXEC my_proc(1, 2);\n', 'oracle')), ['BEGIN my_proc(1, 2); END;']);
});

test('Oracle: EXIT ends the script, and only warns if something follows it', () => {
  const clean = splitScript('SELECT 1 FROM dual;\nEXIT;\n', 'oracle');
  assert.equal(notes(clean).length, 0);
  const early = splitScript('SELECT 1 FROM dual;\nEXIT\nSELECT 2 FROM dual;\n', 'oracle');
  assert.deepEqual(sql(early), ['SELECT 1 FROM dual']);
  assert.equal(notes(early).length, 1);
});

test('PostgreSQL: dollar quoting keeps a function body whole', () => {
  const script = `CREATE FUNCTION f() RETURNS int AS $$
BEGIN
  RETURN 1;
END;
$$ LANGUAGE plpgsql;
DO $body$ BEGIN PERFORM 1; $$ not the end; END $body$;
SELECT 1;`;
  const statements = sql(splitScript(script, 'postgres'));
  assert.equal(statements.length, 3);
  assert.ok(statements[0].endsWith('LANGUAGE plpgsql'));
  assert.equal(statements[2], 'SELECT 1');
});

test('PostgreSQL: E-strings, nested comments, $1 and semicolons in parentheses', () => {
  const script = "SELECT E'a\\';b';\n/* x /* y; */ ; */ SELECT 2;\nPREPARE p AS SELECT $1;\nCREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2);";
  const statements = sql(splitScript(script, 'postgres'));
  assert.equal(statements.length, 4);
  assert.equal(statements[1], 'SELECT 2');
  assert.ok(statements[3].endsWith('SELECT 2)'));
});

test('PostgreSQL: a backslash in an ordinary string is not an escape', () => {
  assert.deepEqual(sql(splitScript("SELECT 'c:\\';SELECT 2;", 'postgres')), ["SELECT 'c:\\'", 'SELECT 2']);
});

test('PostgreSQL: psql commands, and COPY FROM stdin is reported with its data skipped', () => {
  const script = `\\restrict abc
\\connect mydb
SET x = 1;
COPY a (id) FROM stdin;
1
2;3
\\.
SELECT 1;
\\unrestrict abc`;
  const items = splitScript(script, 'postgres');
  assert.deepEqual(sql(items), ['SET x = 1', 'SELECT 1']);
  assert.deepEqual(notes(items).map((note) => note.text), ['\\connect mydb']);
  const errors = items.filter((item) => item.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 4);
});

test('MySQL: DELIMITER, backslash strings, comment rules and executable comments', () => {
  const script = `/*!40101 SET NAMES utf8 */;
-- comment; here
# another; one
SELECT 'it\\'s;', \`a;b\`, "c\\";d", 5--1;
DELIMITER $$
CREATE PROCEDURE p()
BEGIN
  SELECT 1;
END$$
DELIMITER ;
SELECT 2;`;
  const statements = sql(splitScript(script, 'mysql'));
  assert.equal(statements.length, 4);
  assert.equal(statements[0], '/*!40101 SET NAMES utf8 */');
  assert.ok(statements[1].endsWith('5--1'));
  assert.ok(statements[2].includes('SELECT 1;'));
  assert.equal(statements[3], 'SELECT 2');
});

test('MySQL: source is flagged, and a plain comment is not treated as a statement', () => {
  const items = splitScript('/* nothing */;\nsource other.sql\nSELECT 1;\n', 'mysql');
  assert.deepEqual(sql(items), ['SELECT 1']);
  assert.equal(notes(items).length, 1);
});

test('line numbers point at the real line in the file', () => {
  const items = splitScript('-- one\n\nSELECT 1;\n\nSELECT\n  2;\n', 'postgres');
  assert.deepEqual(items.map((item) => item.line), [3, 5]);
});

test('a final statement with no terminator is still run', () => {
  for (const type of ['mssql', 'oracle', 'postgres', 'mysql']) {
    assert.deepEqual(sql(splitScript('SELECT 1', type)), ['SELECT 1'], type);
  }
});

test('empty scripts and comment-only scripts produce nothing', () => {
  for (const type of ['mssql', 'oracle', 'postgres', 'mysql']) {
    assert.deepEqual(splitScript('', type), [], type);
    assert.deepEqual(splitScript('  \n-- nothing\n/* here */\n', type), [], type);
  }
});

test('decode: BOMs, UTF-16 without a BOM, UTF-8 and Windows-1252', () => {
  const text = 'SELECT 1';
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.from(le).swap16();

  assert.deepEqual(decodeScript(Buffer.concat([Buffer.from([0xff, 0xfe]), le])), { text, encoding: 'UTF-16 LE' });
  assert.deepEqual(decodeScript(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), { text, encoding: 'UTF-16 BE' });
  assert.deepEqual(decodeScript(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), {
    text,
    encoding: 'UTF-8',
  });
  assert.equal(decodeScript(le).encoding, 'UTF-16 LE');
  assert.equal(decodeScript(be).encoding, 'UTF-16 BE');
  assert.equal(decodeScript(Buffer.from('SELECT \'ខ្មែរ\'')).text, "SELECT 'ខ្មែរ'");

  const legacy = decodeScript(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(legacy.text, 'café');
  assert.equal(legacy.guessed, true);
});
