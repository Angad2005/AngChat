const Database = require('better-sqlite3');
const path = require('path');

// Create/connect to SQLite database file
const dbPath = path.join(__dirname, 'angchat.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Helper function to convert rows to objects with column names
function prepareStatement(sql) {
    return db.prepare(sql);
}

// Export database instance and helper functions
module.exports = {
    db,
    prepareStatement,
    
    // Convenience methods that mimic promise-based API
    async query(sql, params = []) {
        try {
            const stmt = db.prepare(sql);
            if (sql.trim().toUpperCase().startsWith('SELECT')) {
                return stmt.all(...params);
            } else {
                const result = stmt.run(...params);
                return { 
                    affectedRows: result.changes,
                    insertId: result.lastInsertRowid 
                };
            }
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    },
    
    async get(sql, params = []) {
        try {
            const stmt = db.prepare(sql);
            return stmt.get(...params);
        } catch (error) {
            console.error('Database get error:', error);
            throw error;
        }
    }
};