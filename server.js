const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_KEY = process.env.MINDSPACE_OWNER_KEY;
const DEMO_PAYMENT = process.env.DEMO_PAYMENT !== 'false';
const ACCESS_HOURS = 24;

if (!DATABASE_URL) console.warn('DATABASE_URL is not set. Persistent storage is disabled until a PostgreSQL database is connected.');
if (!OWNER_KEY) console.warn('MINDSPACE_OWNER_KEY is not set. Owner dashboard login will be unavailable.');

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const db = {
  async query(text, params = []) { if (!pool) throw new Error('Database not configured'); return pool.query(text, params); },
  async init() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS access_passes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        payment_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        user_id TEXT,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS messages_room_idx ON messages(room_id, id);
      CREATE TABLE IF NOT EXISTS reviews (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const sessionMiddleware = session({
  store: pool ? new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET || 'change-this-session-secret-before-public-use',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

function uid() { return crypto.randomUUID(); }
function validUsername(v) { return typeof v === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(v); }
function validPassword(v) { return typeof v === 'string' && v.length >= 8 && v.length <= 100; }
function hasAccess(req) { return Boolean(req.session.userId && req.session.accessExpiresAt && new Date(req.session.accessExpiresAt) > new Date()); }

async function currentUser(req) {
  if (!req.session.userId || !pool) return null;
  const r = await db.query('SELECT id, username FROM users WHERE id=$1', [req.session.userId]);
  return r.rows[0] || null;
}

app.get('/api/config', (req, res) => res.json({ demoPayment: DEMO_PAYMENT, accessHours: ACCESS_HOURS }));

app.post('/api/signup', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
    const { username, password } = req.body || {};
    if (!validUsername(username) || !validPassword(password)) return res.status(400).json({ error: 'Use a username (3–24 letters/numbers/_) and password (8+ characters).' });
    const hash = await bcrypt.hash(password, 12);
    const id = uid();
    await db.query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3)', [id, username, hash]);
    req.session.userId = id;
    res.json({ ok: true, username });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists.' });
    console.error(e); res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
    const { username, password } = req.body || {};
    const r = await db.query('SELECT id, username, password_hash FROM users WHERE username=$1', [username]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Invalid username or password.' });
    req.session.userId = user.id;
    res.json({ ok: true, username: user.username });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Login failed.' }); }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.json({ loggedIn: false });
    const pass = await db.query('SELECT expires_at FROM access_passes WHERE user_id=$1 ORDER BY expires_at DESC LIMIT 1', [user.id]);
    const expiresAt = pass.rows[0]?.expires_at || null;
    req.session.accessExpiresAt = expiresAt;
    res.json({ loggedIn: true, username: user.username, accessExpiresAt: expiresAt, hasAccess: expiresAt ? new Date(expiresAt) > new Date() : false });
  } catch (e) { res.status(500).json({ error: 'Could not load account.' }); }
});

app.post('/api/unlock', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
    if (!req.session.userId) return res.status(401).json({ error: 'Log in first.' });
    // DEMO ONLY: this does not charge money. A real payment provider must verify payment server-side.
    if (!DEMO_PAYMENT) return res.status(501).json({ error: 'Real payment mode is not configured.' });
    const started = new Date();
    const expires = new Date(started.getTime() + ACCESS_HOURS * 60 * 60 * 1000);
    await db.query('INSERT INTO access_passes(id,user_id,started_at,expires_at,payment_ref) VALUES($1,$2,$3,$4,$5)', [uid(), req.session.userId, started, expires, 'DEMO-RS11']);
    req.session.accessExpiresAt = expires.toISOString();
    res.json({ ok: true, demo: true, expiresAt: expires.toISOString() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not unlock access.' }); }
});

app.get('/api/reviews', async (req, res) => {
  try {
    if (!pool) return res.json([]);
    const r = await db.query('SELECT rating, text, created_at FROM reviews ORDER BY created_at DESC LIMIT 30');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Could not load reviews.' }); }
});

app.post('/api/reviews', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database is not configured yet.' });
    if (!req.session.userId) return res.status(401).json({ error: 'Log in first.' });
    const rating = Number(req.body?.rating); const text = String(req.body?.text || '').trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || text.length < 3 || text.length > 500) return res.status(400).json({ error: 'Rating must be 1–5 and review 3–500 characters.' });
    await db.query('INSERT INTO reviews(user_id,rating,text) VALUES($1,$2,$3)', [req.session.userId, rating, text]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save review.' }); }
});

// Owner dashboard API. Keep owner key server-side only.
app.post('/api/owner/login', (req, res) => {
  if (!OWNER_KEY || req.body?.key !== OWNER_KEY) return res.status(401).json({ error: 'Access denied.' });
  req.session.isOwner = true; res.json({ ok: true });
});
app.post('/api/owner/logout', (req, res) => { req.session.isOwner = false; res.json({ ok: true }); });
app.get('/api/owner/stats', async (req, res) => {
  if (!req.session.isOwner) return res.status(401).json({ error: 'Access denied.' });
  if (!pool) return res.json({ users: 0, passes: 0, reviews: 0 });
  const [u,p,r] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS n FROM users'), db.query('SELECT COUNT(*)::int AS n FROM access_passes'), db.query('SELECT COUNT(*)::int AS n FROM reviews')
  ]);
  res.json({ users:u.rows[0].n, passes:p.rows[0].n, reviews:r.rows[0].n });
});

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
const waiting = new Map();
const rooms = new Map();

async function loadHistory(roomId) {
  if (!pool) return [];
  const r = await db.query('SELECT sender_role AS "from", body AS text, created_at AS "createdAt" FROM messages WHERE room_id=$1 ORDER BY id ASC LIMIT 500', [roomId]);
  return r.rows;
}

io.on('connection', socket => {
  socket.on('visitorJoin', async () => {
    const req = socket.request;
    if (!req.session?.userId || !req.session?.accessExpiresAt || new Date(req.session.accessExpiresAt) <= new Date()) return socket.emit('errorMessage', 'Please log in and unlock 24-hour access first.');
    let roomId = null;
    for (const [id, v] of waiting) { if (!v.socketId) continue; roomId = id; break; }
    if (roomId) {
      const v = waiting.get(roomId); waiting.delete(roomId);
      const room = uid(); rooms.set(room, { visitorSocket:v.socketId, ownerSocket:null, visitorUserId:v.userId });
      socket.join(room); io.sockets.sockets.get(v.socketId)?.join(room);
      socket.emit('paired', { room }); io.to(v.socketId).emit('paired', { room });
    } else {
      const id = uid(); waiting.set(id, { socketId:socket.id, userId:req.session.userId });
      socket.emit('waiting');
      io.to('owners').emit('waitingList', [...waiting.keys()]);
    }
  });
  socket.on('ownerAuth', key => {
    if (!OWNER_KEY || key !== OWNER_KEY) return socket.emit('ownerAuthResult', { ok:false });
    socket.request.session.isOwner = true; socket.request.session.save(() => {}); socket.join('owners'); socket.emit('ownerAuthResult',{ok:true});
    socket.emit('waitingList', [...waiting.keys()]);
  });
  socket.on('ownerAccept', async id => {
    if (!socket.request.session?.isOwner) return;
    const v = waiting.get(id); if (!v) return;
    waiting.delete(id); const room = uid(); rooms.set(room,{visitorSocket:v.socketId,ownerSocket:socket.id,visitorUserId:v.userId});
    socket.join(room); io.sockets.sockets.get(v.socketId)?.join(room);
    socket.emit('newChat',{room}); io.to(v.socketId).emit('paired',{room});
    const history = await loadHistory(room); if (history.length) socket.emit('history', history);
    io.to('owners').emit('waitingList',[...waiting.keys()]);
  });
  socket.on('message', async text => {
    const room = [...socket.rooms].find(r => rooms.has(r)); if (!room) return;
    const clean = String(text || '').trim().slice(0,2000); if (!clean) return;
    const role = rooms.get(room).visitorSocket === socket.id ? 'visitor' : 'owner';
    const msg = { from:role, text:clean, createdAt:new Date().toISOString() };
    if (pool) await db.query('INSERT INTO messages(room_id,sender_role,user_id,body) VALUES($1,$2,$3,$4)',[room,role, socket.request.session?.userId || null,clean]);
    io.to(room).emit('message',msg);
  });
  socket.on('ownerMessage', async ({room,text}) => {
    if (!socket.request.session?.isOwner || !rooms.has(room)) return;
    const clean=String(text||'').trim().slice(0,2000); if(!clean)return;
    const msg={from:'owner',text:clean,createdAt:new Date().toISOString()};
    if(pool) await db.query('INSERT INTO messages(room_id,sender_role,user_id,body) VALUES($1,$2,$3,$4)',[room,'owner',null,clean]);
    io.to(room).emit('message',msg);
  });
  socket.on('leave',()=>{ const room=[...socket.rooms].find(r=>rooms.has(r)); if(room){io.to(room).emit('ended'); rooms.delete(room);} });
  socket.on('disconnect',()=>{ for(const [id,v] of waiting){if(v.socketId===socket.id)waiting.delete(id);} });
});

app.get('*', (req,res,next)=> { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(__dirname,'public','index.html')); });

(async()=>{ try { await db.init(); server.listen(PORT,'0.0.0.0',()=>console.log(`MindSpace v2 running on port ${PORT}`)); } catch(e){ console.error('Startup error',e); process.exit(1); } })();
