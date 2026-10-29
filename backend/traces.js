const fs = require('fs');
const path = require('path');

const traceFile = path.resolve(__dirname, '..', '.chat', 'traces', 'executions.jsonl');
const MAX_TRACE_FIELD_CHARS = 100_000;

function captureEnabled() {
  return process.env.CHAT_CAPTURE_TRACES === '1';
}

function appendExecutionTrace(trace, { enabled = captureEnabled(), file = traceFile } = {}) {
  if (!enabled) return false;
  const record = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...trace
  };
  for (const field of ['prompt', 'response']) {
    if (typeof record[field] === 'string') record[field] = record[field].slice(0, MAX_TRACE_FIELD_CHARS);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return true;
}

module.exports = { traceFile, captureEnabled, appendExecutionTrace };
