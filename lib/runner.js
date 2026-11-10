import { decodeScript } from './decode.js';
import { splitScript } from './splitter.js';
import { connectionErrorMessage, describeConnectionFailure, openConnection } from './drivers/index.js';

const PREVIEW_LENGTH = 160;
const MAX_ERROR_SQL_LENGTH = 4000;
const RESULT_ROWS = 200;
const RESULT_ROWS_PER_RUN = 10000;
const MAX_CELL_LENGTH = 1000;

function cellText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > MAX_CELL_LENGTH ? `${value.slice(0, MAX_CELL_LENGTH)}…` : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex');
    return `0x${hex.length > 64 ? `${hex.slice(0, 64)}…` : hex}`;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_CELL_LENGTH ? `${json.slice(0, MAX_CELL_LENGTH)}…` : json;
  } catch {
    return String(value);
  }
}

function preview(sql) {

  const body = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '') || sql;
  const singleLine = body.replace(/\s+/g, ' ').trim();
  return singleLine.length > PREVIEW_LENGTH ? `${singleLine.slice(0, PREVIEW_LENGTH)}…` : singleLine;
}

export async function runScript({ config, bytes, continueOnError, transaction, emit, isStopped }) {
  const startedAt = Date.now();
  let executed = 0;
  let failed = 0;
  let warnings = 0;
  let stopped = false;
  let rolledBack = false;
  let previewBudget = RESULT_ROWS_PER_RUN;

  const finish = (status, extra) => {
    emit({
      type: 'end',
      status,
      executed,
      failed,
      warnings,
      rolledBack,
      ms: Date.now() - startedAt,
      ...extra,
    });
  };

  const { text, encoding, guessed } = decodeScript(bytes);
  const items = splitScript(text, config.type);
  const statementCount = items.filter((item) => item.kind === 'sql').length;
  emit({ type: 'start', statements: statementCount, encoding });

  if (guessed) {
    warnings++;
    emit({
      type: 'note',
      line: 1,
      message: `This file is not valid UTF-8, so it was read as ${encoding}. Check any accented or non-Latin text.`,
    });
  }
  if (items.length === 0) {
    warnings++;
    emit({ type: 'note', line: 1, message: 'No SQL statements found in this file.' });
    finish('warning');
    return;
  }

  let connection;
  try {
    connection = await openConnection(config);
  } catch (error) {
    failed++;
    finish('error', { error: { message: describeConnectionFailure(error, config) } });
    return;
  }

  const reportFailure = (item, error, ms) => {
    failed++;
    emit({
      type: 'stmt',
      status: 'error',
      line: item.line,
      preview: preview(item.text),
      sql: item.text.slice(0, MAX_ERROR_SQL_LENGTH),
      ms,
      messages: error.serverMessages ?? [],
      error: connection.describeError(error, item),
    });
  };

  try {
    if (transaction) await connection.begin();

    for (const item of items) {
      if (isStopped()) {
        stopped = true;
        break;
      }

      if (item.kind === 'note') {
        warnings++;
        emit({ type: 'note', line: item.line, text: item.text, message: item.message });
        continue;
      }

      if (item.kind === 'error') {
        failed++;
        emit({
          type: 'stmt',
          status: 'error',
          line: item.line,
          preview: preview(item.text),
          sql: item.text.slice(0, MAX_ERROR_SQL_LENGTH),
          ms: 0,
          messages: [],
          error: { message: item.message, line: item.line },
        });
        if (transaction || !continueOnError) break;
        continue;
      }

      const statementStartedAt = Date.now();
      const totals = { rows: 0, affected: 0, more: false, messages: [], warning: undefined, columns: undefined, data: undefined };
      let statementFailed = false;
      const runs = item.repeat ?? 1;

      for (let run = 0; run < runs; run++) {
        if (run > 0 && isStopped()) {
          stopped = true;
          break;
        }
        try {
          const wantRows = run === 0 ? Math.min(RESULT_ROWS, previewBudget) : 0;
          const result = await connection.execute(item, wantRows);
          totals.rows += result.rows ?? 0;
          totals.affected += result.affected ?? 0;
          totals.more ||= Boolean(result.more);
          totals.messages.push(...(result.messages ?? []));
          totals.warning ??= result.warning;
          if (run === 0 && result.columns) {
            totals.columns = result.columns;
            totals.data = (result.sample ?? []).map((cells) => cells.map(cellText));
            previewBudget -= totals.data.length;
          }
        } catch (error) {
          reportFailure(item, error, Date.now() - statementStartedAt);
          statementFailed = true;
          break;
        }
      }

      if (statementFailed) {
        if (transaction || !continueOnError) break;
        continue;
      }

      executed++;
      if (totals.warning) warnings++;
      emit({
        type: 'stmt',
        status: totals.warning ? 'warning' : 'ok',
        line: item.line,
        preview: preview(item.text),
        ms: Date.now() - statementStartedAt,
        runs: runs > 1 ? runs : undefined,
        ...totals,
      });
    }

    if (transaction) {
      if (failed > 0 || stopped) {
        await connection.rollback();
        rolledBack = true;
      } else {
        await connection.commit();
      }
    } else {
      await connection.finish();
    }
  } catch (error) {

    failed++;
    emit({
      type: 'note',
      level: 'error',
      line: 1,
      message: `The transaction could not be finished: ${connectionErrorMessage(error)}`,
    });
  } finally {
    try {
      await connection.close();
    } catch {

    }
  }

  if (failed > 0) finish('error');
  else if (stopped) finish('stopped');
  else if (warnings > 0) finish('warning');
  else finish('ok');
}
