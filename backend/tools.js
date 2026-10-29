const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const workspaceSettingsFile = path.resolve(process.env.CHAT_WORKSPACE_SETTINGS_FILE || path.join(__dirname, '..', '.chat', 'workspace.local.json'));
let workspaceDir = path.resolve(process.env.CHAT_WORKSPACE || path.join(__dirname, '..'));
if (!fs.statSync(workspaceDir).isDirectory()) throw new Error(`Project path is not a directory: ${workspaceDir}`);
workspaceDir = fs.realpathSync(workspaceDir);
if (!process.env.CHAT_WORKSPACE && fs.existsSync(workspaceSettingsFile)) {
  try {
    const savedWorkspace = JSON.parse(fs.readFileSync(workspaceSettingsFile, 'utf8'));
    if (savedWorkspace.version === 1) setWorkspaceDir(savedWorkspace.path);
  } catch (error) {
    console.error(`Ignoring saved project path: ${error.message}`);
  }
}
const MAX_READ_BYTES = 100_000;
const MAX_WRITE_BYTES = 200_000;
const MAX_TOOL_CHARS = 24_000;
const MAX_SEARCH_HITS = 40;
const COMMAND_TIMEOUT_MS = 20_000;

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.cursor', 'vendor', 'coverage']);
const VISIBLE_HIDDEN_NAMES = new Set(['.claude', '.chat', '.github', '.husky', '.vscode']);
const CODE_ONLY_TOOLS = new Set([
  'write_file', 'run_command', 'bash', 'patch_file', 'edit_file', 'git_status', 'git_diff', 'verify_project'
]);
const BLOCKED_RELATIVE = new Set([
  'backend/.env',
  'backend/chat.db',
  'backend/chat.db-wal',
  'backend/chat.db-shm'
]);

const TOOL_SCHEMAS = [
  {
    name: 'glob',
    description: 'Find project files by a glob pattern such as **/*.ts or src/**/*.test.js. Returns workspace-relative paths.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern matched against paths relative to the project root.' },
        path: { type: 'string', description: 'Optional directory to search within.' },
        limit: { type: 'integer', description: 'Maximum number of paths to return (1–200).' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'grep',
    description: 'Search project text files with a regular expression. Returns matching lines and optional context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        path: { type: 'string', description: 'Optional file or directory to search.' },
        glob: { type: 'string', description: 'Optional path glob, for example **/*.js.' },
        contextLines: { type: 'integer', description: 'Number of surrounding lines to include (0–5).' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the selected project. Paths are relative to the project root unless absolute and still inside the project.',
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
    description: 'List files and folders in the selected project directory.',
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
    description: 'Search selected-project text files for a regular expression. Skips vendor folders, secrets, and model weights.',
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
    description: 'Create or overwrite a UTF-8 text file inside the selected project. Does not write secrets or files outside the project.',
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
    name: 'bash',
    description: 'Run a non-interactive shell command in the selected project directory. Intended for tests, builds, and local project commands; stopped after 20 seconds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string', description: 'Shell command to run.' } },
      required: ['command']
    }
  },
  {
    name: 'verify_project',
    description: 'Run the selected project’s configured checks and save a JSON verification receipt. Only the npm scripts test, lint, typecheck, and build can be selected; omit scripts to use .chat/config.json or the default test script.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scripts: {
          type: 'array',
          items: { type: 'string', enum: ['test', 'lint', 'typecheck', 'build'] },
          description: 'Optional allowlisted npm script names to run.'
        },
        task: { type: 'string', maxLength: 500, description: 'Short description of the coding task for the receipt.' }
      }
    }
  },
  {
    name: 'edit_file',
    description: 'Replace one exact text occurrence in an existing project file. Fails if the target is missing or ambiguous.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'git_status',
    description: 'Read the current Git branch and working-tree status for the selected project.',
    parameters: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'git_diff',
    description: 'Read the unstaged or staged Git diff for the selected project, optionally limited to a project-relative path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Optional project-relative path to limit the diff.' },
        staged: { type: 'boolean', description: 'Show the staged diff instead of the unstaged diff.' }
      }
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
  return TOOL_SCHEMAS.filter(tool => !CODE_ONLY_TOOLS.has(tool.name));
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

function setWorkspaceDir(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.length > 4096) {
    throw new Error('Enter an absolute path to a project directory.');
  }
  if (!path.isAbsolute(inputPath)) throw new Error('Project path must be absolute.');
  const resolved = fs.realpathSync(path.resolve(inputPath.trim()));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Project path must be a directory.');
  if (resolved === path.parse(resolved).root) throw new Error('The filesystem root cannot be used as a project directory.');
  workspaceDir = resolved;
  return workspaceDir;
}

function persistWorkspaceDir() {
  fs.mkdirSync(path.dirname(workspaceSettingsFile), { recursive: true, mode: 0o700 });
  const temporary = `${workspaceSettingsFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, path: workspaceDir }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, workspaceSettingsFile);
  fs.chmodSync(workspaceSettingsFile, 0o600);
  return workspaceSettingsFile;
}

function isWithinWorkspace(candidate) {
  const relative = path.relative(workspaceDir, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isBlockedPath(relative) {
  const normalized = relative.split(path.sep).join('/');
  const segments = normalized.toLowerCase().split('/');
  const basename = segments[segments.length - 1] || '';
  return BLOCKED_RELATIVE.has(normalized)
    || segments.some(segment => /^\.env(?:$|\.)/.test(segment))
    || ['.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json'].includes(basename)
    || /\.(?:pem|p12|pfx|key)$/.test(basename);
}

function resolveWorkspacePath(inputPath = '.') {
  const requested = String(inputPath || '.').trim() || '.';
  const candidate = path.resolve(workspaceDir, requested);
  const relative = path.relative(workspaceDir, candidate);
  if (!isWithinWorkspace(candidate)) {
    throw new Error('That path is outside the Chat workspace.');
  }
  if (isBlockedPath(relative)) {
    throw new Error('That file is blocked from tool access.');
  }

  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Could not resolve a path inside the project.');
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  if (!isWithinWorkspace(realExisting)) throw new Error('That path resolves outside the selected project.');
  const resolved = existing === candidate
    ? realExisting
    : path.resolve(realExisting, path.relative(existing, candidate));
  const normalized = path.relative(workspaceDir, resolved).split(path.sep).join('/');
  if (isBlockedPath(normalized)) throw new Error('That file is blocked from tool access.');
  return { resolved, relative: normalized || '.' };
}

function truncate(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_TOOL_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_CHARS)}\n… truncated after ${MAX_TOOL_CHARS} characters.`;
}

function globToRegExp(glob) {
  if (!glob) return null;
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index++;
      }
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'i');
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

function readProjectInstructions() {
  const files = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.github/copilot-instructions.md'];
  const sections = [];
  for (const file of files) {
    let resolved;
    try {
      resolved = resolveWorkspacePath(file).resolved;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
      throw new Error(`Project instruction file ${file} is not a readable text file under ${MAX_READ_BYTES} bytes.`);
    }
    const raw = fs.readFileSync(resolved);
    if (raw.includes(0)) throw new Error(`Project instruction file ${file} contains binary data.`);
    sections.push(`### ${file}\n${raw.toString('utf8')}`);
  }
  return truncate(sections.join('\n\n'));
}

async function listDirTool(args) {
  const { resolved, relative } = resolveWorkspacePath(args.path || '.');
  const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));
  const lines = [];
  async function walk(directory, level, prefix) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !VISIBLE_HIDDEN_NAMES.has(entry.name)) continue;
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
  const { resolved: root } = resolveWorkspacePath(args.path || '.');
  const nameFilter = globToRegExp(args.glob);
  const hits = [];
  async function walk(directory) {
    const stat = await fs.promises.stat(directory);
    if (stat.isFile()) {
      await searchFile(directory);
      return;
    }
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      if (SKIP_DIR_NAMES.has(entry.name) || (entry.name.startsWith('.') && !VISIBLE_HIDDEN_NAMES.has(entry.name))) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) await searchFile(child);
    }
  }
  async function searchFile(file) {
    if (hits.length >= MAX_SEARCH_HITS) return;
    const relative = path.relative(workspaceDir, file).split(path.sep).join('/');
    if (isBlockedPath(relative) || nameFilter && !nameFilter.test(relative)) return;
    if (file.toLowerCase().endsWith('.gguf') || file.endsWith('.db')) return;
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return; }
    if (stat.size > MAX_READ_BYTES) return;
    let text;
    try {
      const raw = await fs.promises.readFile(file);
      if (raw.includes(0)) return;
      text = raw.toString('utf8');
    } catch { return; }
    const lines = text.split(/\r?\n/);
    const contextLines = Math.min(5, Math.max(0, Number(args.contextLines) || 0));
    for (let index = 0; index < lines.length; index++) {
      regex.lastIndex = 0;
      if (regex.test(lines[index])) {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length, index + contextLines + 1);
        hits.push(`${relative}:${index + 1}:${lines.slice(start, end).map((line, offset) => `${start + offset + 1}|${line}`).join('\n')}`);
        if (hits.length >= MAX_SEARCH_HITS) break;
      }
    }
  }
  const stat = await fs.promises.stat(root);
  if (stat.isFile()) await searchFile(root);
  else await walk(root);
  return truncate(hits.length ? hits.join('\n') : 'No matches.');
}

async function globFilesTool(args) {
  const matcher = globToRegExp(String(args.pattern || ''));
  if (!matcher) throw new Error('A glob pattern is required.');
  const { resolved: root } = resolveWorkspacePath(args.path || '.');
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 100));
  const matches = [];
  async function walk(directory) {
    if (matches.length >= limit) return;
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matches.length >= limit) break;
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.') && !VISIBLE_HIDDEN_NAMES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        const relative = path.relative(workspaceDir, child).split(path.sep).join('/');
        if (isBlockedPath(relative) || /\.(?:gguf|db)$/i.test(entry.name)) continue;
        const searchRelative = path.relative(root, child).split(path.sep).join('/');
        if (matcher.test(searchRelative)) matches.push(relative);
      }
    }
  }
  const stat = await fs.promises.stat(root);
  if (stat.isFile()) {
    const relative = path.relative(workspaceDir, root).split(path.sep).join('/');
    if (!isBlockedPath(relative) && matcher.test(path.basename(relative))) matches.push(relative);
  } else {
    await walk(root);
  }
  return matches.length ? matches.join('\n') : 'No files matched.';
}

async function editFileTool(args) {
  const target = String(args.old_string ?? args.target ?? '');
  if (!target) throw new Error('The exact text to replace is required.');
  const replacement = String(args.new_string ?? args.replacement ?? '');
  if (Buffer.byteLength(replacement, 'utf8') > MAX_WRITE_BYTES) throw new Error('Replacement text is too large.');
  const { resolved, relative } = resolveWorkspacePath(args.path);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) throw new Error('Path is not a file.');
  if (stat.size > MAX_WRITE_BYTES) throw new Error('File is too large to edit with this tool.');
  const content = await fs.promises.readFile(resolved, 'utf8');
  const first = content.indexOf(target);
  if (first === -1) throw new Error(`Target text not found in ${relative}.`);
  if (content.indexOf(target, first + target.length) !== -1) {
    throw new Error(`Target text occurs more than once in ${relative}; provide a more specific snippet.`);
  }
  await fs.promises.writeFile(resolved, content.slice(0, first) + replacement + content.slice(first + target.length), 'utf8');
  return `Edited ${relative}.`;
}

function runGitTool(args, { staged = false, diff = false } = {}) {
  const gitArgs = diff
    ? ['diff', ...(staged ? ['--cached'] : []), '--', ...(args.path ? [resolveWorkspacePath(args.path).relative] : [])]
    : ['status', '--short', '--branch'];
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd: workspaceDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk.toString()).slice(0, MAX_TOOL_CHARS);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Git inspection timed out.'));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(`Could not run Git: ${error.message}`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `Git exited with code ${code}.`));
      resolve(truncate(stdout.trim() || '(no changes)'));
    });
  });
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
      env: { ...process.env, CHAT_TOOL: '1' },
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
  return editFileTool({
    path: args.path,
    old_string: args.target,
    new_string: args.replacement
  });
}

async function webFetchTool(args) {
  const url = args.url;
  if (!url || !url.startsWith('http')) throw new Error('Valid HTTP/HTTPS URL required.');
  const response = await fetch(url, { headers: { 'User-Agent': 'Chat-Agent/2.0' } });
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

async function verifyProjectTool(args, agent) {
  const { verifyProject } = require('./verification');
  const task = typeof args.task === 'string' ? args.task.slice(0, 500) : 'Coding agent verification';
  const report = await verifyProject({ root: workspaceDir, scripts: args.scripts, task, agent });
  return JSON.stringify({
    status: report.status,
    summary: report.reward,
    agent: report.receipt.agent || null,
    receiptPath: report.receiptPath,
    results: report.results.map(result => ({
      name: result.name,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: Boolean(result.timedOut),
      output: String(result.output || '').slice(-6000),
      error: result.error || undefined
    }))
  }, null, 2);
}

async function executeTool(name, rawArgs, { signal, db, ownerId, provider, model } = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  switch (name) {
    case 'read_file': return readFileTool(args);
    case 'list_dir': return listDirTool(args);
    case 'search_files': return searchFilesTool(args);
    case 'glob': return globFilesTool(args);
    case 'grep': return searchFilesTool(args);
    case 'write_file': return writeFileTool(args);
    case 'run_command':
    case 'bash': return runCommandTool(args, signal);
    case 'verify_project': return verifyProjectTool(args, { provider, model });
    case 'patch_file': return patchFileTool(args);
    case 'edit_file': return editFileTool(args);
    case 'git_status': return runGitTool(args);
    case 'git_diff': return runGitTool(args, { staged: args.staged === true, diff: true });
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
  getWorkspaceDir: () => workspaceDir,
  setWorkspaceDir,
  persistWorkspaceDir,
  readProjectInstructions,
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
