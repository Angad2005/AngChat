const models = require('./models');
const memory = require('./memory');
const skills = require('./skills');

function initializeDatabase(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, email TEXT UNIQUE NOT NULL);`);
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!userColumns.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  if (!db.prepare('SELECT 1 FROM users WHERE role = ? LIMIT 1').get('admin')) {
    db.prepare('UPDATE users SET role = ? WHERE id = (SELECT MIN(id) FROM users)').run('admin');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'New session',
    mode TEXT NOT NULL DEFAULT 'app', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS harness_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL, model TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '', temperature REAL NOT NULL DEFAULT 0.2,
    max_tokens INTEGER NOT NULL DEFAULT 1200, active_model_id TEXT
  );`);
  db.pragma('foreign_keys = ON');
  models.initModels(db);
  memory.initMemory(db);
  skills.initSkills(db);
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map(column => column.name);
  if (!messageColumns.includes('meta')) db.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
  const settingsColumns = db.prepare('PRAGMA table_info(harness_settings)').all().map(column => column.name);
  if (!settingsColumns.includes('active_model_id')) db.exec('ALTER TABLE harness_settings ADD COLUMN active_model_id TEXT');
  if (!settingsColumns.includes('tools_enabled')) db.exec('ALTER TABLE harness_settings ADD COLUMN tools_enabled INTEGER NOT NULL DEFAULT 1');
  if (!settingsColumns.includes('inference_engine')) db.exec("ALTER TABLE harness_settings ADD COLUMN inference_engine TEXT NOT NULL DEFAULT 'auto'");
  return db.prepare('SELECT provider,model,base_url,temperature,max_tokens,active_model_id,tools_enabled,inference_engine FROM harness_settings WHERE id=1').get();
}

module.exports = { initializeDatabase };
