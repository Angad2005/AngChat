const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { promisify } = require('util');
const { randomUUID, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('crypto');
const { db } = require('./db');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { DEFAULTS, normalizeSettings, publicSettings, callProvider } = require('./providers');
const models = require('./models');
const inference = require('./inference');
const memory = require('./memory');
const skills = require('./skills');
const { runHarness } = require('./harness');
const { toolsForMode, getWorkspaceDir, persistWorkspaceDir, setWorkspaceDir } = require('./tools');
const { initializeDatabase } = require('./initialize-database');
const { listReceipts, verifyProject } = require('./verification');
const { createBasicAuthMiddleware } = require('./deployment-auth');

const scrypt = promisify(scryptCallback);
const app = express();
const publicDir = path.join(__dirname, '..', 'public');
const port = Number(process.env.PORT || 3000);
let runtimeSettings = { ...DEFAULTS };
let resumeModelId = null;

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
if (process.env.ANGCHAT_REQUIRE_BASIC_AUTH === '1') {
  app.use(createBasicAuthMiddleware({
    username: process.env.DEMO_BASIC_USER,
    password: process.env.DEMO_BASIC_PASSWORD
  }));
}
app.use(express.json({ limit: '6mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'angchat-local-development-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 }
}));

function isAuthenticated(req, res, next) {
  if (req.session?.userId) return next();
  if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(401).json({ error: 'Sign in to continue.' });
  res.redirect('/auth');
}

function isAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Sign in to continue.' });
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (user?.role === 'admin') { req.session.role = 'admin'; return next(); }
  req.session.role = user?.role || null;
  if (!req.xhr && !(req.headers.accept || '').includes('json')) return res.redirect('/');
  return res.status(403).json({ error: 'Administrator access is required.' });
}

function ownerId(req) {
  if (req.session?.userId) return String(req.session.userId);
  if (isTrustedCloudflareRequest(req)) {
    const identity = req.get('x-angchat-access-email') || 'shared';
    return `cloudflare:${identity.toLowerCase().slice(0, 254)}`;
  }
  return 'local';
}
function sendError(res, error, status = 400) { res.status(status).json({ error: error.message || String(error) }); }
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}
function isTrustedCloudflareRequest(req) {
  const expected = process.env.CHAT_GATE_SECRET;
  const supplied = req.get('x-angchat-proxy-key') || '';
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
function isTrustedLocalRequest(req) {
  return isLoopbackRequest(req) || isTrustedCloudflareRequest(req) || req.angchatDeploymentAuthenticated === true;
}
function requireLoopback(req, res, next) {
  if (isTrustedLocalRequest(req)) return next();
  return res.status(403).json({ error: 'Project paths can only be changed from the local machine.' });
}
function requireLocalWorkspaceAccess(req, res, next) {
  if (isTrustedLocalRequest(req)) return next();
  return res.status(403).json({ error: 'Workspace-backed agent runs are only available from the local machine.' });
}
function requireLocalModelManagement(_req, res, next) {
  if (process.env.CLOUDFLARE_CONTAINER === '1' || process.env.ANGCHAT_CLOUD_DEPLOYMENT === 'render') {
    return res.status(501).json({ error: 'Local model management is unavailable in this cloud deployment. Configure a hosted provider in Settings.' });
  }
  return next();
}
function validAccount({ username, email, password }, passwordRequired = true) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{2,32}$/.test(username.trim())) throw new Error('Username must be 2–32 letters, numbers, dots, dashes, or underscores.');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('Enter a valid email address.');
  if (passwordRequired && (typeof password !== 'string' || password.length < 8)) throw new Error('Password must be at least 8 characters.');
  if (!passwordRequired && password !== undefined && password !== '' && (typeof password !== 'string' || password.length < 8)) throw new Error('Password must be at least 8 characters.');
  if (typeof password === 'string' && password.length > 1024) throw new Error('Password must be 1,024 characters or fewer.');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, keyHex] = stored.split('$');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  return password === stored;
}

function currentUser(req) {
  if (!req.session?.userId) return null;
  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(req.session.userId);
  if (user) req.session.role = user.role;
  return user || null;
}

function persistRuntimeSettings() {
  db.prepare(`INSERT INTO harness_settings (id,provider,model,base_url,temperature,max_tokens,active_model_id,tools_enabled,inference_engine) VALUES (1,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,base_url=excluded.base_url,
    temperature=excluded.temperature,max_tokens=excluded.max_tokens,active_model_id=excluded.active_model_id,
    tools_enabled=excluded.tools_enabled,inference_engine=excluded.inference_engine`)
    .run(runtimeSettings.provider, runtimeSettings.model, runtimeSettings.baseUrl, runtimeSettings.temperature, runtimeSettings.maxTokens, models.runtimeStatus().modelId, runtimeSettings.toolsEnabled !== false ? 1 : 0, runtimeSettings.inferenceEngine || 'auto');
}

app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'First.html')));
app.get(['/harness', '/models', '/settings'], (_req, res) => res.sendFile(path.join(publicDir, 'First.html')));
app.get('/auth', (_req, res) => res.sendFile(path.join(publicDir, 'Login.html')));
app.get('/admin', isAuthenticated, isAdmin, (_req, res) => res.sendFile(path.join(publicDir, 'Admin.html')));

app.get('/api/health', (_req, res) => {
  try { db.prepare('SELECT 1 AS ok').get(); res.json({ ok: true, database: 'ok', name: 'PatchProof' }); }
  catch (error) { sendError(res, error, 503); }
});
app.get('/api/harness/config', (_req, res) => res.json({
  name: 'PatchProof',
  modes: { app: 'App', code: 'Code' },
  providers: ['openai', 'nebius', 'local', 'ollama', 'anthropic', 'gemini', 'mock'],
  recommendedModel: { provider: 'nebius', model: 'nvidia/Nemotron-3_5-Lightning', baseUrl: 'https://api.tokenfactory.nebius.com/v1' },
  capabilities: ['persistent-sessions', 'model-library', 'in-process-gguf-inference', 'openai-compatible-local-runtime', 'prompt-attachments', 'streaming', 'workspace-tools', 'agent-loop', 'project-path', 'glob', 'grep', 'file-edit', 'git-inspection', 'verified-execution']
}));
app.get('/api/harness/tools', (_req, res) => res.json({ app: toolsForMode('app'), code: toolsForMode('code') }));
app.get('/api/verification/receipts', (_req, res) => {
  const root = getWorkspaceDir() || path.resolve(__dirname, '..');
  res.json({ receipts: listReceipts(root, 10) });
});
app.post('/api/verification/run', requireLocalWorkspaceAccess, async (req, res) => {
  try {
    const task = typeof req.body?.task === 'string' ? req.body.task.slice(0, 500) : 'Manual project verification';
    const report = await verifyProject({ root: getWorkspaceDir(), scripts: req.body?.scripts, task });
    res.json({
      status: report.status,
      summary: report.reward,
      receiptPath: report.receiptPath,
      results: report.results.map(({ name, status, exitCode, durationMs, timedOut, output, error }) => ({
        name, status, exitCode, durationMs, timedOut: Boolean(timedOut), output, error
      }))
    });
  } catch (error) { sendError(res, error); }
});
app.get('/api/workspace', requireLoopback, (_req, res) => {
  res.json({ path: getWorkspaceDir() });
});
app.put('/api/workspace', requireLoopback, (req, res) => {
  const previous = getWorkspaceDir();
  try {
    const workspacePath = setWorkspaceDir(req.body?.path);
    if (process.env.ANGCHAT_CLOUD_DEPLOYMENT === 'render') {
      const relative = path.relative('/data', workspacePath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Render deployments can only use project directories inside the persistent /data disk.');
      }
    }
    persistWorkspaceDir();
    res.json({ path: workspacePath });
  } catch (error) {
    setWorkspaceDir(previous);
    sendError(res, error);
  }
});
app.get('/api/settings', (_req, res) => res.json(publicSettings(runtimeSettings)));
app.put('/api/settings', (req, res) => {
  const runtime = models.runtimeStatus();
  runtimeSettings = normalizeSettings(req.body, runtimeSettings);
  if (runtime.running && (runtimeSettings.provider !== 'local' || runtimeSettings.baseUrl !== runtime.endpoint)) models.stopRuntime();
  persistRuntimeSettings();
  res.json({ settings: publicSettings(runtimeSettings) });
});
app.post('/api/provider/test', async (_req, res) => {
  if (runtimeSettings.provider === 'mock') return res.json({ ok: true, mock: true, preview: 'Mock mode does not contact a model.' });
  try {
    const result = await callProvider({ mode: 'app', prompt: 'Reply with exactly: provider connection successful', settings: runtimeSettings });
    res.json({ ok: true, mock: false, preview: result.text.slice(0, 120) });
  } catch (error) { sendError(res, error, 502); }
});

app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT id,title,mode,created_at AS createdAt,updated_at AS updatedAt FROM sessions WHERE owner_id = ? ORDER BY updated_at DESC').all(ownerId(req));
  res.json(sessions);
});
app.post('/api/sessions', (req, res) => {
  const id = randomUUID();
  const title = (typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New session').slice(0, 80);
  const mode = ['app', 'code'].includes(req.body?.mode) ? req.body.mode : 'app';
  db.prepare('INSERT INTO sessions (id,owner_id,title,mode) VALUES (?,?,?,?)').run(id, ownerId(req), title, mode);
  res.status(201).json({ id, title, mode });
});
app.get('/api/sessions/:id/messages', (req, res) => {
  const sessionRow = db.prepare('SELECT id FROM sessions WHERE id = ? AND owner_id = ?').get(req.params.id, ownerId(req));
  if (!sessionRow) return res.status(404).json({ error: 'Session not found.' });
  const messages = db.prepare('SELECT id,role,content,mode,status,meta,created_at AS createdAt FROM messages WHERE session_id = ? ORDER BY id').all(req.params.id)
    .map(row => ({ ...row, meta: row.meta ? safeJson(row.meta) : null }));
  res.json(messages);
});
app.patch('/api/sessions/:id', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 80) : '';
  if (!title) return res.status(400).json({ error: 'Session title is required.' });
  const changed = db.prepare('UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?').run(title, req.params.id, ownerId(req));
  if (!changed.changes) return res.status(404).json({ error: 'Session not found.' });
  res.json({ ok: true });
});
app.delete('/api/sessions/:id', (req, res) => {
  const changed = db.prepare('DELETE FROM sessions WHERE id = ? AND owner_id = ?').run(req.params.id, ownerId(req));
  if (!changed.changes) return res.status(404).json({ error: 'Session not found.' });
  res.json({ ok: true });
});

app.post('/api/harness/run', requireLocalWorkspaceAccess, async (req, res) => {
  try {
    await runHarness({ req, res, db, ownerId: ownerId(req), settings: runtimeSettings, body: req.body || {} });
  } catch (error) { sendError(res, error, 502); }
});

app.get('/api/models', (_req, res) => res.json(models.getModels(db)));
app.get('/api/models/runtime', (_req, res) => res.json(models.runtimeStatus()));
app.post('/api/models/import', requireLocalModelManagement, async (req, res) => {
  try {
    const model = await models.registerModel(db, { name: req.body?.name, source: 'folder', modelPath: req.body?.path });
    res.status(201).json({ model: models.getModels(db).find(item => item.id === model.id) });
  } catch (error) { sendError(res, error); }
});
app.post('/api/models/scan', requireLocalModelManagement, async (_req, res) => {
  const added = [];
  const skipped = [];
  async function walk(directory, depth = 0) {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { skipped.push({ path: directory, error: error.message }); return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        try { const row = await models.registerModel(db, { source: 'folder', modelPath: target }); added.push(row.id); }
        catch (error) { skipped.push({ path: target, error: error.message }); }
      } else if (entry.isDirectory()) {
        const config = path.join(target, 'config.json');
        if (fs.existsSync(config)) {
          try { const row = await models.registerModel(db, { source: 'folder', modelPath: target }); added.push(row.id); }
          catch (error) { skipped.push({ path: target, error: error.message }); }
        } else await walk(target, depth + 1);
      }
    }
  }
  await walk(models.libraryDir);
  res.json({ models: models.getModels(db), added: [...new Set(added)].length, skipped });
});
app.post('/api/huggingface/files', requireLocalModelManagement, async (req, res) => {
  try { res.json({ repoId: req.body?.repoId, ...await models.listHuggingFaceFiles(req.body?.repoId, req.body?.token) }); }
  catch (error) { sendError(res, error, 502); }
});
app.post('/api/models/download', requireLocalModelManagement, (req, res) => {
  try {
    const job = models.startDownload(db, { repoId: req.body?.repoId, fileName: req.body?.fileName, token: req.body?.token });
    res.status(202).json({ id: job.id, status: job.status });
  } catch (error) { sendError(res, error); }
});
app.get('/api/models/download/:id', (req, res) => {
  const job = models.getDownload(req.params.id);
  if (!job) return res.status(404).json({ error: 'Download not found.' });
  const { id, repoId, fileName, status, receivedBytes, totalBytes, error, modelId } = job;
  res.json({ id, repoId, fileName, status, receivedBytes, totalBytes, error, modelId });
});
app.post('/api/models/:id/activate', requireLocalModelManagement, async (req, res) => {
  try {
    const result = await models.activateModel(db, req.params.id, runtimeSettings);
    persistRuntimeSettings();
    res.json({ ...result, settings: publicSettings(runtimeSettings) });
  } catch (error) { sendError(res, error, 502); }
});
app.delete('/api/models/:id', requireLocalModelManagement, async (req, res) => {
  const runtime = models.runtimeStatus();
  if (runtime.modelId === req.params.id) {
    await models.stopRuntime();
    if (runtimeSettings.baseUrl === runtime.endpoint) runtimeSettings.baseUrl = 'http://127.0.0.1:8080/v1';
    persistRuntimeSettings();
  }
  const changed = db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  if (!changed.changes) return res.status(404).json({ error: 'Model not found.' });
  res.json({ ok: true, filesRetained: true });
});
app.post('/api/models/runtime/stop', requireLocalModelManagement, async (_req, res) => {
  const runtime = models.runtimeStatus();
  await models.stopRuntime();
  if (runtimeSettings.baseUrl === runtime.endpoint) runtimeSettings.baseUrl = 'http://127.0.0.1:8080/v1';
  persistRuntimeSettings();
  res.json({ ok: true });
});

// --- Hermes Memory APIs ---
app.get('/api/memory', (req, res) => {
  try {
    const list = memory.getRecentMemories(db, { ownerId: ownerId(req), category: req.query.category, limit: Number(req.query.limit) || 20 });
    res.json(list);
  } catch (err) { sendError(res, err); }
});

app.post('/api/memory', (req, res) => {
  try {
    const id = memory.addMemory(db, {
      ownerId: ownerId(req),
      category: req.body?.category || 'fact',
      content: req.body?.content,
      importance: Number(req.body?.importance) || 3
    });
    res.status(201).json({ id });
  } catch (err) { sendError(res, err); }
});

app.get('/api/memory/search', (req, res) => {
  try {
    const results = memory.searchMemory(db, { ownerId: ownerId(req), query: req.query.q, limit: Number(req.query.limit) || 10 });
    res.json(results);
  } catch (err) { sendError(res, err); }
});

app.get('/api/memory/context-files', (_req, res) => {
  res.json({
    memory: memory.readContextFile('MEMORY.md'),
    user: memory.readContextFile('USER.md')
  });
});

app.put('/api/memory/context-files', (req, res) => {
  try {
    if (typeof req.body?.memory === 'string') memory.writeContextFile('MEMORY.md', req.body.memory);
    if (typeof req.body?.user === 'string') memory.writeContextFile('USER.md', req.body.user);
    res.json({ ok: true });
  } catch (err) { sendError(res, err); }
});

// --- Hermes Skills APIs ---
app.get('/api/skills', (_req, res) => {
  try {
    res.json(skills.listSkills(db));
  } catch (err) { sendError(res, err); }
});

app.post('/api/skills', (req, res) => {
  try {
    const created = skills.createSkill(db, {
      name: req.body?.name,
      description: req.body?.description,
      triggerPattern: req.body?.triggerPattern,
      content: req.body?.content
    });
    res.status(201).json(created);
  } catch (err) { sendError(res, err); }
});

app.get('/api/skills/:id', (req, res) => {
  const skill = skills.getSkill(db, req.params.id);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  res.json(skill);
});

app.put('/api/skills/:id', (req, res) => {
  try {
    const updated = skills.updateSkillContent(db, req.params.id, {
      content: req.body?.content,
      description: req.body?.description,
      triggerPattern: req.body?.triggerPattern
    });
    res.json(updated);
  } catch (err) { sendError(res, err); }
});

// --- Inference Token Counting & Embeddings ---
app.post('/api/inference/tokenize', (req, res) => {
  const text = req.body?.text || '';
  const count = inference.countTokens(text);
  res.json({ tokens: count });
});

app.post('/api/inference/embedding', async (req, res) => {
  try {
    const text = req.body?.text || '';
    const vector = await inference.getEmbedding(text);
    res.json({ embedding: vector });
  } catch (err) { sendError(res, err, 500); }
});

app.get('/api/auth/me', (req, res) => res.json({ user: currentUser(req), registrationOpen: !db.prepare('SELECT 1 FROM users LIMIT 1').get() }));
app.post('/api/signup', async (req, res) => {
  try {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return res.status(403).json({ error: 'The administrator account already exists. Ask an administrator to create an account.' });
    validAccount(req.body || {});
    const { username, email, password } = req.body;
    const role = db.prepare('SELECT 1 FROM users LIMIT 1').get() ? 'user' : 'admin';
    const result = db.prepare('INSERT INTO users (username,password,email,role) VALUES (?,?,?,?)').run(username.trim(), await hashPassword(password), email.trim(), role);
    req.session.userId = result.lastInsertRowid;
    req.session.username = username.trim();
    req.session.role = role;
    res.status(201).json({ user: { id: result.lastInsertRowid, username: username.trim(), email: email.trim(), role } });
  } catch (error) {
    sendError(res, error.message.includes('UNIQUE') ? new Error('That username or email is already registered.') : error, error.message.includes('UNIQUE') ? 409 : 400);
  }
});
app.post('/api/login', async (req, res) => {
  const identity = String(req.body?.identity || req.body?.username || '').trim();
  const password = req.body?.password;
  if (!identity || typeof password !== 'string') return res.status(400).json({ error: 'Enter your username or email and password.' });
  const user = db.prepare('SELECT id,username,email,password,role FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(identity, identity);
  if (!user || !(await verifyPassword(password, user.password))) return res.status(401).json({ error: 'Incorrect username/email or password.' });
  if (!user.password.startsWith('scrypt$')) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(password), user.id);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});
app.post('/api/logout', (req, res) => req.session.destroy(error => error ? res.status(500).json({ error: 'Could not log out.' }) : res.json({ ok: true })));
app.get('/api/users', isAdmin, (_req, res) => res.json(db.prepare('SELECT id,username,email,role FROM users ORDER BY id').all()));
app.post('/api/users', isAdmin, async (req, res) => {
  try {
    validAccount(req.body || {});
    const { username, password, email } = req.body;
    const result = db.prepare('INSERT INTO users (username,password,email,role) VALUES (?,?,?,?)').run(username.trim(), await hashPassword(password), email.trim(), 'user');
    res.status(201).json({ id: result.lastInsertRowid, username: username.trim(), email: email.trim(), role: 'user' });
  } catch (error) { sendError(res, error.message.includes('UNIQUE') ? new Error('That username or email is already registered.') : error, error.message.includes('UNIQUE') ? 409 : 400); }
});
app.put('/api/users/:id', isAdmin, async (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'User not found.' });
    validAccount({ ...req.body, password: req.body?.password || 'valid-placeholder' }, false);
    const password = typeof req.body?.password === 'string' && req.body.password ? await hashPassword(req.body.password) : null;
    db.prepare('UPDATE users SET username=?,email=?,password=COALESCE(?,password) WHERE id=?').run(req.body.username.trim(), req.body.email.trim(), password, req.params.id);
    res.json({ ok: true });
  } catch (error) { sendError(res, error.message.includes('UNIQUE') ? new Error('That username or email is already registered.') : error, error.message.includes('UNIQUE') ? 409 : 400); }
});
app.delete('/api/users/:id', isAdmin, (req, res) => {
  if (String(req.session.userId) === String(req.params.id)) return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.role === 'admin' && db.prepare('SELECT COUNT(*) AS count FROM users WHERE role = ?').get('admin').count <= 1) return res.status(400).json({ error: 'The last administrator cannot be deleted.' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function initializeRuntimeSettings() {
  const saved = initializeDatabase(db);
  resumeModelId = saved?.active_model_id || null;
  if (saved) {
    runtimeSettings = normalizeSettings({
      provider: saved.provider,
      model: saved.model,
      baseUrl: saved.base_url,
      temperature: saved.temperature,
      maxTokens: saved.max_tokens,
      toolsEnabled: saved.tools_enabled !== 0,
      inferenceEngine: saved.inference_engine || 'auto'
    }, runtimeSettings);
  }
}

initializeRuntimeSettings();
inference.ensureLibrary().catch(() => {});
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`PatchProof running at http://localhost:${port}`));
if (resumeModelId && models.runtimeStatus().available) {
  setImmediate(async () => {
    runtimeSettings.baseUrl = 'http://127.0.0.1:8080/v1';
    try {
      await models.activateModel(db, resumeModelId, runtimeSettings);
      persistRuntimeSettings();
    } catch (error) {
      runtimeSettings.baseUrl = 'http://127.0.0.1:8080/v1';
      persistRuntimeSettings();
      console.error(`Could not resume the saved local model: ${error.message}`);
    }
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await models.stopRuntime();
  server.close(() => { db.close(); process.exit(0); });
});
