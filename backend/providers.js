const DEFAULTS = {
  provider: process.env.LLM_PROVIDER || 'mock',
  model: process.env.LLM_MODEL || 'angchat-demo',
  baseUrl: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',
  temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
  maxTokens: Number(process.env.LLM_MAX_TOKENS || 1200)
};

const PROVIDERS = ['openai', 'local', 'anthropic', 'gemini', 'mock'];

function publicSettings(settings) {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    hasApiKey: settings.provider !== 'local' && Boolean(settings.apiKey)
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
  return next;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `Provider returned HTTP ${response.status}`);
  return data;
}

async function callProvider({ mode, prompt, settings }) {
  const system = mode === 'code'
    ? 'You are a coding assistant. Give repository-aware help only when repository context is included in the user message. Do not claim to inspect files, run commands, or edit code unless tools actually did so.'
    : 'You are an AI product copilot. Give concise, structured, actionable answers and state assumptions.';

  if (settings.provider === 'mock') {
    return { text: `Mock mode is enabled, so no model was called. Configure a real provider in Settings to run this prompt.`, mock: true };
  }
  if (settings.provider !== 'local' && !settings.apiKey) {
    throw new Error('No API key is configured for this provider. Open Settings and add one.');
  }

  if (settings.provider === 'openai' || settings.provider === 'local') {
    const base = settings.baseUrl || (settings.provider === 'local' ? 'http://127.0.0.1:8080/v1' : 'https://api.openai.com/v1');
    const headers = { 'Content-Type': 'application/json' };
    if (settings.provider === 'openai' && settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const data = await requestJson(`${base}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: settings.model, temperature: settings.temperature, max_tokens: settings.maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
    });
    return { text: data.choices?.[0]?.message?.content || 'The provider returned no text.', mock: false, usage: data.usage };
  }

  if (settings.provider === 'anthropic') {
    const base = settings.baseUrl || 'https://api.anthropic.com/v1';
    const data = await requestJson(`${base}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.model, max_tokens: settings.maxTokens, temperature: settings.temperature, system, messages: [{ role: 'user', content: prompt }] })
    });
    return { text: data.content?.map(part => part.text || '').join('') || 'The provider returned no text.', mock: false, usage: data.usage };
  }

  const base = settings.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const data = await requestJson(`${base}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: settings.temperature, maxOutputTokens: settings.maxTokens } })
  });
  return { text: data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || 'The provider returned no text.', mock: false, usage: data.usageMetadata };
}

module.exports = { DEFAULTS, normalizeSettings, publicSettings, callProvider };
