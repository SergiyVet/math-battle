require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const session = require('express-session');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected successfully at:', res.rows[0].now);
  }
});

// Initialize database tables
async function initDB() {
  try {
    console.log('🔧 Initializing database tables...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scores (
        name TEXT PRIMARY KEY,
        score INTEGER DEFAULT 0,
        total_time INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        pass_hash TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        name TEXT,
        question TEXT,
        correct INTEGER,
        time_ms INTEGER,
        ts INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_results (
        id SERIAL PRIMARY KEY,
        name TEXT,
        level TEXT,
        correct_count INTEGER,
        total_time REAL,
        ts INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
      )
    `);

    // Check if tables have data
    const scoresCount = await pool.query('SELECT COUNT(*) FROM scores');
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const matchesCount = await pool.query('SELECT COUNT(*) FROM matches');
    const resultsCount = await pool.query('SELECT COUNT(*) FROM game_results');
    
    console.log('✅ Database tables initialized successfully!');
    console.log(`📊 Current data: ${usersCount.rows[0].count} users, ${scoresCount.rows[0].count} scores, ${matchesCount.rows[0].count} matches, ${resultsCount.rows[0].count} game results`);
  } catch (err) {
    console.error('❌ Error initializing database:', err);
    console.error('Check your DATABASE_URL environment variable!');
  }
}

initDB();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev_session_secret', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// Passport Google Strategy
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, cb) => {
    try {
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || null;
      const name = profile.displayName || (email ? email.split('@')[0] : 'GoogleUser');
      
      let user = null;
      if (email) {
        const result = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email.toLowerCase()]);
        user = result.rows[0];
      }
      
      if (!user) {
        const result = await pool.query(
          'INSERT INTO users(name, email, pass_hash) VALUES($1, $2, $3) RETURNING id, name, email',
          [name, email, null]
        );
        user = result.rows[0];
      }
      
      return cb(null, user);
    } catch (err) {
      return cb(err);
    }
  }));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
      done(null, result.rows[0]);
    } catch (err) {
      done(err);
    }
  });

  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    const user = req.user;
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const redirectTo = (process.env.GOOGLE_REDIRECT_PATH) || '/';
    res.redirect(`${redirectTo}?token=${encodeURIComponent(token)}`);
  });
} else {
  app.get('/auth/google', (req, res) => {
    res.status(501).send('Google OAuth is not configured on this server.');
  });
}

// Register endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users(name, email, pass_hash) VALUES($1, $2, $3) RETURNING id, name, email',
      [name || email.split('@')[0], email.toLowerCase(), hash]
    );
    
    const user = result.rows[0];
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'email exists' });
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    
    const result = await pool.query('SELECT id, name, email, pass_hash FROM users WHERE email = $1', [email.toLowerCase()]);
    const row = result.rows[0];
    
    if (!row) return res.status(401).json({ error: 'invalid credentials' });
    
    const ok = await bcrypt.compare(password, row.pass_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    
    const user = { id: row.id, name: row.name, email: row.email };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

function generateQuestion(level = 'normal') {
  const ops = ['+', '-', '*'];
  let a, b;
  
  switch (level) {
    case 'easy':
      a = Math.floor(Math.random() * 20) + 1;
      b = Math.floor(Math.random() * 20) + 1;
      break;
    case 'normal':
      a = Math.floor(Math.random() * 50) + 1;
      b = Math.floor(Math.random() * 50) + 1;
      break;
    case 'hard':
      a = Math.floor(Math.random() * 100) + 50;
      b = Math.floor(Math.random() * 100) + 50;
      break;
    default:
      a = Math.floor(Math.random() * 50) + 1;
      b = Math.floor(Math.random() * 50) + 1;
  }
  
  const op = ops[Math.floor(Math.random() * ops.length)];
  let answer;
  if (op === '+') answer = a + b;
  if (op === '-') answer = a - b;
  if (op === '*') answer = a * b;
  const id = Date.now() + Math.random().toString(36).slice(2, 8);
  return { id, text: `${a} ${op} ${b}`, answer };
}

async function getLeaderboard(level = 'normal') {
  try {
    const result = await pool.query(`
      SELECT name, total_time AS "totalTime", level
      FROM game_results
      WHERE level = $1
      ORDER BY total_time ASC
      LIMIT 10
    `, [level]);
    return result.rows;
  } catch (err) {
    console.error('Error getting leaderboard:', err);
    return [];
  }
}

io.on('connection', (socket) => {
  socket.on('join', async (payload) => {
    try {
      if (typeof payload === 'string') {
        socket.data.name = payload || 'Guest';
      } else if (payload && payload.token) {
        const decoded = jwt.verify(payload.token, JWT_SECRET);
        socket.data.userId = decoded.id;
        socket.data.name = decoded.name || decoded.email || 'Guest';
      } else if (payload && payload.name) {
        socket.data.name = payload.name;
      } else {
        socket.data.name = 'Guest';
      }
    } catch (err) {
      socket.data.name = 'Guest';
    }
    
    const leaderboard = await getLeaderboard('normal');
    socket.emit('leaderboard', leaderboard);
  });

  socket.on('startNewGame', () => {
    socket.data.questionStack = [];
    socket.data.questionsById = {};
  });

  socket.on('getQuestion', (payload) => {
    const level = payload && payload.level ? payload.level : 'normal';
    const q = generateQuestion(level);
    
    if (!socket.data.questionStack) socket.data.questionStack = [];
    if (!socket.data.questionsById) socket.data.questionsById = {};
    
    socket.data.questionStack.push(q);
    socket.data.questionsById[q.id] = q;
    
    socket.emit('question', { id: q.id, text: q.text, level });
  });

  socket.on('checkAnswer', (payload) => {
    const { questionId, questionIndex, answer, level } = payload;
    const name = socket.data.name || 'Guest';
    
    let q = null;
    if (questionId && socket.data.questionsById) {
      q = socket.data.questionsById[questionId];
    }
    if (!q && socket.data.questionStack && questionIndex !== undefined) {
      q = socket.data.questionStack[questionIndex];
    }
    
    if (!q) {
      socket.emit('answerResult', {
        correct: false,
        correctAnswer: 'UNKNOWN'
      });
      return;
    }
    
    const userAnswer = parseFloat(answer);
    const correct = !isNaN(userAnswer) && userAnswer === q.answer;
    
    socket.emit('answerResult', {
      correct,
      correctAnswer: q.answer
    });
  });

  socket.on('saveGameResult', async (payload) => {
    const { level, correctCount, totalTime } = payload;
    const name = socket.data.name || 'Guest';
    
    try {
      await pool.query(
        'INSERT INTO game_results (name, level, correct_count, total_time) VALUES ($1, $2, $3, $4)',
        [name, level, correctCount, totalTime]
      );
      
      const leaderboard = await getLeaderboard(level);
      io.emit('leaderboard', leaderboard);
    } catch (err) {
      console.error('Error saving game result:', err);
    }
  });

  socket.on('getLeaderboard', async (payload) => {
    const level = payload && payload.level ? payload.level : 'normal';
    const leaderboard = await getLeaderboard(level);
    socket.emit('leaderboard', leaderboard);
  });

  // Legacy events
  socket.on('requestQuestion', () => {
    const q = generateQuestion('normal');
    socket.data.currentQuestion = q;
    socket.emit('question', { id: q.id, text: q.text });
  });

  socket.on('answer', async (payload) => {
    const { id, answer, time } = payload;
    const q = socket.data.currentQuestion;
    const name = socket.data.name || 'Guest';
    
    if (!q || q.id !== id) {
      socket.emit('result', { ok: false, message: 'Question mismatch' });
      return;
    }
    
    const correct = Number(answer) === q.answer;
    
    if (correct) {
      try {
        await pool.query(`
          INSERT INTO scores(name, score, total_time) VALUES($1, $2, $3)
          ON CONFLICT(name) DO UPDATE SET 
            score = scores.score + EXCLUDED.score,
            total_time = scores.total_time + EXCLUDED.total_time
        `, [name, 1, time || 0]);
      } catch (err) {
        console.error('Error updating score:', err);
      }
    }
    
    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await pool.query(
        'INSERT INTO matches(name, question, correct, time_ms, ts) VALUES($1, $2, $3, $4, $5) RETURNING *',
        [name, q.text, correct ? 1 : 0, time || 0, now]
      );
      
      io.emit('newMatch', result.rows[0]);
      const leaderboard = await getLeaderboard();
      io.emit('leaderboard', leaderboard);
    } catch (err) {
      console.error('Error saving match:', err);
    }
    
    socket.emit('result', { ok: correct, correctAnswer: q.answer });
  });
});

app.get('/api/matches', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM matches ORDER BY ts DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
