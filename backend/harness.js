const { randomUUID } = require('crypto');
const { completeTurn, completeTurnWithFallback } = require('./providers');
const { executeTool, parseToolCalls, stripToolMarkup } = require('./tools');
const memory = require('./memory');
const skills = require('./skills');
const context = require('./context');

const MAX_ROUNDS = 12;
const HISTORY_LIMIT = 30;

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function loadHistory(db, sessionId) {
  const rows = db.prepare('SELECT role, content, status FROM messages WHERE session_id = ? ORDER BY id').all(sessionId);
  const messages = [];
  for (const row of rows) {
    if (row.status === 'error') continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    messages.push({ role: row.role, content: row.content });
  }
  return messages.slice(-HISTORY_LIMIT);
}

function previewTool(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 180);
}

async function runHarness({ req, res, db, ownerId, settings, body }) {
  const mode = body?.mode || 'app';
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const stream = body?.stream === true || (req.headers.accept || '').includes('text/event-stream');
  const toolsEnabled = body?.toolsEnabled !== false && settings.toolsEnabled !== false;
  if (!prompt) {
    res.status(400).json({ error: 'Prompt is required.' });
    return;
  }
  if (prompt.length > 100000) {
    res.status(413).json({ error: 'Prompt and attachments must be under 100,000 characters.' });
    return;
  }
  if (!['app', 'code'].includes(mode)) {
    res.status(400).json({ error: 'Unsupported run mode.' });
    return;
  }

  let sessionId = body?.sessionId;
  if (!sessionId) {
    sessionId = randomUUID();
    db.prepare('INSERT INTO sessions (id,owner_id,title,mode) VALUES (?,?,?,?)').run(sessionId, ownerId, prompt.slice(0, 72), mode);
  } else {
    const exists = db.prepare('SELECT id,title FROM sessions WHERE id = ? AND owner_id = ?').get(sessionId, ownerId);
    if (!exists) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    if (exists.title === 'New session') db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(prompt.slice(0, 72), sessionId);
  }
  db.prepare('INSERT INTO messages (session_id,role,content,mode,status) VALUES (?,?,?,?,?)').run(sessionId, 'user', prompt, mode, 'ok');
  db.prepare('UPDATE sessions SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mode, sessionId);

  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    writeSse(res, 'session', { sessionId, mode });
  }

  const abort = new AbortController();
  const stop = () => abort.abort();
  req.on('close', stop);
  const emit = (event, data) => {
    if (stream && !res.writableEnded) writeSse(res, event, data);
  };

  let messages = loadHistory(db, sessionId);
  const toolsUsed = [];
  let finalText = '';
  let usage = null;
  let engine = settings.provider;
  let mock = false;
  let fallbackUsed = false;

  // Hermes Memory Injection
  const memoryContext = memory.buildMemoryContext(db, { ownerId, query: prompt });
  // Hermes Skill Discovery & Injection
  const skillContext = skills.buildSkillContext(db, prompt);

  // Hermes System Prompt Assembly
  const customSystemPrompt = body?.systemPrompt || '';
  const assembledSystem = context.buildSystemPrompt({
    mode,
    toolsEnabled,
    memoryContext,
    skillContext,
    customSystemPrompt
  });

  // Inject or update system message at head of history
  messages = messages.filter(m => m.role !== 'system');
  messages.unshift({ role: 'system', content: assembledSystem });

  const maxRounds = Number(body?.maxRounds) || MAX_ROUNDS;

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (abort.signal.aborted) throw new Error('Generation stopped.');

      // Hermes Context Window Protection & Compression
      if (context.shouldCompress(messages, settings.maxTokens ? settings.maxTokens * 4 : 8192)) {
        messages = context.pruneOldToolResults(messages, { keepLastN: 2 });
        messages = context.compressMiddleContext(messages);
      }

      emit('status', { message: round === 0 ? 'Calling model…' : `Continuing after tools (round ${round + 1})…` });
      let streamed = '';
      const result = await completeTurnWithFallback({
        mode,
        messages,
        settings,
        toolsEnabled,
        signal: abort.signal,
        onToken: stream ? (chunk) => {
          streamed += chunk;
          emit('token', { text: chunk });
        } : undefined
      });
      mock = Boolean(result.mock);
      engine = result.engine || engine;
      usage = result.usage || usage;
      if (result.fallbackUsed) fallbackUsed = true;

      const nativeCalls = (result.toolCalls || []).filter(call => call.name);
      const parsedCalls = nativeCalls.length ? nativeCalls : parseToolCalls(result.text);
      const visible = stripToolMarkup(result.text) || (parsedCalls.length ? '' : result.text);
      if (!stream && visible) streamed = visible;
      if (stream && !result.text && visible) emit('token', { text: visible });

      if (!parsedCalls.length) {
        finalText = visible || streamed || 'The provider returned no text.';
        break;
      }

      emit('replace', { text: visible });
      messages.push({
        role: 'assistant',
        content: result.text || '',
        tool_calls: parsedCalls
      });
      for (const call of parsedCalls) {
        emit('tool_start', { name: call.name, arguments: call.arguments || {} });
        let output;
        let ok = true;
        try {
          output = await executeTool(call.name, call.arguments || {}, { signal: abort.signal, db, ownerId });
        } catch (error) {
          ok = false;
          output = error.message;
        }
        toolsUsed.push({ name: call.name, ok, preview: previewTool(output) });
        emit('tool_result', { name: call.name, ok, preview: previewTool(output) });
        messages.push({
          role: 'tool',
          name: call.name,
          tool_call_id: call.id,
          content: ok ? output : `Tool error: ${output}`
        });
      }
      if (round === maxRounds - 1) {
        finalText = visible || 'Stopped after the tool-use limit. Ask me to continue.';
      }
    }

    // Hermes Closed Learning Loop: Check for persistence nudges
    const memoryNudges = memory.nudgeMemoryPersistence(db, { ownerId, messages });

    const meta = JSON.stringify({ tools: toolsUsed, usage, engine, mock, fallbackUsed, memoryNudges });
    db.prepare('INSERT INTO messages (session_id,role,content,mode,status,meta) VALUES (?,?,?,?,?,?)')
      .run(sessionId, 'assistant', finalText, mode, 'ok', meta);
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
    const payload = {
      sessionId,
      mode,
      provider: settings.provider,
      model: settings.model,
      status: 'ok',
      text: finalText,
      mock,
      engine,
      usage,
      fallbackUsed,
      tools: toolsUsed,
      memoryNudges
    };
    if (stream) {
      emit('done', payload);
      res.end();
    } else {
      res.json(payload);
    }
  } catch (error) {
    const message = `Request failed: ${error.message}`;
    db.prepare('INSERT INTO messages (session_id,role,content,mode,status) VALUES (?,?,?,?,?)')
      .run(sessionId, 'assistant', message, mode, 'error');
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
    if (stream) {
      emit('error', { sessionId, status: 'error', error: error.message, provider: settings.provider });
      if (!res.writableEnded) res.end();
    } else {
      res.status(502).json({ sessionId, status: 'error', error: error.message, provider: settings.provider });
    }
  } finally {
    req.off('close', stop);
  }
}

module.exports = { runHarness, loadHistory };
