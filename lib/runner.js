import { decodeScript } from './decode.js';
import { splitScript } from './splitter.js';
import { connectionErrorMessage, describeConnectionFailure, openConnection } from './drivers/index.js';

const PREVIEW_LENGTH = 160;
const MAX_ERROR_SQL_LENGTH = 4000;

function preview(sql) {
  // Show the statement itself rather than whatever comment header sits above it.
  const body = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '') || sql;
  const singleLine = body.replace(/\s+/g, ' ').trim();
  return singleLine.length > PREVIEW_LENGTH ? `${singleLine.slice(0, PREVIEW_LENGTH)}…` : singleLine;
}

// Runs one script on its own connection, the same as `sqlcmd -i` or `psql -f`:
// session settings, temp tables and any transaction left open end with the file.
//
// Reports progress through `emit`. The last event is always { type: 'end' }.
export async function runScript({ config, bytes, continueOnError, transaction, emit, isStopped }) {
  const startedAt = Date.now();
  let executed = 0;
  let failed = 0;
  let warnings = 0;
  let stopped = false;
  let rolledBack = false;

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
      const totals = { rows: 0, affected: 0, more: false, messages: [], warning: undefined };
      let statementFailed = false;
      const runs = item.repeat ?? 1;

      for (let run = 0; run < runs; run++) {
        if (run > 0 && isStopped()) {
          stopped = true;
          break;
        }
        try {
          const result = await connection.execute(item);
          totals.rows += result.rows ?? 0;
          totals.affected += result.affected ?? 0;
          totals.more ||= Boolean(result.more);
          totals.messages.push(...(result.messages ?? []));
          totals.warning ??= result.warning;
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
    // Begin, commit or rollback failed, usually because the connection dropped.
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
      // Already gone. Nothing useful left to do with it.
    }
  }

  if (failed > 0) finish('error');
  else if (stopped) finish('stopped');
  else if (warnings > 0) finish('warning');
  else finish('ok');
}
