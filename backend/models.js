const fs = require('fs');
const path = require('path');
const net = require('net');
const { randomUUID } = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const workspaceDir = path.join(__dirname, '..');
const libraryDir = path.join(workspaceDir, 'models');
const downloads = new Map();
let llamaProcess = null;
let activeModelId = null;
let llamaPort = null;

function fileIsExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return ['.exe', '.com'].includes(path.extname(filePath).toLowerCase());
    return Boolean(stat.mode & 0o111);
  } catch { return false; }
}

function findOnPath(command) {
  const extensions = process.platform === 'win32'
    ? ['.EXE', '.COM']
    : [''];
  const names = path.extname(command) ? [command] : extensions.map(extension => `${command}${extension}`);
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fileIsExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function llamaExecutable() {
  const configuredPath = process.env.LLAMA_SERVER_PATH?.trim();
  if (configuredPath) {
    const hasDirectory = configuredPath.includes('/') || configuredPath.includes('\\');
    const candidate = hasDirectory ? path.resolve(workspaceDir, configuredPath) : findOnPath(configuredPath);
    return {
      configured: true,
      available: Boolean(candidate && fileIsExecutable(candidate)),
      source: 'environment',
      command: candidate || configuredPath,
      name: path.basename(candidate || configuredPath)
    };
  }
  const candidate = findOnPath('llama-server');
  return {
    configured: Boolean(candidate),
    available: Boolean(candidate),
    source: candidate ? 'path' : null,
    command: candidate,
    name: candidate ? path.basename(candidate) : null
  };
}

function initModels(db) {
  fs.mkdirSync(libraryDir, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
    repo_id TEXT, file_name TEXT, model_path TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
}

function pathInside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hasGgufHeader(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 && header.toString('ascii') === 'GGUF';
  } finally { await handle.close(); }
}

async function inspectGgufFile(filePath) {
  if (!await hasGgufHeader(filePath)) throw new Error('The file extension is .gguf, but its contents are not a GGUF model.');
  const stat = await fs.promises.stat(filePath);
  const shard = path.basename(filePath).match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!shard) return { format: 'gguf', size: stat.size, launchPath: filePath };
  const [, prefix, _index, countText] = shard;
  const count = Number(countText);
  if (!count || count > 999) throw new Error('This GGUF shard set has an unsupported number of parts.');
  let size = 0;
  let firstPath = null;
  for (let index = 1; index <= count; index++) {
    const part = path.join(path.dirname(filePath), `${prefix}-${String(index).padStart(5, '0')}-of-${countText}.gguf`);
    try {
      const partStat = await fs.promises.stat(part);
      if (!partStat.isFile() || !await hasGgufHeader(part)) throw new Error('invalid GGUF shard');
      if (index === 1) firstPath = part;
      size += partStat.size;
    } catch {
      throw new Error(`This is a split GGUF model. Copy all ${count} shard files into the same folder before adding it.`);
    }
  }
  return { format: 'gguf-sharded', size, launchPath: firstPath, shardCount: count };
}

async function inspectPath(modelPath, depth = 0) {
  const stat = await fs.promises.stat(modelPath);
  if (stat.isFile()) {
    if (!modelPath.toLowerCase().endsWith('.gguf')) throw new Error('Choose a .gguf file or a model folder.');
    return inspectGgufFile(modelPath);
  }
  if (!stat.isDirectory()) throw new Error('The selected path is not a file or directory.');

  let size = 0;
  const ggufFiles = [];
  let hasConfig = false;
  async function walk(directory, level) {
    if (level > 4) return;
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child, level + 1);
      else if (entry.isFile()) {
        const childStat = await fs.promises.stat(child);
        size += childStat.size;
        if (entry.name.toLowerCase() === 'config.json') hasConfig = true;
        if (entry.name.toLowerCase().endsWith('.gguf') && await hasGgufHeader(child)) ggufFiles.push(child);
      }
    }
  }
  await walk(modelPath, depth);
  if (ggufFiles.length) {
    const fileInfo = await inspectGgufFile(ggufFiles[0]);
    if (fileInfo.format === 'gguf-sharded') {
      const shardPaths = new Set(Array.from({ length: fileInfo.shardCount }, (_, index) => path.join(path.dirname(fileInfo.launchPath), `${path.basename(fileInfo.launchPath).replace(/-00001-of-\d{5}\.gguf$/i, '')}-${String(index + 1).padStart(5, '0')}-of-${String(fileInfo.shardCount).padStart(5, '0')}.gguf`)));
      if (ggufFiles.every(file => shardPaths.has(file)) && ggufFiles.length === fileInfo.shardCount) return fileInfo;
    }
  }
  if (ggufFiles.length === 1) return { format: 'gguf-folder', size, launchPath: ggufFiles[0] };
  if (ggufFiles.length > 1) return { format: 'gguf-folder', size, launchPath: null, candidates: ggufFiles.length };
  if (hasConfig) return { format: 'transformers', size, launchPath: modelPath };
  throw new Error('This folder has no .gguf model or config.json. Copy a GGUF file or a Hugging Face model folder into the library.');
}

function publicModel(row) {
  return {
    id: row.id, name: row.name, source: row.source, repoId: row.repo_id,
    fileName: row.file_name, path: row.model_path, format: row.format,
    sizeBytes: row.size_bytes, addedAt: row.added_at
  };
}

function getModels(db) {
  return db.prepare('SELECT * FROM models ORDER BY added_at DESC, name COLLATE NOCASE').all().map(publicModel);
}

function getModel(db, id) {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  return row || null;
}

async function registerModel(db, { name, source, repoId = null, fileName = null, modelPath }) {
  let realPath = await fs.promises.realpath(modelPath);
  const inspection = await inspectPath(realPath);
  if (inspection.format === 'gguf-sharded') realPath = inspection.launchPath;
  const existing = db.prepare('SELECT * FROM models WHERE model_path = ?').get(realPath);
  if (existing) {
    if (name && existing.name !== name) db.prepare('UPDATE models SET name = ? WHERE id = ?').run(name, existing.id);
    return db.prepare('SELECT * FROM models WHERE id = ?').get(existing.id);
  }
  const row = {
    id: randomUUID(), name: String(name || path.basename(realPath)).slice(0, 120), source,
    repoId, fileName, modelPath: realPath, format: inspection.format, size: inspection.size
  };
  db.prepare('INSERT INTO models (id,name,source,repo_id,file_name,model_path,format,size_bytes) VALUES (@id,@name,@source,@repoId,@fileName,@modelPath,@format,@size)')
    .run(row);
  return db.prepare('SELECT * FROM models WHERE id = ?').get(row.id);
}

function validateRepoId(repoId) {
  if (typeof repoId !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoId)) {
    throw new Error('Enter a Hugging Face repository ID in owner/model format.');
  }
  if (repoId.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid Hugging Face repository ID.');
  return repoId;
}

function hfHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function listHuggingFaceFiles(repoId, token) {
  validateRepoId(repoId);
  const response = await fetch(`https://huggingface.co/api/models/${repoId}/tree/main?recursive=true&expand=true`, { headers: hfHeaders(token) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Hugging Face returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const files = await response.json();
  const ggufFiles = files.filter(file => file.type === 'file' && typeof file.path === 'string' && file.path.toLowerCase().endsWith('.gguf'));
  const splitShards = ggufFiles.filter(file => /-\d{5}-of-\d{5}\.gguf$/i.test(file.path));
  return { splitShardCount: splitShards.length, files: ggufFiles.filter(file => !/-\d{5}-of-\d{5}\.gguf$/i.test(file.path))
    .map(file => ({ path: file.path, size: Number(file.size || file.lfs?.size || 0) }))
    .sort((a, b) => a.path.localeCompare(b.path)) };
}

function safeHfFile(fileName) {
  if (typeof fileName !== 'string' || fileName.length > 500 || fileName.startsWith('/') || fileName.includes('\\')) return false;
  const parts = fileName.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && /^[A-Za-z0-9_.@+-]+$/.test(part)) && fileName.toLowerCase().endsWith('.gguf') && !/-\d{5}-of-\d{5}\.gguf$/i.test(fileName);
}

function startDownload(db, { repoId, fileName, token }) {
  validateRepoId(repoId);
  if (!safeHfFile(fileName)) throw new Error('Select a valid .gguf file from the repository.');
  const jobId = randomUUID();
  const job = { id: jobId, repoId, fileName, status: 'queued', receivedBytes: 0, totalBytes: 0, error: null, modelId: null, startedAt: new Date().toISOString() };
  downloads.set(jobId, job);
  void downloadFile(db, job, token).catch(error => {
    job.status = 'error';
    job.error = error.message;
  });
  return job;
}

async function downloadFile(db, job, token) {
  job.status = 'downloading';
  const repoFolder = path.resolve(libraryDir, ...job.repoId.split('/'));
  if (!pathInside(libraryDir, repoFolder)) throw new Error('Invalid Hugging Face repository path.');
  const destination = path.resolve(repoFolder, ...job.fileName.split('/'));
  if (!pathInside(repoFolder, destination)) throw new Error('Invalid model file path.');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await fs.promises.stat(destination);
    if (existing.isFile()) {
      const row = await registerModel(db, { name: path.basename(job.fileName, '.gguf'), source: 'huggingface', repoId: job.repoId, fileName: job.fileName, modelPath: destination });
      job.modelId = row.id;
      job.status = 'complete';
      job.receivedBytes = existing.size;
      job.totalBytes = existing.size;
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.${job.id}.part`;
  const url = `https://huggingface.co/${job.repoId}/resolve/main/${job.fileName.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const response = await fetch(url, { headers: hfHeaders(token), redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Hugging Face download failed with HTTP ${response.status}.`);
    job.totalBytes = Number(response.headers.get('content-length') || 0);
    const progress = new Transform({ transform(chunk, _encoding, callback) { job.receivedBytes += chunk.length; callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(temporary));
    if (!await hasGgufHeader(temporary)) throw new Error('The downloaded file is not a valid GGUF model.');
    await fs.promises.rename(temporary, destination);
    const row = await registerModel(db, { name: path.basename(job.fileName, '.gguf'), source: 'huggingface', repoId: job.repoId, fileName: job.fileName, modelPath: destination });
    job.modelId = row.id;
    job.status = 'complete';
    job.receivedBytes = job.totalBytes || job.receivedBytes;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function getDownload(jobId) { return downloads.get(jobId) || null; }

async function findPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function activateModel(db, id, settings) {
  const model = getModel(db, id);
  if (!model) throw new Error('Model not found in the library.');
  const inspection = await inspectPath(model.model_path);
  const runtime = llamaExecutable();
  if (runtime.available && model.format === 'gguf-folder' && !inspection.launchPath) {
    throw new Error('This folder contains multiple GGUF files. Add the specific .gguf file you want to load.');
  }
  const previousProvider = settings.provider;
  const managedEndpoint = runtimeStatus().endpoint;
  if (llamaProcess && !llamaProcess.killed) await stopRuntime();
  if (previousProvider !== 'local') {
    settings.apiKey = '';
    settings.baseUrl = 'http://127.0.0.1:8080/v1';
  } else if (managedEndpoint && settings.baseUrl === managedEndpoint) settings.baseUrl = 'http://127.0.0.1:8080/v1';
  settings.provider = 'local';
  settings.model = model.name;
  if (!settings.baseUrl) settings.baseUrl = 'http://127.0.0.1:8080/v1';

  let launched = false;
  if (inspection.launchPath && model.format !== 'transformers' && runtime.available) {
    const executable = runtime.command;
    const port = await findPort();
    const child = spawn(executable, ['--model', inspection.launchPath, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '4096'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    llamaProcess = child;
    activeModelId = model.id;
    llamaPort = port;
    const clearIfCurrent = () => {
      if (llamaProcess === child) {
        llamaProcess = null;
        activeModelId = null;
        llamaPort = null;
      }
    };
    child.once('exit', () => {
      clearIfCurrent();
    });
    const exited = new Promise(resolve => {
      child.once('exit', code => resolve(new Error(`llama-server exited${code === null ? '' : ` with code ${code}`}.${stderr ? ` ${stderr.trim()}` : ''}`)));
      child.once('error', error => resolve(new Error(`Could not start llama-server: ${error.message}`)));
    });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw await exited;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* model is still loading */ }
      const failure = await Promise.race([new Promise(resolve => setTimeout(() => resolve(null), 500)), exited]);
      if (failure) { clearIfCurrent(); throw failure; }
    }
    if (!ready) {
      child.kill();
      clearIfCurrent();
      throw new Error(`llama-server did not become ready within one minute. Check the runtime path and model compatibility.${stderr ? ` ${stderr.trim()}` : ''}`);
    }
    settings.baseUrl = `http://127.0.0.1:${port}/v1`;
    launched = true;
  }
  return { model: publicModel(model), settings, launched, runtimeConfigured: runtime.available, endpoint: settings.baseUrl };
}

async function stopRuntime() {
  const child = llamaProcess;
  llamaProcess = null;
  activeModelId = null;
  llamaPort = null;
  if (child && child.exitCode === null && !child.killed) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
}

function runtimeStatus() {
  const runtime = llamaExecutable();
  return {
    configured: runtime.available,
    available: runtime.available,
    source: runtime.source,
    executable: runtime.name,
    configurationError: runtime.configured && !runtime.available ? `Could not find ${runtime.name} on disk or on PATH.` : null,
    running: Boolean(llamaProcess && !llamaProcess.killed),
    modelId: activeModelId,
    port: llamaPort,
    endpoint: llamaPort ? `http://127.0.0.1:${llamaPort}/v1` : null
  };
}

module.exports = { initModels, getModels, getModel, registerModel, listHuggingFaceFiles, startDownload, getDownload, activateModel, stopRuntime, runtimeStatus, inspectPath, libraryDir, pathInside };
