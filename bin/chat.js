#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');

const root = path.resolve(__dirname, '..');

function usage() {
  console.log(`Chat Engineering Harness

Usage:
  chat [run] [--mode app|code]     Start an interactive chat
  chat verify [test|lint|typecheck|build ...]
  chat brain search <query>
  chat brain list
  chat config

Interactive commands:
  /help                 Show commands
  /new                  Start a new conversation
  /sessions             List saved conversations
  /resume <session-id>   Continue a saved conversation
  /mode app|code        Switch between App and Code modes
  /project [path]       Show or change the project directory
  /tools on|off         Enable or disable tools for this run
  /status               Show current configuration
  /exit                 Quit
`);
}

async function verify(args) {
  const { ALLOWED_SCRIPTS, verifyProject } = require('../backend/verification');
  const requested = args.length ? args : undefined;
  if (requested?.some(name => !ALLOWED_SCRIPTS.has(name))) {
    throw new Error('Allowed verification scripts: test, lint, typecheck, build.');
  }
  const report = await verifyProject({ root, scripts: requested, task: 'CLI verification run' });
  for (const result of report.results) {
    console.log(`\n${result.status.toUpperCase()} ${result.name} (${result.durationMs} ms)`);
    if (result.output) console.log(result.output);
  }
  console.log(`\nVerification ${report.status}: ${report.reward.passed}/${report.reward.total} checks (${report.reward.score.toFixed(2)})`);
  console.log(`Receipt saved to: ${report.receiptPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

function brain(args) {
  const [action, ...terms] = args;
  const { db } = require('../backend/db');
  const memory = require('../backend/memory');
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'").get()) {
      throw new Error('Memory store is not initialized. Start Chat once before using brain commands.');
    }
    if (action === 'list') {
      console.log(JSON.stringify(memory.getRecentMemories(db, { ownerId: 'local', limit: 50 }), null, 2));
    } else if (action === 'search' && terms.length) {
      const rows = memory.searchMemory(db, { ownerId: 'local', query: terms.join(' '), limit: 20 });
      console.log(rows.length ? JSON.stringify(rows, null, 2) : 'No matching memories.');
    } else {
      throw new Error('Use "chat brain search <query>" or "chat brain list".');
    }
  } finally {
    db.close();
  }
}

function showConfig() {
  const filename = path.join(root, '.chat', 'config.json');
  const text = fs.readFileSync(filename, 'utf8');
  console.log(text);
}

function initializeCli() {
  require('dotenv').config({ path: path.join(root, 'backend', '.env') });
  const { db } = require('../backend/db');
  const { initializeDatabase } = require('../backend/initialize-database');
  const { DEFAULTS, normalizeSettings } = require('../backend/providers');
  const saved = initializeDatabase(db);
  const settings = normalizeSettings(saved ? {
    provider: saved.provider,
    model: saved.model,
    baseUrl: saved.base_url,
    temperature: saved.temperature,
    maxTokens: saved.max_tokens,
    toolsEnabled: saved.tools_enabled !== 0,
    inferenceEngine: saved.inference_engine || 'auto'
  } : {}, DEFAULTS);
  return { db, settings };
}

function showStatus(settings, mode, sessionId) {
  const { getWorkspaceDir } = require('../backend/tools');
  console.log(`Provider: ${settings.provider} · Model: ${settings.model}`);
  console.log(`Mode: ${mode} · Tools: ${settings.toolsEnabled ? 'on' : 'off'}`);
  console.log(`Project: ${getWorkspaceDir()}`);
  console.log(`Session: ${sessionId || '(new)'}`);
}

function listSessions(db) {
  const sessions = db.prepare(`SELECT id,title,mode,updated_at AS updatedAt
    FROM sessions WHERE owner_id='local' ORDER BY updated_at DESC LIMIT 20`).all();
  if (!sessions.length) return console.log('No saved conversations.');
  for (const session of sessions) {
    console.log(`${session.id}  [${session.mode}]  ${session.title}  (${session.updatedAt})`);
  }
}

function createStreamResponse({ onSession, onToken }) {
  let buffer = '';
  let wroteToken = false;
  const response = {
    writableEnded: false,
    status() { return this; },
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      buffer += String(chunk);
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (!event || !data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (event === 'session') onSession(payload);
        if (event === 'token') {
          if (!wroteToken) process.stdout.write('\nassistant> ');
          wroteToken = true;
          process.stdout.write(payload.text || '');
          onToken();
        }
        if (event === 'tool_start') {
          if (wroteToken) process.stdout.write('\n');
          console.log(`[tool] ${payload.name}`);
          wroteToken = false;
        }
        if (event === 'tool_result') {
          console.log(`[${payload.ok ? 'done' : 'error'}] ${payload.preview || payload.name}`);
        }
        if (event === 'error') {
          if (wroteToken) process.stdout.write('\n');
          console.error(`\nChat error: ${payload.error}`);
          wroteToken = false;
        }
        if (event === 'done') {
          if (!wroteToken && payload.text) {
            process.stdout.write(`\nassistant> ${payload.text}`);
          }
          if (wroteToken || payload.text) process.stdout.write('\n');
          wroteToken = false;
        }
      }
      return true;
    },
    end() { this.writableEnded = true; },
    json(payload) {
      if (payload?.error) console.error(`Chat error: ${payload.error}`);
      this.writableEnded = true;
    }
  };
  return response;
}

async function interactive(args) {
  const { db, settings } = initializeCli();
  const { runHarness } = require('../backend/harness');
  const { getWorkspaceDir, setWorkspaceDir, persistWorkspaceDir } = require('../backend/tools');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  rl.setPrompt('you> ');
  let mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : args.includes('--code') ? 'code' : 'app';
  if (!['app', 'code'].includes(mode)) {
    rl.close();
    db.close();
    throw new Error('Mode must be app or code.');
  }
  let sessionId = null;
  let toolsEnabled = settings.toolsEnabled !== false;
  let activeRequest = null;
  const interrupt = () => {
    if (activeRequest) {
      activeRequest.emit('close');
      activeRequest = null;
      console.log('\nGeneration stopped.');
    } else {
      console.log('\nUse /exit to quit.');
    }
  };
  rl.on('SIGINT', interrupt);
  console.log(`Chat CLI · ${settings.provider}/${settings.model} · ${mode} mode`);
  console.log('Type /help for commands. Conversations are saved locally.');
  rl.prompt();

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('/')) {
        const [command, ...parts] = line.slice(1).split(/\s+/);
        const argument = parts.join(' ');
        if (command === 'help') usage();
        else if (command === 'exit' || command === 'quit') break;
        else if (command === 'new') {
          sessionId = null;
          console.log('Started a new conversation.');
        } else if (command === 'sessions') listSessions(db);
        else if (command === 'resume') {
          const found = db.prepare("SELECT id,mode FROM sessions WHERE id=? AND owner_id='local'").get(argument);
          if (!found) console.error('Session not found.');
          else {
            sessionId = found.id;
            mode = found.mode;
            console.log(`Resumed ${sessionId} in ${mode} mode.`);
          }
        } else if (command === 'mode') {
          if (!['app', 'code'].includes(argument)) console.error('Use /mode app or /mode code.');
          else {
            mode = argument;
            console.log(`Switched to ${mode} mode.`);
          }
        } else if (command === 'project') {
          if (!argument) console.log(getWorkspaceDir());
          else {
            try {
              const projectPath = setWorkspaceDir(argument);
              persistWorkspaceDir();
              console.log(`Project directory: ${projectPath}`);
            } catch (error) { console.error(`Could not change project: ${error.message}`); }
          }
        } else if (command === 'tools') {
          if (!['on', 'off'].includes(argument)) console.error('Use /tools on or /tools off.');
          else if (argument === 'on' && settings.toolsEnabled === false) console.error('Tools are disabled in the saved app settings.');
          else {
            toolsEnabled = argument === 'on';
            console.log(`Tools ${toolsEnabled ? 'enabled' : 'disabled'} for this run.`);
          }
        } else if (command === 'status') showStatus({ ...settings, toolsEnabled: settings.toolsEnabled && toolsEnabled }, mode, sessionId);
        else console.error(`Unknown command: /${command}. Type /help for help.`);
        rl.prompt();
        continue;
      }

      const req = new EventEmitter();
      req.headers = { accept: 'text/event-stream' };
      activeRequest = req;
      let outputReceived = false;
      const res = createStreamResponse({
        onSession: payload => { sessionId = payload.sessionId; },
        onToken: () => { outputReceived = true; }
      });
      await runHarness({
        req,
        res,
        db,
        ownerId: 'local',
        settings,
        body: { prompt: line, mode, sessionId, stream: true, toolsEnabled }
      });
      activeRequest = null;
      if (!outputReceived && !res.writableEnded) process.stdout.write('\n');
      rl.prompt();
    }
  } finally {
    activeRequest?.emit('close');
    rl.close();
    db.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') return usage();
  if (!command) return interactive(args);
  if (command === 'run') return interactive(args);
  if (command === '--code' || command === '--mode') return interactive([command, ...args]);
  if (command === 'chat') return interactive(args);
  if (command === 'verify') return verify(args);
  if (command === 'brain') return brain(args);
  if (command === 'config') return showConfig();
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`chat: ${error.message}`);
  process.exitCode = 1;
});
