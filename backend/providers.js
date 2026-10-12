const inference = require('./inference');
const { openaiTools, anthropicTools, geminiTools, toolPrompt } = require('./tools');

const DEFAULTS = {
  provider: process.env.LLM_PROVIDER || 'mock',
  model: process.env.LLM_MODEL || 'angchat-demo',
  baseUrl: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',
  temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
  maxTokens: Number(process.env.LLM_MAX_TOKENS || 1200),
  toolsEnabled: true,
  inferenceEngine: process.env.LLM_INFERENCE_ENGINE || 'auto',
  fallbackProviders: [],
  retryAttempts: 2,
  retryDelayMs: 1000,
  rateLimitBackoffMs: 5000,
  auxiliaryProviders: {}
};

const PROVIDERS = ['openai', 'local', 'ollama', 'anthropic', 'gemini', 'mock'];
const AUXILIARY_TASKS = ['compression', 'vision', 'skills_hub', 'memory'];

function publicSettings(settings) {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    toolsEnabled: settings.toolsEnabled !== false,
    inferenceEngine: settings.inferenceEngine || 'auto',
    inProcess: inference.isReady(),
    hasApiKey: settings.provider !== 'local' && settings.provider !== 'ollama' && Boolean(settings.apiKey),
    hasFallback: Boolean(settings.fallbackProviders?.length),
    retryAttempts: settings.retryAttempts || 2
  };
}

function normalizeSettings(input = {}, current = DEFAULTS) {
  const next = { ...current };
  if (typeof input.provider === 'string' && PROVIDERS.includes(input.provider)) next.provider = input.provider;
  if (typeof input.model === 'string' && input.model.trim()) next.model = input.model.trim();
  if (typeof input.baseUrl === 'string') next.baseUrl = input.baseUrl.trim().replace(/\/$/, '');
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
  if (input.clearApiKey === true) next.apiKey = '';
  if (Number.isFinite(Number(input.temperature))) next.temperature = Math.min(2, Math.max(0, Number(input.temperature)));
  if (Number.isFinite(Number(input.maxTokens))) next.maxTokens = Math.min(32000, Math.max(128, Number(input.maxTokens)));
  if (typeof input.toolsEnabled === 'boolean') next.toolsEnabled = input.toolsEnabled;
  if (typeof input.inferenceEngine === 'string' && ['auto', 'in-process', 'llama-server', 'ollama'].includes(input.inferenceEngine)) {
    next.inferenceEngine = input.inferenceEngine;
  }
  if (Array.isArray(input.fallbackProviders)) {
    next.fallbackProviders = input.fallbackProviders;
  }
  if (Number.isFinite(Number(input.retryAttempts))) {
    next.retryAttempts = Math.min(5, Math.max(1, Number(input.retryAttempts)));
  }
  if (Number.isFinite(Number(input.retryDelayMs))) {
    next.retryDelayMs = Math.min(10000, Math.max(500, Number(input.retryDelayMs)));
  }
  if (Number.isFinite(Number(input.rateLimitBackoffMs))) {
    next.rateLimitBackoffMs = Math.min(30000, Math.max(1000, Number(input.rateLimitBackoffMs)));
  }
  if (input.auxiliaryProviders && typeof input.auxiliaryProviders === 'object') {
    next.auxiliaryProviders = input.auxiliaryProviders;
  }
  return next;
}

function systemPrompt(mode, toolsEnabled) {
  const base = mode === 'code'
    ? 'You are a coding assistant inside the AngChat harness. Prefer precise, repository-aware answers when workspace context is present. Do not claim to inspect files, run commands, or edit code unless a tool actually did so.'
    : 'You are an AI product copilot inside the AngChat harness. Give concise, structured, actionable answers and state assumptions.';
  return toolsEnabled ? `${base}\n\n${toolPrompt(mode)}` : base;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `Provider returned HTTP ${response.status}`);
  return data;
}

async function readSse(response, onEvent, signal) {
  if (!response.ok) {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    throw new Error(data?.error?.message || data?.error || `Provider returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Provider returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) throw new Error('Generation stopped.');
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const dataLines = chunk.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;
      try { onEvent(JSON.parse(payload)); } catch { /* ignore keepalives */ }
    }
  }
}

function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function toOpenAiMessages(messages) {
  return messages.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        name: message.name,
        tool_call_id: message.tool_call_id || message.id || 'tool_1',
        content: message.content || ''
      };
    }
    if (message.tool_calls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
        }))
      };
    }
    return { role: message.role, content: message.content || '' };
  });
}

function toOllamaMessages(messages) {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', content: message.content || '', name: message.name };
    if (message.tool_calls?.length) {
      return {
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls.map(call => ({ function: { name: call.name, arguments: call.arguments || {} } }))
      };
    }
    return { role: message.role === 'system' ? 'system' : message.role, content: message.content || '' };
  });
}

function toAnthropicMessages(messages) {
  const converted = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const last = converted[converted.length - 1];
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id || message.id || 'tool_1', content: message.content || '' };
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else converted.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.tool_calls?.length) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments || {} });
      }
      converted.push({ role: 'assistant', content });
      continue;
    }
    converted.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content || '' });
  }
  return converted;
}

function nativeToolCallsFromOpenAi(message = {}) {
  return (message.tool_calls || []).map((call, index) => ({
    id: call.id || `tool_${index + 1}`,
    name: call.function?.name,
    arguments: parseToolArguments(call.function?.arguments)
  })).filter(call => call.name);
}

async function completeOpenAi({ base, headers, model, messages, temperature, maxTokens, tools, onToken, signal, extra = {} }) {
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: toOpenAiMessages(messages),
    stream: Boolean(onToken),
    ...extra
  };
  if (tools?.length) body.tools = tools;
  if (!onToken) {
    const data = await requestJson(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
    const message = data.choices?.[0]?.message || {};
    return {
      text: message.content || '',
      mock: false,
      usage: data.usage,
      toolCalls: nativeToolCallsFromOpenAi(message)
    };
  }
  let text = '';
  const toolAcc = new Map();
  let usage;
  await readSse(await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  }), (event) => {
    usage = event.usage || usage;
    const delta = event.choices?.[0]?.delta || {};
    if (delta.content) {
      text += delta.content;
      onToken(delta.content);
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? 0;
      const current = toolAcc.get(index) || { id: call.id, name: '', arguments: '' };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      toolAcc.set(index, current);
    }
  }, signal);
  const toolCalls = [...toolAcc.values()].map((call, index) => ({
    id: call.id || `tool_${index + 1}`,
    name: call.name,
    arguments: parseToolArguments(call.arguments)
  })).filter(call => call.name);
  return { text, mock: false, usage, toolCalls };
}

async function completeOllama({ base, model, messages, temperature, maxTokens, tools, onToken, signal }) {
  const url = `${base.replace(/\/$/, '')}/api/chat`;
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: Boolean(onToken),
    options: { temperature, num_predict: maxTokens }
  };
  if (tools?.length) body.tools = tools;
  if (!onToken) {
    const data = await requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const message = data.message || {};
    return {
      text: message.content || '',
      mock: false,
      toolCalls: (message.tool_calls || []).map((call, index) => ({
        id: `tool_${index + 1}`,
        name: call.function?.name,
        arguments: parseToolArguments(call.function?.arguments)
      })).filter(call => call.name)
    };
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const toolCalls = [];
  while (true) {
    if (signal?.aborted) throw new Error('Generation stopped.');
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const chunk = event.message?.content || '';
      if (chunk) {
        text += chunk;
        onToken(chunk);
      }
      for (const call of event.message?.tool_calls || []) {
        toolCalls.push({
          id: `tool_${toolCalls.length + 1}`,
          name: call.function?.name,
          arguments: parseToolArguments(call.function?.arguments)
        });
      }
    }
  }
  return { text, mock: false, toolCalls: toolCalls.filter(call => call.name) };
}

async function completeAnthropic({ base, apiKey, model, messages, temperature, maxTokens, tools, onToken, signal }) {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const payload = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: toAnthropicMessages(messages),
    stream: Boolean(onToken)
  };
  if (tools?.length) payload.tools = tools;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (!onToken) {
    const data = await requestJson(`${base}/messages`, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    const text = (data.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
    const toolCalls = (data.content || []).filter(part => part.type === 'tool_use').map(part => ({
      id: part.id,
      name: part.name,
      arguments: part.input || {}
    }));
    return { text, mock: false, usage: data.usage, toolCalls };
  }
  let text = '';
  const toolAcc = new Map();
  let usage;
  await readSse(await fetch(`${base}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal
  }), (event) => {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      text += event.delta.text;
      onToken(event.delta.text);
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolAcc.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' });
    }
    if (event.type === 'content_block_delta' && event.delta?.partial_json && toolAcc.has(event.index)) {
      toolAcc.get(event.index).arguments += event.delta.partial_json;
    }
    if (event.usage) usage = event.usage;
  }, signal);
  const toolCalls = [...toolAcc.values()].map(call => ({
    id: call.id,
    name: call.name,
    arguments: parseToolArguments(call.arguments)
  }));
  return { text, mock: false, usage, toolCalls };
}

async function completeGemini({ base, apiKey, model, messages, temperature, maxTokens, tools, onToken, signal }) {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: message.name, response: { result: message.content } } }]
      });
      continue;
    }
    if (message.tool_calls?.length) {
      contents.push({
        role: 'model',
        parts: message.tool_calls.map(call => ({ functionCall: { name: call.name, args: call.arguments || {} } }))
      });
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content || '' }]
    });
  }
  const payload = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
    tools: tools?.length ? tools : undefined
  };
  const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const data = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map(part => part.text || '').join('');
  if (text && onToken) onToken(text);
  const toolCalls = parts.filter(part => part.functionCall?.name).map((part, index) => ({
    id: `tool_${index + 1}`,
    name: part.functionCall.name,
    arguments: part.functionCall.args || {}
  }));
  return { text, mock: false, usage: data.usageMetadata, toolCalls };
}

function shouldUseInProcess(settings) {
  if (!inference.isReady()) return false;
  if (settings.inferenceEngine === 'in-process') return true;
  if (settings.inferenceEngine === 'llama-server' || settings.inferenceEngine === 'ollama') return false;
  return settings.provider === 'local';
}

async function completeTurn({ mode, messages, settings, toolsEnabled, onToken, signal }) {
  const useTools = toolsEnabled && settings.toolsEnabled !== false;
  const withSystem = [{ role: 'system', content: systemPrompt(mode, useTools) }, ...messages.filter(message => message.role !== 'system')];

  if (settings.provider === 'mock') {
    const text = 'Mock mode is enabled, so no model was called. Configure a real provider in Settings or activate a local GGUF.';
    if (onToken) onToken(text);
    return { text, mock: true, engine: 'mock', toolCalls: [] };
  }

  if (shouldUseInProcess(settings)) {
    const result = await inference.complete({
      messages: withSystem,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      onToken,
      signal
    });
    return { ...result, toolCalls: result.toolCalls || [] };
  }

  if (settings.provider !== 'local' && settings.provider !== 'ollama' && !settings.apiKey) {
    throw new Error('No API key is configured for this provider. Open Settings and add one.');
  }

  if (settings.provider === 'ollama') {
    const base = settings.baseUrl || 'http://127.0.0.1:11434';
    const result = await completeOllama({
      base,
      model: settings.model,
      messages: withSystem,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      tools: useTools ? openaiTools(mode) : undefined,
      onToken,
      signal
    });
    return { ...result, engine: 'ollama' };
  }

  if (settings.provider === 'openai' || settings.provider === 'local') {
    const base = settings.baseUrl || (settings.provider === 'local' ? 'http://127.0.0.1:8080/v1' : 'https://api.openai.com/v1');
    const headers = { 'Content-Type': 'application/json' };
    if (settings.provider === 'openai' && settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const result = await completeOpenAi({
      base,
      headers,
      model: settings.model,
      messages: withSystem,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      tools: useTools ? openaiTools(mode) : undefined,
      onToken,
      signal
    });
    return { ...result, engine: settings.provider === 'local' ? 'llama-server' : 'openai' };
  }

  if (settings.provider === 'anthropic') {
    const base = settings.baseUrl || 'https://api.anthropic.com/v1';
    const result = await completeAnthropic({
      base,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: withSystem,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      tools: useTools ? anthropicTools(mode) : undefined,
      onToken,
      signal
    });
    return { ...result, engine: 'anthropic' };
  }

  const base = settings.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const result = await completeGemini({
    base,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: withSystem,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    tools: useTools ? geminiTools(mode) : undefined,
    onToken,
    signal
  });
  return { ...result, engine: 'gemini' };
}

async function callProvider({ mode, prompt, settings, messages, toolsEnabled = false, onToken, signal }) {
  const history = messages?.length ? messages : [{ role: 'user', content: prompt }];
  return completeTurn({ mode, messages: history, settings, toolsEnabled, onToken, signal });
}

function isRetryableError(error) {
  const message = error.message || '';
  return /429|500|502|503|ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket/i.test(message);
}

function isRateLimited(error) {
  return /429|rate.?limit/i.test(error.message || '');
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveAuxiliaryProvider(settings, taskName) {
  if (settings.auxiliaryProviders && settings.auxiliaryProviders[taskName]) {
    return normalizeSettings(settings.auxiliaryProviders[taskName], settings);
  }
  return settings;
}

async function completeTurnWithFallback(params) {
  const { settings, signal, onToken } = params;
  const attempts = [
    settings,
    ...(Array.isArray(settings.fallbackProviders) ? settings.fallbackProviders.map(p => normalizeSettings(p, settings)) : [])
  ];

  let lastError = null;
  const attemptedProviders = [];

  for (let i = 0; i < attempts.length; i++) {
    const currentSettings = attempts[i];
    attemptedProviders.push(`${currentSettings.provider}:${currentSettings.model}`);
    const maxRetries = i === 0 ? (settings.retryAttempts || 2) : 1;

    for (let retry = 0; retry < maxRetries; retry++) {
      if (signal?.aborted) throw new Error('Generation stopped.');
      try {
        const result = await completeTurn({ ...params, settings: currentSettings });
        return {
          ...result,
          fallbackUsed: i > 0,
          attemptedProviders
        };
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) {
          // Non-retryable error (e.g. 401 Unauthorized, bad parameter) -> fail over immediately to next provider
          break;
        }
        if (retry < maxRetries - 1) {
          const waitMs = isRateLimited(err) ? (settings.rateLimitBackoffMs || 5000) : (settings.retryDelayMs || 1000);
          await delay(waitMs);
        }
      }
    }
  }

  throw new Error(`All providers in fallback chain failed: ${lastError?.message || 'Unknown error'}`);
}

module.exports = { 
  DEFAULTS, 
  PROVIDERS, 
  AUXILIARY_TASKS,
  normalizeSettings, 
  publicSettings, 
  callProvider, 
  completeTurn, 
  completeTurnWithFallback,
  resolveAuxiliaryProvider,
  isRetryableError,
  systemPrompt 
};

