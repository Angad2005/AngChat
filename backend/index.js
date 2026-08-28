const express=require('express');
const cors=require('cors');
const path = require('path');
const session = require('express-session');
const { db, query } = require('./db');


require('dotenv').config();


const app=express();


app.use(express.json());
app.use(cors());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS during production
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// app.get('/',(req,res)=>{
//     res.send('Hello from backend');
// })

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.redirect('/auth');
}

app.get('/', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, '..' , 'public', 'First.html'));
});


app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, '..' , 'public', 'Login.html'));
});


function initializeDatabase() {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
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
testConnection();

//fetching data from database
app.get('/api/profile', isAuthenticated, async (req, res) => {
    try {
        const user = await query('SELECT id, username, email FROM users WHERE id = ?', [req.session.userId]);
        if (!user || user.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        console.error('❌ Error fetching profile:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

//putting data into database
app.post('/api/register', async (req, res) => {
    const { username, password, email } = req.body;

    try {
        const result = await query(
            'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
            [username, password, email]
        );
        res.status(201).json({ id: result.insertId, username, email });
    } catch (err) {
        console.error('❌ Error registering user:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});



app.listen(3000,()=>{
    console.log('Server is running on port 3000');
    console.log("🚀 Visit: http://localhost:3000");
})