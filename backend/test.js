const assert = require('assert');
const path = require('path');
const { parseToolCalls, stripToolMarkup, resolveWorkspacePath, toolsForMode } = require('./tools');

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
assert.ok(toolsForMode('code').some(tool => tool.name === 'memory_store'));
assert.ok(toolsForMode('app').some(tool => tool.name === 'read_file'));

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

console.log('AngChat harness tests passed with all Hermes Agent features verified.');

