const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const { db, query } = require('./db');

require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors()); 
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS during production
        maxAge: 1000 * 60 * 60 * 24
    }
}));

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    // If it's an API request, return 401. If it's a page request, redirect.
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/auth');
}

// --- ROUTES ---
app.get('/', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'First.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'Login.html'));
});

// ✅ FIX: Actually added isAuthenticated here (it was missing in the arguments)
app.get('/admin', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'Admin.html'));
});

// --- Auth Routes ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const users = await query('SELECT id, username, email FROM users WHERE username = ? AND password = ?', [username, password]);
        if (users.length > 0) {
            req.session.userId = users[0].id;
            req.session.username = users[0].username;
            res.json({ message: 'Login successful', user: users[0] });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: 'Could not log out' });
        res.json({ message: 'Logged out successfully' });
    });
});

// --- Admin CRUD Routes for Users ---
app.get('/api/users', isAuthenticated, async (req, res) => {
    try {
        const users = await query('SELECT id, username, email FROM users');
        res.json(users);
    } catch (err) {
        console.error('❌ Error fetching users:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/users', isAuthenticated, async (req, res) => {
    const { username, password, email } = req.body;
    try {
        const result = await query(
            'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
            [username, password, email]
        );
        res.status(201).json({ id: result.insertId, username, email });
    } catch (err) {
        console.error('❌ Error creating user:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/users/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const { username, password, email } = req.body;
    try {
        await query(
            'UPDATE users SET username = ?, email = ?, password = COALESCE(NULLIF(?, ""), password) WHERE id = ?',
            [username, email, password, id]
        );
        res.json({ message: 'User updated successfully' });
    } catch (err) {
        console.error('❌ Error updating user:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/users/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    try {
        await query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        console.error('❌ Error deleting user:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- DATABASE FUNCTIONS ---
function initializeDatabase() {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL
            );
        `);
        console.log('✅ Database tables initialized successfully!');
    } catch (err) {
        console.error('❌ Database initialization failed:', err.message);
    }
}

async function testConnection() {
    try {
        const result = await query('SELECT 1 + 1 AS solution');
        console.log('✅ Database connected successfully!');
        console.log('Test query result:', result[0]);
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
    }
}

initializeDatabase();
testConnection();

app.listen(3000, () => {
    console.log('Server is running on port 3000');
    console.log("🚀 Visit: http://localhost:3000/admin");
});