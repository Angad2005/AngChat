const fs = require('fs');
const path = require('path');

const workspaceDir = path.resolve(__dirname, '..');
const skillsDir = path.join(workspaceDir, 'skills');

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }
  const rawMeta = match[1];
  const body = match[2];
  const meta = {};

  const lines = rawMeta.split('\n');
  let currentKey = null;
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('- ') && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(line.slice(2).trim());
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      currentKey = key;
      if (val === '') {
        meta[key] = [];
      } else {
        meta[key] = val;
      }
    }
  }

  return { meta, body };
}

function initSkills(db) {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      version INTEGER DEFAULT 1,
      trigger_pattern TEXT,
      file_path TEXT NOT NULL,
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  scanSkillsDirectory(db);
}

function scanSkillsDirectory(db) {
  if (!fs.existsSync(skillsDir)) return;
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          const { meta } = parseSkillFrontmatter(content);
          const name = meta.name || entry.name;
          const description = meta.description || '';
          const trigger = Array.isArray(meta.triggers) ? meta.triggers.join('|') : (meta.triggers || '');
          const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
          
          db.prepare(`
            INSERT INTO skills (id, name, description, trigger_pattern, file_path, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(name) DO UPDATE SET
              description=excluded.description,
              trigger_pattern=excluded.trigger_pattern,
              file_path=excluded.file_path,
              updated_at=CURRENT_TIMESTAMP
          `).run(id, name, description, trigger, skillFile);
        } catch (e) {
          // ignore scan errors
        }
      }
    }
  }
}

function listSkills(db) {
  return db.prepare(`SELECT * FROM skills ORDER BY usage_count DESC, name ASC`).all();
}

function getSkill(db, nameOrId) {
  const row = db.prepare(`SELECT * FROM skills WHERE id = ? OR name = ?`).get(nameOrId, nameOrId);
  if (!row) return null;
  let content = '';
  if (fs.existsSync(row.file_path)) {
    content = fs.readFileSync(row.file_path, 'utf8');
  }
  return { ...row, content };
}

function findMatchingSkills(db, userMessage) {
  if (!userMessage || typeof userMessage !== 'string') return [];
  const skills = listSkills(db);
  const matched = [];

  for (const skill of skills) {
    if (!skill.trigger_pattern) continue;
    const triggers = skill.trigger_pattern.split('|');
    for (const trig of triggers) {
      const clean = trig.trim();
      if (!clean) continue;
      if (clean.startsWith('regex:')) {
        try {
          const re = new RegExp(clean.slice(6), 'i');
          if (re.test(userMessage)) {
            matched.push(skill);
            break;
          }
        } catch (e) {}
      } else if (clean.startsWith('/')) {
        if (userMessage.startsWith(clean) || userMessage.includes(` ${clean} `) || userMessage.endsWith(` ${clean}`)) {
          matched.push(skill);
          break;
        }
      } else {
        if (userMessage.toLowerCase().includes(clean.toLowerCase())) {
          matched.push(skill);
          break;
        }
      }
    }
  }

  return matched;
}

function recordSkillUsage(db, skillId) {
  db.prepare(`
    UPDATE skills 
    SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP 
    WHERE id = ? OR name = ?
  `).run(skillId, skillId);
}

function createSkill(db, { name, description = '', triggerPattern = '', content = '' }) {
  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const dir = path.join(skillsDir, cleanName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const skillFile = path.join(dir, 'SKILL.md');
  const fullContent = `---
name: ${name}
description: ${description}
version: 1
triggers:
  - ${triggerPattern || `/${cleanName}`}
---

${content.trim() || '# ' + name + '\n\nInstructions and procedures for ' + name}
`;

  fs.writeFileSync(skillFile, fullContent, 'utf8');
  db.prepare(`
    INSERT INTO skills (id, name, description, version, trigger_pattern, file_path, usage_count, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      description=excluded.description,
      trigger_pattern=excluded.trigger_pattern,
      file_path=excluded.file_path,
      version=skills.version + 1,
      updated_at=CURRENT_TIMESTAMP
  `).run(cleanName, name, description, triggerPattern || `/${cleanName}`, skillFile);

  return getSkill(db, cleanName);
}

function updateSkillContent(db, skillId, { content, description, triggerPattern }) {
  const skill = getSkill(db, skillId);
  if (!skill) throw new Error('Skill not found');

  const { meta } = parseSkillFrontmatter(skill.content);
  const newDesc = description !== undefined ? description : (meta.description || skill.description);
  const newTrig = triggerPattern !== undefined ? triggerPattern : skill.trigger_pattern;
  const newVer = (skill.version || 1) + 1;

  const fileContent = `---
name: ${skill.name}
description: ${newDesc}
version: ${newVer}
triggers:
${newTrig.split('|').map(t => '  - ' + t.trim()).join('\n')}
---

${content.trim()}
`;

  fs.writeFileSync(skill.file_path, fileContent, 'utf8');
  db.prepare(`
    UPDATE skills 
    SET description = ?, trigger_pattern = ?, version = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newDesc, newTrig, newVer, skill.id);

  return getSkill(db, skill.id);
}

function deleteSkill(db, skillId) {
  db.prepare(`DELETE FROM skills WHERE id = ? OR name = ?`).run(skillId, skillId);
}

function buildSkillContext(db, userMessage) {
  const matching = findMatchingSkills(db, userMessage);
  if (!matching.length) return '';

  const parts = matching.map(skill => {
    const full = getSkill(db, skill.id);
    recordSkillUsage(db, skill.id);
    const { body } = parseSkillFrontmatter(full.content);
    return `### Skill: ${skill.name} (v${skill.version})\n${body.trim()}`;
  });

  return `### Active Self-Improving Skills:\n` + parts.join('\n\n');
}

module.exports = {
  skillsDir,
  parseSkillFrontmatter,
  initSkills,
  scanSkillsDirectory,
  listSkills,
  getSkill,
  findMatchingSkills,
  recordSkillUsage,
  createSkill,
  updateSkillContent,
  deleteSkill,
  buildSkillContext
};
