const fs = require('fs');
const path = require('path');

const workspaceDir = path.resolve(__dirname, '..');
const memoryDir = workspaceDir; // store MEMORY.md and USER.md in root workspace

function getFilePath(filename) {
  return path.join(memoryDir, filename);
}

function initMemory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('fact','preference','lesson','environment','project')),
      content TEXT NOT NULL,
      source TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      owner_id,
      category,
      content,
      tokenize='porter unicode61'
    );
  `);
}

function addMemory(db, { id, ownerId = 'default', category = 'fact', content, source = 'system', importance = 3, expiresAt = null }) {
  if (!content || !content.trim()) return null;
  const entryId = id || require('crypto').randomUUID();
  const now = new Date().toISOString();
  
  const insert = db.prepare(`
    INSERT INTO memory_entries (id, owner_id, category, content, source, importance, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(entryId, ownerId, category, content.trim(), source, importance, now, now, expiresAt);

  const insertFts = db.prepare(`
    INSERT INTO memory_fts (id, owner_id, category, content)
    VALUES (?, ?, ?, ?)
  `);
  insertFts.run(entryId, ownerId, category, content.trim());

  return entryId;
}

function searchMemory(db, { ownerId = 'default', query, category, limit = 5 }) {
  if (!query || !query.trim()) return [];
  const cleanQuery = query.replace(/[^\w\s]/g, ' ').trim();
  if (!cleanQuery) return [];

  try {
    let sql = `
      SELECT m.*, rank
      FROM memory_fts f
      JOIN memory_entries m ON f.id = m.id
      WHERE f.owner_id = ? AND memory_fts MATCH ?
    `;
    const params = [ownerId, cleanQuery];

    if (category) {
      sql += ` AND m.category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY rank, m.importance DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  } catch (err) {
    // Fallback if FTS syntax fails
    const fallbackSql = `
      SELECT * FROM memory_entries 
      WHERE owner_id = ? AND content LIKE ? 
      ORDER BY importance DESC, updated_at DESC LIMIT ?
    `;
    return db.prepare(fallbackSql).all(ownerId, `%${cleanQuery}%`, limit);
  }
}

function getRecentMemories(db, { ownerId = 'default', category, limit = 10 }) {
  let sql = `SELECT * FROM memory_entries WHERE owner_id = ?`;
  const params = [ownerId];
  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }
  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function deleteMemory(db, id) {
  db.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(id);
}

function pruneExpired(db) {
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at < ?`).run(now);
}

function readContextFile(name) {
  const safeName = path.basename(name);
  const target = getFilePath(safeName);
  try {
    if (fs.existsSync(target)) {
      return fs.readFileSync(target, 'utf8');
    }
  } catch (e) {
    // ignore
  }
  return '';
}

function writeContextFile(name, content) {
  const safeName = path.basename(name);
  const target = getFilePath(safeName);
  fs.writeFileSync(target, content, 'utf8');
}

function appendContextFile(name, entry) {
  const safeName = path.basename(name);
  const target = getFilePath(safeName);
  const timestamp = new Date().toISOString().split('T')[0];
  const formatted = `\n- [${timestamp}] ${entry.trim()}`;
  fs.appendFileSync(target, formatted, 'utf8');
}

function buildMemoryContext(db, { ownerId = 'default', query = '' }) {
  const sections = [];
  const memoryMd = readContextFile('MEMORY.md');
  if (memoryMd.trim()) {
    sections.push(`### Project & Persistent Context (MEMORY.md):\n${memoryMd.trim()}`);
  }

  const userMd = readContextFile('USER.md');
  if (userMd.trim()) {
    sections.push(`### User Profile & Preferences (USER.md):\n${userMd.trim()}`);
  }

  if (query) {
    const hits = searchMemory(db, { ownerId, query, limit: 4 });
    if (hits.length > 0) {
      const recalled = hits.map(h => `- [${h.category}] ${h.content}`).join('\n');
      sections.push(`### Relevant Recalled Memories:\n${recalled}`);
    }
  }

  return sections.join('\n\n');
}

function nudgeMemoryPersistence(db, { ownerId = 'default', messages = [] }) {
  const candidates = [];
  const patterns = [
    { regex: /(?:remember that|note that|keep in mind that)\s+([^.!?\n]+)/i, category: 'fact' },
    { regex: /(?:i prefer|my preference is|always prefer)\s+([^.!?\n]+)/i, category: 'preference' },
    { regex: /(?:my name is|i am)\s+([A-Za-z0-9_-]+)/i, category: 'preference' },
    { regex: /(?:the lesson learned is|we learned that)\s+([^.!?\n]+)/i, category: 'lesson' },
    { regex: /(?:in this project we|this project uses)\s+([^.!?\n]+)/i, category: 'project' }
  ];

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = msg.content || '';
    for (const p of patterns) {
      const match = text.match(p.regex);
      if (match && match[1]) {
        candidates.push({
          category: p.category,
          content: match[0].trim(),
          source: 'conversation_nudge'
        });
      }
    }
  }

  return candidates;
}

module.exports = {
  initMemory,
  addMemory,
  searchMemory,
  getRecentMemories,
  deleteMemory,
  pruneExpired,
  readContextFile,
  writeContextFile,
  appendContextFile,
  buildMemoryContext,
  nudgeMemoryPersistence
};
