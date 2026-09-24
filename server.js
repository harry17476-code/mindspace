const path = require('path');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  connectionStateRecovery: {}
});

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_KEY = process.env.MINDSPACE_OWNER_KEY;

/*
  DEMO_PAYMENT=true means the ₹11 button does not actually
  charge money. It only activates 24-hour access for testing.

  Change this only after a real payment gateway has been
  integrated and payment is verified server-side.
*/
const DEMO_PAYMENT = process.env.DEMO_PAYMENT !== 'false';

const ACCESS_HOURS = 24;

if (!DATABASE_URL) {
  console.warn(
    'DATABASE_URL is not set. Persistent database storage is disabled.'
  );
}

if (!OWNER_KEY) {
  console.warn(
    'MINDSPACE_OWNER_KEY is not set. Listener dashboard will be unavailable.'
  );
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

const db = {

  async query(text, params = []) {

    if (!pool) {
      throw new Error('Database not configured');
    }

    return pool.query(text, params);
  },

  async init() {

    if (!pool) return;

    await pool.query(`

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS access_passes (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        visitor_id TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        payment_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE access_passes
        ALTER COLUMN user_id DROP NOT NULL;

      ALTER TABLE access_passes
        ADD COLUMN IF NOT EXISTS visitor_id TEXT;

      CREATE INDEX IF NOT EXISTS
        access_passes_visitor_idx
        ON access_passes(visitor_id, expires_at);

      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        user_id TEXT,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS
        messages_room_idx
        ON messages(room_id, id);

      CREATE TABLE IF NOT EXISTS reviews (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT,
        visitor_id TEXT,
        rating INTEGER NOT NULL
          CHECK (rating BETWEEN 1 AND 5),
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE reviews
        ADD COLUMN IF NOT EXISTS visitor_id TEXT;

    `);
  }
};

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(
  express.json({
    limit: '32kb'
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const sessionMiddleware = session({

  store: pool
    ? new pgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
      })
    : undefined,

  secret:
    process.env.SESSION_SECRET ||
    'change-this-session-secret-before-public-use',

  resave: false,

  saveUninitialized: true,

  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

function uid() {
  return crypto.randomUUID();
}

function ensureVisitor(req) {

  if (!req.session.visitorId) {
    req.session.visitorId = uid();
  }

  return req.session.visitorId;
}

async function getAccess(visitorId) {

  if (!pool || !visitorId) {
    return null;
  }

  const result = await db.query(
    `
    SELECT expires_at
    FROM access_passes
    WHERE visitor_id=$1
    ORDER BY expires_at DESC
    LIMIT 1
    `,
    [visitorId]
  );

  return result.rows[0]?.expires_at || null;
}

async function visitorHasAccess(visitorId) {

  const expires = await getAccess(visitorId);

  return Boolean(
    expires &&
    new Date(expires) > new Date()
  );
}


/* -----------------------------
   Visitor
------------------------------ */

app.get('/api/me', async (req, res) => {

  try {

    const visitorId = ensureVisitor(req);

    let expiresAt = null;

    if (pool) {
      expiresAt = await getAccess(visitorId);
    } else {
      expiresAt =
        req.session.accessExpiresAt || null;
    }

    const hasAccess =
      Boolean(
        expiresAt &&
        new Date(expiresAt) > new Date()
      );

    if (expiresAt) {
      req.session.accessExpiresAt = expiresAt;
    }

    res.json({

      visitorId,

      topic:
        req.session.topic || null,

      accessExpiresAt:
        expiresAt,

      hasAccess

    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: 'Could not load MindSpace.'
    });

  }

});


app.post('/api/topic', (req, res) => {

  const topics = [
    'Relationship',
    'Friends',
    'Love',
    'Family',
    'Studies',
    'Work',
    'Stress',
    'Other'
  ];

  const topic = String(
    req.body?.topic || ''
  ).trim();

  if (!topics.includes(topic)) {

    return res.status(400).json({
      error: 'Invalid topic.'
    });

  }

  ensureVisitor(req);

  req.session.topic = topic;

  res.json({
    ok: true,
    topic
  });

});


/* -----------------------------
   ₹11 / 24-hour access
------------------------------ */

app.post('/api/unlock', async (req, res) => {

  try {

    const visitorId = ensureVisitor(req);

    /*
      DEMO PAYMENT

      This does NOT charge ₹11.
      It simply activates 24 hours for testing.

      A real payment provider must be connected later.
    */

    if (!DEMO_PAYMENT) {

      return res.status(501).json({
        error:
          'Real payment mode is not configured yet.'
      });

    }

    const started = new Date();

    const expires = new Date(
      started.getTime() +
      ACCESS_HOURS * 60 * 60 * 1000
    );

    if (pool) {

      await db.query(
        `
        INSERT INTO access_passes
        (
          id,
          user_id,
          visitor_id,
          started_at,
          expires_at,
          payment_ref
        )
        VALUES($1,$2,$3,$4,$5,$6)
        `,
        [
          uid(),
          null,
          visitorId,
          started,
          expires,
          'DEMO-RS11'
        ]
      );

    }

    req.session.accessExpiresAt =
      expires.toISOString();

    await new Promise(resolve =>
      req.session.save(resolve)
    );

    res.json({

      ok: true,

      demo: true,

      expiresAt:
        expires.toISOString()

    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: 'Could not activate access.'
    });

  }

});


/* -----------------------------
   Reviews
------------------------------ */

app.get('/api/reviews', async (req, res) => {

  try {

    if (!pool) {
      return res.json([]);
    }

    const result = await db.query(
      `
      SELECT
        rating,
        text,
        created_at
      FROM reviews
      ORDER BY created_at DESC
      LIMIT 30
      `
    );

    res.json(result.rows);

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: 'Could not load reviews.'
    });

  }

});


app.post('/api/reviews', async (req, res) => {

  try {

    const visitorId =
      ensureVisitor(req);

    const rating =
      Number(req.body?.rating);

    const text =
      String(
        req.body?.text || ''
      ).trim();

    if (
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      text.length < 3 ||
      text.length > 500
    ) {

      return res.status(400).json({
        error:
          'Rating must be 1–5 and review 3–500 characters.'
      });

    }

    if (!pool) {

      return res.status(503).json({
        error:
          'Database is not connected yet.'
      });

    }

    await db.query(
      `
      INSERT INTO reviews
      (
        visitor_id,
        rating,
        text
      )
      VALUES($1,$2,$3)
      `,
      [
        visitorId,
        rating,
        text
      ]
    );

    res.json({
      ok: true
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: 'Could not save review.'
    });

  }

});


/* -----------------------------
   Listener dashboard
------------------------------ */

app.post('/api/owner/login', (req, res) => {

  if (
    !OWNER_KEY ||
    req.body?.key !== OWNER_KEY
  ) {

    return res.status(401).json({
      error: 'Access denied.'
    });

  }

  req.session.isOwner = true;

  res.json({
    ok: true
  });

});


app.post('/api/owner/logout', (req, res) => {

  req.session.isOwner = false;

  res.json({
    ok: true
  });

});


/* -----------------------------
   Socket.IO
------------------------------ */

io.use((socket, next) => {

  sessionMiddleware(
    socket.request,
    {},
    next
  );

});


const waiting = new Map();
const rooms = new Map();


async function loadHistory(roomId) {

  if (!pool) return [];

  const result = await db.query(
    `
    SELECT
      sender_role AS "from",
      body AS text,
      created_at AS "createdAt"
    FROM messages
    WHERE room_id=$1
    ORDER BY id ASC
    LIMIT 500
    `,
    [roomId]
  );

  return result.rows;
}


io.on('connection', socket => {


  /* Visitor asks to start chat */

  socket.on(
    'visitorJoin',
    async () => {

      const req =
        socket.request;

      const visitorId =
        req.session?.visitorId;

      if (!visitorId) {

        return socket.emit(
          'errorMessage',
          'Please refresh the page and try again.'
        );

      }

      let allowed = false;

      if (pool) {

        allowed =
          await visitorHasAccess(
            visitorId
          );

      } else {

        allowed =
          Boolean(
            req.session?.accessExpiresAt &&
            new Date(
              req.session.accessExpiresAt
            ) > new Date()
          );

      }

      if (!allowed) {

        return socket.emit(
          'errorMessage',
          'Your 24-hour access has expired. Please pay ₹11 again to continue.'
        );

      }

      let roomId = null;

      for (
        const [id, value]
        of waiting
      ) {

        if (value.socketId) {

          roomId = id;

          break;
        }

      }

      if (roomId) {

        const visitor =
          waiting.get(roomId);

        waiting.delete(roomId);

        const room =
          uid();

        rooms.set(
          room,
          {
            visitorSocket:
              visitor.socketId,

            ownerSocket:
              null,

            visitorId:
              visitor.visitorId
          }
        );

        socket.join(room);

        io.sockets
          .sockets
          .get(visitor.socketId)
          ?.join(room);

        socket.emit(
          'paired',
          { room }
        );

        io.to(
          visitor.socketId
        ).emit(
          'paired',
          { room }
        );

      } else {

        const id = uid();

        waiting.set(
          id,
          {
            socketId:
              socket.id,

            visitorId
          }
        );

        socket.emit('waiting');

        io.to('owners').emit(
          'waitingList',
          [...waiting.keys()]
        );

      }

    }
  );


  /* Listener login */

  socket.on(
    'ownerAuth',
    key => {

      if (
        !OWNER_KEY ||
        key !== OWNER_KEY
      ) {

        return socket.emit(
          'ownerAuthResult',
          { ok:false }
        );

      }

      socket.request.session.isOwner =
        true;

      socket.request.session.save(
        () => {}
      );

      socket.join('owners');

      socket.emit(
        'ownerAuthResult',
        { ok:true }
      );

      socket.emit(
        'waitingList',
        [...waiting.keys()]
      );

    }
  );


  /* Listener accepts visitor */

  socket.on(
    'ownerAccept',
    async id => {

      if (
        !socket.request.session?.isOwner
      ) return;

      const visitor =
        waiting.get(id);

      if (!visitor) return;

      waiting.delete(id);

      const room =
        uid();

      rooms.set(
        room,
        {
          visitorSocket:
            visitor.socketId,

          ownerSocket:
            socket.id,

          visitorId:
            visitor.visitorId
        }
      );

      socket.join(room);

      io.sockets
        .sockets
        .get(visitor.socketId)
        ?.join(room);

      socket.emit(
        'newChat',
        { room }
      );

      io.to(
        visitor.socketId
      ).emit(
        'paired',
        { room }
      );

      const history =
        await loadHistory(room);

      if (history.length) {

        socket.emit(
          'history',
          history
        );

      }

      io.to('owners').emit(
        'waitingList',
        [...waiting.keys()]
      );

    }
  );


  /* Messages */

  socket.on(
    'message',
    async text => {

      const room =
        [...socket.rooms]
          .find(
            r => rooms.has(r)
          );

      if (!room) return;

      const clean =
        String(text || '')
          .trim()
          .slice(0,2000);

      if (!clean) return;

      const data =
        rooms.get(room);

      const role =
        data.visitorSocket === socket.id
          ? 'visitor'
          : 'owner';

      const msg = {
        from: role,
        text: clean,
        createdAt:
          new Date().toISOString()
      };

      if (pool) {

        await db.query(
          `
          INSERT INTO messages
          (
            room_id,
            sender_role,
            user_id,
            body
          )
          VALUES($1,$2,$3,$4)
          `,
          [
            room,
            role,
            null,
            clean
          ]
        );

      }

      io.to(room).emit(
        'message',
        msg
      );

    }
  );


  /* Listener message */

  socket.on(
    'ownerMessage',
    async ({room,text}) => {

      if (
        !socket.request.session?.isOwner ||
        !rooms.has(room)
      ) return;

      const clean =
        String(text || '')
          .trim()
          .slice(0,2000);

      if (!clean) return;

      const msg = {
        from:'owner',
        text:clean,
        createdAt:
          new Date().toISOString()
      };

      if (pool) {

        await db.query(
          `
          INSERT INTO messages
          (
            room_id,
            sender_role,
            user_id,
            body
          )
          VALUES($1,$2,$3,$4)
          `,
          [
            room,
            'owner',
            null,
            clean
          ]
        );

      }

      io.to(room).emit(
        'message',
        msg
      );

    }
  );


  socket.on(
    'leave',
    () => {

      const room =
        [...socket.rooms]
          .find(
            r => rooms.has(r)
          );

      if (!room) return;

      io.to(room).emit(
        'ended'
      );

      rooms.delete(room);

    }
  );


  socket.on(
    'disconnect',
    () => {

      for (
        const [id,value]
        of waiting
      ) {

        if (
          value.socketId === socket.id
        ) {

          waiting.delete(id);

        }

      }

    }
  );

});


/* Express 5 wildcard route */

app.get(
  '/{*splat}',
  (req,res,next) => {

    if (
      req.path.startsWith('/api/')
    ) return next();

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );

  }
);


/* Start */

(async()=>{

  try {

    await db.init();

    server.listen(
      PORT,
      '0.0.0.0',
      () => {

        console.log(
          `MindSpace v3 running on port ${PORT}`
        );

      }
    );

  } catch(e) {

    console.error(
      'Startup error:',
      e
    );

    process.exit(1);

  }

})();
