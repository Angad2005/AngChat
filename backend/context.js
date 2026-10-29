function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages = []) {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead
    total += estimateTokens(m.role);
    total += estimateTokens(m.content);
    if (m.name) total += estimateTokens(m.name);
    if (m.tool_calls) {
      total += estimateTokens(JSON.stringify(m.tool_calls));
    }
  }
  return total;
}

function contextBudget(maxTokens = 4096) {
  const systemReserve = Math.floor(maxTokens * 0.15);
  const toolReserve = Math.floor(maxTokens * 0.10);
  const available = Math.max(256, maxTokens - systemReserve - toolReserve);
  return {
    maxTokens,
    systemReserve,
    toolReserve,
    available
  };
}

function shouldCompress(messages, maxContextTokens = 4096) {
  const currentTokens = estimateMessagesTokens(messages);
  return currentTokens > (maxContextTokens * 0.75);
}

function pruneOldToolResults(messages, { keepLastN = 3 } = {}) {
  const result = [];
  const toolIndices = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      toolIndices.push(i);
    }
  }

  const cutoff = toolIndices.length > keepLastN 
    ? toolIndices[toolIndices.length - 1 - keepLastN] 
    : (keepLastN === 0 && toolIndices.length > 0 ? messages.length : -1);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && (i <= cutoff || keepLastN === 0)) {
      result.push({
        ...msg,
        content: `[Pruned tool result for ${msg.name || 'tool'} (${estimateTokens(msg.content)} tokens saved)]`
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}

function extractTopics(messages) {
  const topics = new Set();
  const text = messages.map(m => m.content || '').join(' ');

  // Extract path-like or code identifiers
  const paths = text.match(/[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]{1,4}/g) || [];
  for (const p of paths.slice(0, 5)) topics.add(p);

  // Extract capitalized phrases / names
  const terms = text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];
  for (const t of terms.slice(0, 8)) {
    if (!['The', 'This', 'That', 'With', 'From', 'User', 'Assistant'].includes(t)) {
      topics.add(t);
    }
  }

  return Array.from(topics).join(', ') || 'general discussion';
}

function compressMiddleContext(messages, { targetTokens = 2048 } = {}) {
  if (messages.length <= 6) return messages;

  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  if (nonSystem.length <= 6) return messages;

  const head = nonSystem.slice(0, 2); // Initial intent
  const tail = nonSystem.slice(-4);   // Recent turns
  const middle = nonSystem.slice(2, -4);

  const topicSummary = extractTopics(middle);
  const summaryMessage = {
    role: 'system',
    content: `[Context Compressed: Conversation previously discussed ${topicSummary}. ${middle.length} turns condensed to conserve context budget.]`
  };

  return [
    ...systemMessages,
    ...head,
    summaryMessage,
    ...tail
  ];
}

function buildSystemPrompt({ mode = 'app', toolsEnabled = true, memoryContext = '', skillContext = '', projectInstructions = '', customSystemPrompt = '' } = {}) {
  const parts = [];

  const base = mode === 'code'
    ? 'You are PatchProof, a repository-aware coding agent. Turn software tasks into focused, inspectable patches. Before editing, inspect the relevant code, tests, and current Git changes. For a bug or failing-check task, reproduce the failure with verify_project when practical. Make the smallest source change that addresses the evidence; do not weaken or rewrite tests just to make them pass. Then run verify_project. If a check fails, inspect its output and make a targeted correction only when the failure is related to your patch; rerun verification after that correction. Stop after two fix-and-verify iterations and report any remaining failure. Inspect the final Git diff and report the actual check results, receipt path, and changed files. Never claim a change or verification succeeded without tool evidence.'
    : 'You are an AI copilot inside PatchProof. Give concise, structured, actionable answers and state assumptions.';

  parts.push(base);

  if (customSystemPrompt && customSystemPrompt.trim()) {
    parts.push(`### Custom Instructions:\n${customSystemPrompt.trim()}`);
  }

  if (memoryContext && memoryContext.trim()) {
    parts.push(memoryContext.trim());
  }

  if (skillContext && skillContext.trim()) {
    parts.push(skillContext.trim());
  }

  if (mode === 'code' && projectInstructions && projectInstructions.trim()) {
    parts.push(`### Project Instructions:\n${projectInstructions.trim()}`);
  }

  const { toolPrompt } = require('./tools');
  if (toolsEnabled) {
    const tPrompt = toolPrompt(mode);
    if (tPrompt) parts.push(tPrompt);
  }

  return parts.join('\n\n');
}

module.exports = {
  estimateTokens,
  estimateMessagesTokens,
  contextBudget,
  shouldCompress,
  pruneOldToolResults,
  extractTopics,
  compressMiddleContext,
  buildSystemPrompt
};
