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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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


app.listen(3000,()=>{
    console.log('Server is running on port 3000');
    console.log("🚀 Visit: http://localhost:3000");
})