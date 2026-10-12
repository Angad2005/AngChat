const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const workspaceDir = path.resolve(__dirname, '..');
const MAX_READ_BYTES = 100_000;
const MAX_WRITE_BYTES = 200_000;
const MAX_TOOL_CHARS = 24_000;
const MAX_SEARCH_HITS = 40;
const COMMAND_TIMEOUT_MS = 20_000;

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.cursor']);
const BLOCKED_RELATIVE = new Set([
  'backend/.env',
  'backend/chat.db',
  'backend/chat.db-wal',
  'backend/chat.db-shm'
]);

const TOOL_SCHEMAS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the AngChat workspace. Paths are relative to the project root unless absolute and still inside the workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        startLine: { type: 'integer', description: 'Optional 1-based start line.' },
        endLine: { type: 'integer', description: 'Optional 1-based end line, inclusive.' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_dir',
    description: 'List files and folders in a workspace directory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
        depth: { type: 'integer', description: 'How many directory levels to include. 1–3, default 1.' }
      }
    }
  },
  {
    name: 'search_files',
    description: 'Search workspace text files for a regular expression. Skips node_modules, .git, and model weights.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        path: { type: 'string', description: 'Directory or file to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Optional filename glob such as *.js or *.md.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the workspace. Does not write secrets, databases, or files outside the project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_command',
    description: 'Run a non-interactive shell command with the workspace as the working directory. Use for tests, builds, and local project commands. Output is truncated and the command is stopped after 20 seconds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Shell command to run.' }
      },
      required: ['command']
    }
  },
  {
    name: 'patch_file',
    description: 'Surgically replace target string content within an existing file. Safer and faster than write_file for targeted edits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        target: { type: 'string', description: 'Exact string snippet to find and replace.' },
        replacement: { type: 'string', description: 'Replacement string snippet.' }
      },
      required: ['path', 'target', 'replacement']
    }
  },
  {
    name: 'web_fetch',
    description: 'Fetch HTTP/HTTPS url and extract clean readable text or markdown content.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL to read.' }
      },
      required: ['url']
    }
  },
  {
    name: 'memory_store',
    description: 'Store a lasting fact, preference, or lesson learned into persistent memory (Hermes 5-layer memory).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: 'Information to remember.' },
        category: { type: 'string', enum: ['fact', 'preference', 'lesson', 'environment', 'project'], description: 'Category of memory.' },
        importance: { type: 'integer', description: '1 to 5 priority score.' }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_recall',
    description: 'Query persistent memory using full-text search to recall user preferences or previous project context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords to search in memory.' }
      },
      required: ['query']
    }
  },
  {
    name: 'skill_create',
    description: 'Author or refine a reusable procedural skill (Hermes self-improving skill loop).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Skill name (e.g. git-workflow, prisma-migration).' },
        description: { type: 'string', description: 'Summary of what skill accomplishes.' },
        instructions: { type: 'string', description: 'Step-by-step procedural guidelines.' }
      },
      required: ['name', 'instructions']
    }
  }
];

function toolsForMode(mode) {
  if (mode === 'code') return TOOL_SCHEMAS;
  return TOOL_SCHEMAS.filter(tool => tool.name !== 'write_file' && tool.name !== 'run_command');
}

function openaiTools(mode) {
  return toolsForMode(mode).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function anthropicTools(mode) {
  return toolsForMode(mode).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}

function geminiTools(mode) {
  return [{
    functionDeclarations: toolsForMode(mode).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }];
}

function toolPrompt(mode) {
  const tools = toolsForMode(mode);
  if (!tools.length) return '';
  return [
    'You can use workspace tools. When you need a tool, output one or more XML blocks and nothing else in those blocks:',
    '<tool_call>{"name":"tool_name","arguments":{}}</tool_call>',
    'Available tools:',
    JSON.stringify(tools, null, 2),
    'After tool results arrive, either call another tool or answer the user. Do not claim you read a file, listed a directory, searched, wrote a file, or ran a command unless a tool result is in the conversation.'
  ].join('\n');
}

function resolveWorkspacePath(inputPath = '.') {
  const requested = String(inputPath || '.').trim() || '.';
  const resolved = path.resolve(workspaceDir, requested);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('That path is outside the AngChat workspace.');
  }
  const normalized = relative.split(path.sep).join('/');
  if (BLOCKED_RELATIVE.has(normalized) || normalized.endsWith('.env')) {
    throw new Error('That file is blocked from tool access.');
  }
  return { resolved, relative: normalized || '.' };
}

function truncate(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_TOOL_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_CHARS)}\n… truncated after ${MAX_TOOL_CHARS} characters.`;
}

function globToRegExp(glob) {
  if (!glob) return null;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function readFileTool(args) {
  const { resolved, relative } = resolveWorkspacePath(args.path);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) throw new Error('Path is not a file.');
  if (stat.size > MAX_READ_BYTES * 4) throw new Error('File is too large to read with this tool.');
  const raw = await fs.promises.readFile(resolved);
  if (raw.includes(0)) throw new Error('Refusing to read a binary file.');
  let text = raw.toString('utf8');
  const startLine = Number.isInteger(args.startLine) ? Math.max(1, args.startLine) : 1;
  const lines = text.split(/\r?\n/);
  const endLine = Number.isInteger(args.endLine) ? Math.min(lines.length, args.endLine) : lines.length;
  if (startLine > 1 || endLine < lines.length) {
    text = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}| ${line}`).join('\n');
  }
  return truncate(`${relative} (${stat.size} bytes)\n${text}`);
}

async function listDirTool(args) {
  const { resolved, relative } = resolveWorkspacePath(args.path || '.');
  const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));
  const lines = [];
  async function walk(directory, level, prefix) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const label = prefix ? `${prefix}/${entry.name}` : entry.name;
      lines.push(entry.isDirectory() ? `${label}/` : label);
      if (entry.isDirectory() && level < depth) await walk(child, level + 1, label);
      if (lines.length >= 400) {
        lines.push('… listing truncated.');
        return true;
      }
    }
    return false;
  }
  const stat = await fs.promises.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Path is not a directory.');
  await walk(resolved, 1, '');
  return truncate(`${relative === '.' ? 'workspace' : relative}\n${lines.join('\n') || '(empty)'}`);
}

async function searchFilesTool(args) {
  let regex;
  try { regex = new RegExp(String(args.pattern), 'i'); }
  catch { throw new Error('Invalid regular expression.'); }
  const root = resolveWorkspacePath(args.path || '.').resolved;
  const nameFilter = globToRegExp(args.glob);
  const hits = [];
  async function walk(directory) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      if (SKIP_DIR_NAMES.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.env.example')) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        if (nameFilter && !nameFilter.test(entry.name)) continue;
        if (entry.name.toLowerCase().endsWith('.gguf') || entry.name.endsWith('.db')) continue;
        let stat;
        try { stat = await fs.promises.stat(child); } catch { continue; }
        if (stat.size > MAX_READ_BYTES) continue;
        let text;
        try {
          const raw = await fs.promises.readFile(child);
          if (raw.includes(0)) continue;
          text = raw.toString('utf8');
        } catch { continue; }
        const relative = path.relative(workspaceDir, child).split(path.sep).join('/');
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (regex.test(lines[index])) {
            hits.push(`${relative}:${index + 1}:${lines[index].trim().slice(0, 240)}`);
            if (hits.length >= MAX_SEARCH_HITS) break;
          }
        }
      }
    }
  }
  const stat = await fs.promises.stat(root);
  if (stat.isFile()) await walk(path.dirname(root));
  else await walk(root);
  return truncate(hits.length ? hits.join('\n') : 'No matches.');
}

async function writeFileTool(args) {
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('File content is too large.');
  const { resolved, relative } = resolveWorkspacePath(args.path);
  if (relative === '.' || relative.endsWith('/')) throw new Error('Choose a file path, not a directory.');
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  await fs.promises.writeFile(resolved, content, 'utf8');
  return `Wrote ${relative} (${Buffer.byteLength(content, 'utf8')} bytes).`;
}

function runCommandTool(args, signal) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('Command is required.');
  if (command.length > 4000) throw new Error('Command is too long.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: workspaceDir,
      env: { ...process.env, ANGCHAT_TOOL: '1' },
      shell: true,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(0, MAX_TOOL_CHARS); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, MAX_TOOL_CHARS); });
    child.on('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(truncate([
        `exit ${code}`,
        stdout ? `stdout:\n${stdout}` : 'stdout: (empty)',
        stderr ? `stderr:\n${stderr}` : ''
      ].filter(Boolean).join('\n')));
    });
  });
}

async function patchFileTool(args) {
  const { path: filePath, target, replacement } = args;
  if (!target) throw new Error('Target string is required.');
  const { resolved, relative } = resolveWorkspacePath(filePath);
  const content = await fs.promises.readFile(resolved, 'utf8');
  if (!content.includes(target)) {
    throw new Error(`Target snippet not found in ${relative}. Ensure exact match.`);
  }
  const updated = content.replace(target, replacement ?? '');
  await fs.promises.writeFile(resolved, updated, 'utf8');
  return `Successfully patched ${relative}. Replaced ${target.length} chars with ${(replacement || '').length} chars.`;
}

async function webFetchTool(args) {
  const url = args.url;
  if (!url || !url.startsWith('http')) throw new Error('Valid HTTP/HTTPS URL required.');
  const response = await fetch(url, { headers: { 'User-Agent': 'AngChat-Agent/2.0' } });
  if (!response.ok) throw new Error(`HTTP fetch failed with code ${response.status}`);
  const text = await response.text();
  // Strip tags for clean readable text
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(`Fetched from ${url}:\n${clean}`);
}

async function memoryStoreTool(args, db, ownerId) {
  if (!db) {
    const memory = require('./memory');
    memory.appendContextFile('MEMORY.md', args.content);
    return `Stored in MEMORY.md: ${args.content}`;
  }
  const memory = require('./memory');
  const id = memory.addMemory(db, {
    ownerId: ownerId || 'default',
    category: args.category || 'fact',
    content: args.content,
    importance: args.importance || 3
  });
  return `Stored into persistent memory layer [ID: ${id}] (${args.category || 'fact'}): ${args.content}`;
}

async function memoryRecallTool(args, db, ownerId) {
  const memory = require('./memory');
  if (!db) {
    const content = memory.readContextFile('MEMORY.md');
    return `Recalled from MEMORY.md:\n${content.slice(0, 2000)}`;
  }
  const hits = memory.searchMemory(db, { ownerId: ownerId || 'default', query: args.query, limit: 5 });
  if (!hits.length) return `No persistent memories found matching: "${args.query}"`;
  return hits.map(h => `[${h.category}] ${h.content} (importance: ${h.importance})`).join('\n');
}

async function skillCreateTool(args, db) {
  const skills = require('./skills');
  const skill = skills.createSkill(db || require('./db').db, {
    name: args.name,
    description: args.description || '',
    triggerPattern: `/${args.name}`,
    content: args.instructions
  });
  return `Created procedural skill: ${skill.name} (v${skill.version}) at ${skill.file_path}`;
}

async function executeTool(name, rawArgs, { signal, db, ownerId } = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  switch (name) {
    case 'read_file': return readFileTool(args);
    case 'list_dir': return listDirTool(args);
    case 'search_files': return searchFilesTool(args);
    case 'write_file': return writeFileTool(args);
    case 'run_command': return runCommandTool(args, signal);
    case 'patch_file': return patchFileTool(args);
    case 'web_fetch': return webFetchTool(args);
    case 'memory_store': return memoryStoreTool(args, db, ownerId);
    case 'memory_recall': return memoryRecallTool(args, db, ownerId);
    case 'skill_create': return skillCreateTool(args, db);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parseToolCalls(text) {
  if (!text) return [];
  const calls = [];
  const seen = new Set();
  const patterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    /```tool\s*([\s\S]*?)```/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const parsed = parseJsonObject(match[1].trim());
      if (!parsed?.name) continue;
      const name = String(parsed.name);
      const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : (parsed.args && typeof parsed.args === 'object' ? parsed.args : {});
      const key = `${name}:${JSON.stringify(args)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ id: `tool_${calls.length + 1}`, name, arguments: args });
    }
  }
  return calls;
}

function stripToolMarkup(text) {
  return String(text || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool[\s\S]*?```/gi, '')
    .trim();
}

module.exports = {
  workspaceDir,
  TOOL_SCHEMAS,
  toolsForMode,
  openaiTools,
  anthropicTools,
  geminiTools,
  toolPrompt,
  executeTool,
  parseToolCalls,
  stripToolMarkup,
  resolveWorkspacePath
};
