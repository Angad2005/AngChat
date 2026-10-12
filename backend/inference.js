const path = require('path');

let loadError = null;
let llamaModule = null;
let llamaRuntime = null;
let loadedModel = null;
let loadedContext = null;
let loadedSequence = null;
let loadedPath = null;
let loadedName = null;
let queue = Promise.resolve();

function available() {
  return !loadError || Boolean(llamaModule);
}

function status() {
  return {
    engine: 'in-process',
    available: Boolean(llamaModule) || loadError === null,
    loaded: Boolean(loadedModel),
    modelPath: loadedPath,
    modelName: loadedName,
    error: loadError
  };
}

async function ensureLibrary() {
  if (llamaModule) return llamaModule;
  try {
    llamaModule = await import('node-llama-cpp');
    loadError = null;
    return llamaModule;
  } catch (error) {
    loadError = error.message;
    llamaModule = null;
    throw new Error(`In-process GGUF inference is unavailable (${error.message}). Install optional dependency node-llama-cpp, or use llama-server / Ollama.`);
  }
}

function enqueue(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

async function unload() {
  return enqueue(async () => {
    try { loadedSequence?.dispose?.(); } catch { /* ignore */ }
    try { loadedContext?.dispose?.(); } catch { /* ignore */ }
    try { loadedModel?.dispose?.(); } catch { /* ignore */ }
    loadedModel = null;
    loadedContext = null;
    loadedSequence = null;
    loadedPath = null;
    loadedName = null;
  });
}

async function load(modelPath, { contextSize = 4096, name } = {}) {
  const lib = await ensureLibrary();
  const resolved = path.resolve(modelPath);
  return enqueue(async () => {
    if (loadedPath === resolved && loadedModel) {
      loadedName = name || loadedName;
      return status();
    }
        try { loadedSequence?.dispose?.(); } catch { /* ignore */ }
    try { loadedContext?.dispose?.(); } catch { /* ignore */ }
    try { loadedModel?.dispose?.(); } catch { /* ignore */ }
    loadedContext = null;
    loadedSequence = null;
    loadedModel = null;
    if (!llamaRuntime) llamaRuntime = await lib.getLlama();
    loadedModel = await llamaRuntime.loadModel({ modelPath: resolved });
    loadedContext = await loadedModel.createContext({ contextSize });
    loadedSequence = loadedContext.getSequence();
    loadedPath = resolved;
    loadedName = name || path.basename(resolved);
    return status();
  });
}

function isReady() {
  return Boolean(loadedModel && loadedContext);
}

function toChatHistory(messages) {
  const systemParts = [];
  const history = [];
  for (const message of messages) {
    if (message.role === 'system') systemParts.push(message.content);
    else if (message.role === 'tool') {
      history.push({ type: 'user', text: `Tool ${message.name || 'result'} returned:\n${message.content}` });
    } else if (message.role === 'assistant') {
      history.push({ type: 'model', text: message.content || '' });
    } else {
      history.push({ type: 'user', text: message.content || '' });
    }
  }
  return { systemPrompt: systemParts.join('\n\n'), history };
}

async function complete({ messages, temperature, maxTokens, onToken, signal }) {
  if (!isReady()) throw new Error('No GGUF model is loaded in the AngChat process. Activate a GGUF from the model library.');
  const lib = await ensureLibrary();
  return enqueue(async () => {
    const { LlamaChatSession } = lib;
    const { systemPrompt, history } = toChatHistory(messages);
    if (!history.length) throw new Error('No messages to complete.');
    const last = history[history.length - 1];
    const prefix = history.slice(0, -1);
    const session = new LlamaChatSession({
      contextSequence: loadedContext.getSequence(),
      systemPrompt: systemPrompt || undefined
    });
    if (prefix.length) session.setChatHistory(prefix);
    const text = await session.prompt(last.text, {
      temperature: Number.isFinite(temperature) ? temperature : 0.2,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 1200,
      signal,
      onTextChunk(chunk) {
        if (onToken) onToken(chunk);
      }
    });
    try { session.dispose?.(); } catch { /* ignore */ }
    return { text, mock: false, engine: 'in-process' };
  });
}

function countTokens(text) {
  if (!text) return 0;
  if (loadedModel?.tokenize) {
    try {
      return loadedModel.tokenize(text).length;
    } catch (e) {
      // fallback
    }
  }
  return Math.ceil(text.length / 4);
}

async function getEmbedding(text) {
  if (!isReady()) throw new Error('No in-process model loaded to generate embeddings.');
  const lib = await ensureLibrary();
  return enqueue(async () => {
    if (loadedModel?.createEmbedding) {
      return await loadedModel.createEmbedding(text);
    }
    // Return deterministic mock vector if model doesn't support embedding directly
    const hash = Buffer.from(text).reduce((acc, byte, idx) => {
      acc[idx % 32] = (acc[idx % 32] || 0) + byte;
      return acc;
    }, new Array(32).fill(0));
    return hash.map(v => v / 255);
  });
}

module.exports = { 
  available, 
  status, 
  load, 
  unload, 
  isReady, 
  complete, 
  ensureLibrary,
  countTokens,
  getEmbedding
};

