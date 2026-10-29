const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  executeTool, getWorkspaceDir, parseToolCalls, resolveWorkspacePath, setWorkspaceDir,
  readProjectInstructions, stripToolMarkup, toolsForMode
} = require('./tools');
const { completeTurn, normalizeSettings, publicSettings } = require('./providers');
const verification = require('./verification');
const traces = require('./traces');
const { createBasicAuthMiddleware } = require('./deployment-auth');

function testDeploymentBasicAuth() {
  assert.throws(() => createBasicAuthMiddleware({ username: 'demo' }), /requires both/);
  const middleware = createBasicAuthMiddleware({ username: 'demo', password: 'strong-secret' });
  function request(pathname, authorization) {
    const req = { path: pathname, get: name => name === 'authorization' ? authorization : undefined };
    const res = {
      headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      type(value) { this.contentType = value; return this; },
      send(value) { this.body = value; return this; }
    };
    let continued = false;
    middleware(req, res, () => { continued = true; });
    return { req, res, continued };
  }

  assert.equal(request('/api/health').continued, true);
  const missing = request('/api/settings');
  assert.equal(missing.continued, false);
  assert.equal(missing.res.statusCode, 401);
  assert.equal(missing.res.headers['WWW-Authenticate'].startsWith('Basic '), true);
  assert.equal(missing.res.headers['Cache-Control'], 'no-store');
  assert.equal(request('/api/settings', `Basic ${Buffer.from('demo:wrong').toString('base64')}`).res.statusCode, 401);

  const valid = request('/api/settings', `Basic ${Buffer.from('demo:strong-secret').toString('base64')}`);
  assert.equal(valid.continued, true);
  assert.equal(valid.req.angchatDeploymentAuthenticated, true);
}

const xml = 'Checking the file.\n<tool_call>{"name":"read_file","arguments":{"path":"Readme.md"}}</tool_call>';
const calls = parseToolCalls(xml);
assert.equal(calls.length, 1);
assert.equal(calls[0].name, 'read_file');
assert.equal(calls[0].arguments.path, 'Readme.md');
assert.equal(stripToolMarkup(xml), 'Checking the file.');

const fenced = '```tool\n{"name":"list_dir","arguments":{"path":"."}}\n```';
assert.equal(parseToolCalls(fenced)[0].name, 'list_dir');

const safe = resolveWorkspacePath('backend/index.js');
assert.equal(safe.relative, 'backend/index.js');
assert.ok(safe.resolved.endsWith(path.join('backend', 'index.js')));
assert.throws(() => resolveWorkspacePath('../secret'), /outside/);
assert.throws(() => resolveWorkspacePath('backend/.env'), /blocked/);

assert.ok(toolsForMode('code').some(tool => tool.name === 'run_command'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'patch_file'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'glob'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'grep'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'edit_file'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'bash'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'git_status'));
assert.ok(!toolsForMode('app').some(tool => tool.name === 'edit_file'));
assert.ok(!toolsForMode('app').some(tool => tool.name === 'bash'));
assert.ok(toolsForMode('code').some(tool => tool.name === 'memory_store'));
assert.ok(toolsForMode('app').some(tool => tool.name === 'read_file'));

const nebiusSettings = normalizeSettings({ provider: 'nebius', model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1' });
assert.equal(nebiusSettings.provider, 'nebius');
assert.equal(nebiusSettings.model, 'nvidia/llama-3.1-nemotron-ultra-253b-v1');
assert.equal(publicSettings({ ...nebiusSettings, apiKey: 'secret' }).apiKey, undefined);

// Test context compression & estimation
const context = require('./context');
const tokenCount = context.estimateTokens('Hello world');
assert.ok(tokenCount > 0);

const testMsgs = [
  { role: 'user', content: 'What is Hermes Agent?' },
  { role: 'assistant', content: 'It is a self-improving AI framework.' },
  { role: 'tool', name: 'read_file', content: 'Large output...' }
];
const budget = context.contextBudget(4096);
assert.equal(budget.maxTokens, 4096);
assert.ok(budget.available > 0);

const pruned = context.pruneOldToolResults(testMsgs, { keepLastN: 0 });
assert.ok(pruned[2].content.includes('Pruned tool result'));

// Test memory module
const Database = require('better-sqlite3');
const testDb = new Database(':memory:');
const memory = require('./memory');
assert.ok(memory.memoryDir.endsWith(path.join('.chat', 'brain')));
memory.initMemory(testDb);

const memId = memory.addMemory(testDb, {
  ownerId: 'test-user',
  category: 'preference',
  content: 'I prefer concise responses and markdown tables',
  importance: 4
});
assert.ok(memId);

const recalled = memory.searchMemory(testDb, { ownerId: 'test-user', query: 'concise markdown' });
assert.ok(recalled.length > 0);
assert.equal(recalled[0].category, 'preference');

// Test skills module
const skills = require('./skills');
skills.initSkills(testDb);

const frontmatter = skills.parseSkillFrontmatter(`---
name: test-runner
description: Runs unit tests
triggers:
  - /test
  - regex:run.*test
---
# Test Runner Skill
Execute npm test.
`);
assert.equal(frontmatter.meta.name, 'test-runner');
assert.ok(frontmatter.body.includes('Execute npm test'));

async function testNebiusProvider() {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'provider response' } }] })
    };
  };
  try {
    const result = await completeTurn({
      mode: 'app',
      messages: [{ role: 'user', content: 'ping' }],
      settings: { ...nebiusSettings, apiKey: 'test-token' }
    });
    assert.equal(result.text, 'provider response');
    assert.equal(result.engine, 'nebius');
    assert.equal(request.url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(request.options.body).model, nebiusSettings.model);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testLocalProviderApiKey() {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'local response' } }] })
    };
  };
  try {
    const settings = normalizeSettings({
      provider: 'local',
      model: 'loaded-model',
      baseUrl: 'http://127.0.0.1:1234/v1',
      inferenceEngine: 'llama-server',
      apiKey: 'lm-studio-key'
    });
    assert.equal(publicSettings(settings).hasApiKey, true);
    const result = await completeTurn({
      mode: 'app',
      messages: [{ role: 'user', content: 'ping' }],
      settings
    });
    assert.equal(result.text, 'local response');
    assert.equal(result.engine, 'llama-server');
    assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer lm-studio-key');

    await completeTurn({
      mode: 'app',
      messages: [{ role: 'user', content: 'ping' }],
      settings: { ...settings, apiKey: '' }
    });
    assert.equal(requests[1].options.headers.Authorization, undefined);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testCloudflareAccessVerification() {
  const { webcrypto } = require('crypto');
  globalThis.crypto ||= webcrypto;
  const { verifyAccessAssertion } = await import('../cloudflare/access.mjs');
  const originalFetch = global.fetch;
  const pair = await webcrypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'angchat-test-key';
  global.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

  async function signedToken(claims) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode(claims)}`;
    const signature = await webcrypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(unsigned)
    );
    return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
  }

  const env = {
    ACCESS_TEAM_DOMAIN: 'https://angchat-test.cloudflareaccess.com/',
    ACCESS_AUD: 'angchat-test-audience'
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://angchat-test.cloudflareaccess.com',
    aud: ['angchat-test-audience'],
    exp: now + 600,
    email: 'demo@example.com'
  };
  try {
    const token = await signedToken(claims);
    const validRequest = new Request('https://demo.example.com/', {
      headers: { 'Cf-Access-Jwt-Assertion': token }
    });
    assert.equal((await verifyAccessAssertion(validRequest, env)).email, claims.email);

    const tokenParts = token.split('.');
    const invalidSignature = new Request('https://demo.example.com/', {
      headers: { 'Cf-Access-Jwt-Assertion': `${tokenParts[0]}.${tokenParts[1]}.${Buffer.alloc(256).toString('base64url')}` }
    });
    assert.equal(await verifyAccessAssertion(invalidSignature, env), null);

    const wrongAudience = new Request('https://demo.example.com/', {
      headers: { 'Cf-Access-Jwt-Assertion': await signedToken({ ...claims, aud: ['other-audience'] }) }
    });
    assert.equal(await verifyAccessAssertion(wrongAudience, env), null);

    const expired = new Request('https://demo.example.com/', {
      headers: { 'Cf-Access-Jwt-Assertion': await signedToken({ ...claims, exp: now - 120 }) }
    });
    assert.equal(await verifyAccessAssertion(expired, env), null);
    assert.equal(await verifyAccessAssertion(new Request('https://demo.example.com/'), env), null);
    await assert.rejects(
      verifyAccessAssertion(new Request('https://demo.example.com/'), {
        ACCESS_TEAM_DOMAIN: 'replace-with-your-team.cloudflareaccess.com',
        ACCESS_AUD: 'replace-with-your-access-application-aud-tag'
      }),
      /Set ACCESS_TEAM_DOMAIN and ACCESS_AUD/
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testVerification() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-verify-test-'));
  try {
    fs.mkdirSync(path.join(root, '.chat'));
    fs.writeFileSync(path.join(root, '.chat', 'config.json'), JSON.stringify({
      verification: { scripts: ['test'] }
    }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.stdout.write(\'verified\')"' }
    }));
    assert.deepEqual(verification.readVerificationConfig(root).scripts, ['test']);
    const report = await verification.verifyProject({ root });
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.reward, { score: 1, passed: 1, total: 1 });
    assert.match(report.results[0].output, /verified/);
    assert.ok(report.receiptPath && fs.existsSync(report.receiptPath));
    await assert.rejects(
      verification.verifyProject({ root, scripts: ['postinstall'] }),
      /only test, lint, typecheck, or build/
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.exit(1)"' }
    }));
    const failed = await verification.verifyProject({ root });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reward.score, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testInteractiveCli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cli-test-'));
  const dbPath = path.join(root, 'chat.sqlite');
  const projectPath = path.join(root, 'project');
  const workspaceSettingsPath = path.join(root, 'workspace.json');
  try {
    fs.mkdirSync(projectPath);
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'chat.js'), 'run', '--mode', 'code'], {
      cwd: path.join(__dirname, '..'),
      input: `/project ${projectPath}\nhello from cli\n/sessions\n/exit\n`,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CHAT_DB_PATH: dbPath,
        CHAT_WORKSPACE_SETTINGS_FILE: workspaceSettingsPath,
        LLM_PROVIDER: 'mock',
        LLM_MODEL: 'cli-test'
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Chat CLI · mock\/cli-test · code mode/);
    assert.match(result.stdout, /Mock mode is enabled, so no model was called/);
    const cliDb = new (require('better-sqlite3'))(dbPath);
    try {
      const session = cliDb.prepare("SELECT id,mode FROM sessions WHERE owner_id='local'").get();
      assert.ok(session);
      assert.equal(session.mode, 'code');
      assert.equal(cliDb.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(session.id).count, 2);
      const resumed = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'chat.js'), 'run'], {
        cwd: path.join(__dirname, '..'),
        input: `/resume ${session.id}\n/status\n/exit\n`,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          CHAT_DB_PATH: dbPath,
          CHAT_WORKSPACE_SETTINGS_FILE: workspaceSettingsPath,
          LLM_PROVIDER: 'mock',
          LLM_MODEL: 'cli-test'
        }
      });
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.match(resumed.stdout, new RegExp(`Resumed ${session.id} in code mode`));
      assert.match(resumed.stdout, new RegExp(`Project: ${projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally { cliDb.close(); }
    assert.deepEqual(JSON.parse(fs.readFileSync(workspaceSettingsPath, 'utf8')), { version: 1, path: fs.realpathSync(projectPath) });
    if (process.platform !== 'win32') assert.equal(fs.statSync(workspaceSettingsPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testProjectCodeTools() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-project-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-project-outside-'));
  const previous = getWorkspaceDir();
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, 'src', 'main.js'), 'before\nneedle\nend\n');
    fs.writeFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'project guidance');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root instructions');
    fs.writeFileSync(path.join(root, '.env'), 'private');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
    setWorkspaceDir(root);

    assert.equal(getWorkspaceDir(), fs.realpathSync(root));
    assert.ok(resolveWorkspacePath('.claude/CLAUDE.md').resolved.endsWith(path.join('.claude', 'CLAUDE.md')));
    assert.throws(() => resolveWorkspacePath('.env'), /blocked/);
    assert.equal(await executeTool('glob', { pattern: '**/*.js' }), 'src/main.js');
    assert.equal(await executeTool('glob', { pattern: '*.js', path: 'src' }), 'src/main.js');
    assert.match(await executeTool('grep', { pattern: 'needle', path: 'src', contextLines: 1 }), /src\/main\.js:2/);
    assert.match(await executeTool('read_file', { path: '.claude/CLAUDE.md' }), /project guidance/);
    assert.match(readProjectInstructions(), /root instructions/);
    assert.match(readProjectInstructions(), /project guidance/);
    assert.throws(() => setWorkspaceDir('relative/path'), /absolute/);

    await assert.rejects(executeTool('edit_file', {
      path: 'src/main.js', old_string: 'not present', new_string: 'changed'
    }), /not found/);
    assert.match(await executeTool('edit_file', {
      path: 'src/main.js', old_string: 'needle', new_string: 'updated'
    }), /Edited src\/main\.js/);
    assert.match(await executeTool('grep', { pattern: 'updated', path: 'src' }), /src\/main\.js:2/);
    fs.writeFileSync(path.join(root, 'duplicate.txt'), 'same text; same text');
    await assert.rejects(executeTool('edit_file', {
      path: 'duplicate.txt', old_string: 'same text', new_string: 'changed'
    }), /occurs more than once/);
    assert.match(await executeTool('write_file', {
      path: 'src/new.js', content: 'export const answer = 42;'
    }), /Wrote src\/new\.js/);
    assert.match(await executeTool('read_file', { path: 'src/new.js' }), /answer = 42/);
    assert.match(await executeTool('bash', { command: 'node --version' }), /exit 0/);

    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
      assert.throws(() => resolveWorkspacePath('escape/secret.txt'), /outside/);
    }

    if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0) {
      const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      assert.match(await executeTool('git_status', {}), /main|master|No commits yet/);
      assert.match(await executeTool('git_diff', {}), /No changes|no changes/);
    }
  } finally {
    setWorkspaceDir(previous);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function testTraceCapture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-trace-test-'));
  const file = path.join(root, 'traces', 'run.jsonl');
  try {
    assert.equal(traces.appendExecutionTrace({ prompt: 'private' }, { enabled: false, file }), false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(traces.appendExecutionTrace({ prompt: 'hello', response: 'world' }, { enabled: true, file }), true);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(record.prompt, 'hello');
    assert.equal(record.response, 'world');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

Promise.resolve()
  .then(testDeploymentBasicAuth)
  .then(testNebiusProvider)
  .then(testLocalProviderApiKey)
  .then(testCloudflareAccessVerification)
  .then(testVerification)
  .then(testInteractiveCli)
  .then(testProjectCodeTools)
  .then(testTraceCapture)
  .then(() => {
  console.log('Chat harness tests passed.');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
