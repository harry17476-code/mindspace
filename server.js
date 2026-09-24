const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const OWNER_KEY = process.env.MINDSPACE_OWNER_KEY || "";

const DATABASE_URL = process.env.DATABASE_URL || "";
const hasDatabase = Boolean(DATABASE_URL);

/* DATABASE */

let pool = null;

if (hasDatabase) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  pool.on("error", err => {
    console.error("PostgreSQL error:", err.message);
  });
}

/* MEMORY FALLBACK */

const memoryVisitors = new Map();
const memoryMessages = new Map();

/* MIDDLEWARE */

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

const sessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
};

if (pool) {
  const PgSession = require("connect-pg-simple")(session);

  sessionOptions.store = new PgSession({
    pool,
    createTableIfMissing: true
  });
}

app.use(session(sessionOptions));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/", apiLimiter);

app.use(express.static(path.join(__dirname, "public")));

/* DATABASE SETUP */

async function setupDatabase() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      visitor_id TEXT PRIMARY KEY,
      topic TEXT,
      access_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("PostgreSQL database ready.");
}

/* HELPERS */

function createId(prefix = "") {
  return (
    prefix +
    crypto.randomBytes(12).toString("hex")
  );
}

function ensureVisitor(req) {
  if (!req.session.visitorId) {
    req.session.visitorId = createId("visitor_");
  }

  return req.session.visitorId;
}

async function getVisitor(visitorId) {
  if (pool) {
    const result = await pool.query(
      `SELECT * FROM visitors WHERE visitor_id = $1`,
      [visitorId]
    );

    return result.rows[0] || null;
  }

  return memoryVisitors.get(visitorId) || null;
}

async function saveVisitor(visitorId, data) {
  if (pool) {
    await pool.query(
      `
      INSERT INTO visitors
        (visitor_id, topic, access_expires)
      VALUES
        ($1, $2, $3)
      ON CONFLICT (visitor_id)
      DO UPDATE SET
        topic = EXCLUDED.topic,
        access_expires = EXCLUDED.access_expires
      `,
      [
        visitorId,
        data.topic || null,
        data.accessExpires || null
      ]
    );

    return;
  }

  memoryVisitors.set(visitorId, {
    visitorId,
    topic: data.topic || null,
    accessExpires: data.accessExpires || null
  });
}

async function saveMessage(roomId, visitorId, sender, message) {
  if (pool) {
    await pool.query(
      `
      INSERT INTO messages
        (room_id, visitor_id, sender, message)
      VALUES
        ($1, $2, $3, $4)
      `,
      [roomId, visitorId, sender, message]
    );

    return;
  }

  if (!memoryMessages.has(roomId)) {
    memoryMessages.set(roomId, []);
  }

  memoryMessages.get(roomId).push({
    from: sender,
    text: message,
    createdAt: new Date().toISOString()
  });
}

async function getMessages(roomId) {
  if (pool) {
    const result = await pool.query(
      `
      SELECT sender, message, created_at
      FROM messages
      WHERE room_id = $1
      ORDER BY id ASC
      `,
      [roomId]
    );

    return result.rows.map(row => ({
      from: row.sender,
      text: row.message,
      createdAt: row.created_at
    }));
  }

  return memoryMessages.get(roomId) || [];
}

function hasValidAccess(visitor) {
  if (!visitor || !visitor.accessExpires) {
    return false;
  }

  return new Date(visitor.accessExpires).getTime() > Date.now();
}

/* API */

app.get("/api/me", async (req, res) => {
  try {
    const visitorId = ensureVisitor(req);
    const visitor = await getVisitor(visitorId);

    if (!visitor) {
      return res.json({
        visitorId,
        access: false
      });
    }

    res.json({
      visitorId,
      access: hasValidAccess(visitor),
      topic: visitor.topic || null,
      expiresAt: visitor.accessExpires || null
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Server error"
    });
  }
});

/* TOPIC */

app.post("/api/topic", async (req, res) => {
  try {
    const visitorId = ensureVisitor(req);
    const topic = String(req.body.topic || "").trim();

    if (!topic || topic.length > 100) {
      return res.status(400).json({
        error: "Invalid topic."
      });
    }

    await saveVisitor(visitorId, {
      topic
    });

    req.session.topic = topic;

    res.json({
      ok: true,
      topic
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not save topic."
    });
  }
});

/* DEMO PAYMENT / UNLOCK */

app.post("/api/unlock", async (req, res) => {
  try {
    const visitorId = ensureVisitor(req);

    const existing = await getVisitor(visitorId);

    const topic =
      existing?.topic ||
      req.session.topic ||
      null;

    /*
      TESTING MODE

      This does NOT charge real money.

      Later we will connect a real payment gateway.
    */

    const expiresAt = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    );

    await saveVisitor(visitorId, {
      topic,
      accessExpires: expiresAt.toISOString()
    });

    res.json({
      ok: true,
      visitorId,
      expiresAt: expiresAt.toISOString(),
      testing: true
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Could not unlock chat."
    });
  }
});

/* HEALTH */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MindSpace",
    database: hasDatabase
  });
});

/* SOCKET STATE */

/*
  IMPORTANT:

  waiting = customers waiting for the listener.

  rooms = private visitor <-> listener conversations.

  A visitor is NEVER paired with another visitor.
*/

const waiting = new Map();

/*
  roomId -> {
    visitorSocketId,
    visitorId,
    ownerSocketId
  }
*/

const rooms = new Map();

/*
  socketId -> roomId
*/

const socketRooms = new Map();

/*
  Connected listener sockets.
*/

const owners = new Set();

/* WAITING LIST */

function waitingList() {
  return Array.from(waiting.values()).map(item => ({
    visitorId: item.visitorId,
    topic: item.topic,
    waitingSince: item.waitingSince
  }));
}

function broadcastWaitingList() {
  const list = waitingList();

  for (const ownerSocketId of owners) {
    const ownerSocket = io.sockets.sockets.get(ownerSocketId);

    if (ownerSocket) {
      ownerSocket.emit("waitingList", list);
    }
  }
}

/* SOCKET.IO */

io.on("connection", socket => {
  console.log("Socket connected:", socket.id);

  /*
    VISITOR JOIN

    IMPORTANT:
    We DO NOT search for another visitor here.

    The visitor simply enters the waiting list.
  */

  socket.on("visitorJoin", async () => {
    try {
      const visitorId = socket.request.session?.visitorId;

      if (!visitorId) {
        socket.emit(
          "errorMessage",
          "Visitor session not found. Please refresh the page."
        );

        return;
      }

      const visitor = await getVisitor(visitorId);

      if (!hasValidAccess(visitor)) {
        socket.emit(
          "errorMessage",
          "Your 24-hour access has expired."
        );

        return;
      }

      const topic =
        visitor.topic ||
        socket.request.session?.topic ||
        "Other";

      /*
        Remove an old waiting entry belonging to
        the same visitor.
      */

      for (const [id, item] of waiting.entries()) {
        if (item.visitorId === visitorId) {
          waiting.delete(id);
        }
      }

      waiting.set(socket.id, {
        socketId: socket.id,
        visitorId,
        topic,
        waitingSince: new Date().toISOString()
      });

      socket.data.role = "visitor";
      socket.data.visitorId = visitorId;

      socket.emit("waiting");

      broadcastWaitingList();

      console.log(
        `Visitor ${visitorId} is waiting for listener.`
      );
    } catch (err) {
      console.error("visitorJoin error:", err);

      socket.emit(
        "errorMessage",
        "Could not start chat."
      );
    }
  });

  /* OWNER LOGIN */

  socket.on("ownerAuth", key => {
    if (!OWNER_KEY) {
      socket.emit("ownerAuthResult", {
        ok: false,
        error: "Listener access is not configured."
      });

      return;
    }

    if (String(key) !== String(OWNER_KEY)) {
      socket.emit("ownerAuthResult", {
        ok: false
      });

      return;
    }

    socket.data.role = "owner";

    owners.add(socket.id);

    socket.emit("ownerAuthResult", {
      ok: true
    });

    socket.emit("waitingList", waitingList());

    console.log("Listener connected:", socket.id);
  });

  /* OWNER ACCEPTS SPECIFIC CUSTOMER */

  socket.on("ownerAccept", async visitorSocketId => {
    try {
      if (socket.data.role !== "owner") {
        return;
      }

      const waitingCustomer =
        waiting.get(visitorSocketId);

      if (!waitingCustomer) {
        socket.emit(
          "errorMessage",
          "That customer is no longer waiting."
        );

        broadcastWaitingList();

        return;
      }

      const visitorSocket =
        io.sockets.sockets.get(visitorSocketId);

      if (!visitorSocket) {
        waiting.delete(visitorSocketId);

        broadcastWaitingList();

        return;
      }

      const visitorId =
        waitingCustomer.visitorId;

      const visitor =
        await getVisitor(visitorId);

      if (!hasValidAccess(visitor)) {
        waiting.delete(visitorSocketId);

        visitorSocket.emit(
          "errorMessage",
          "Your 24-hour access has expired."
        );

        broadcastWaitingList();

        return;
      }

      /*
        CREATE A UNIQUE PRIVATE ROOM.

        Only this visitor socket and this listener socket
        are allowed inside this room.
      */

      const roomId = createId("room_");

      rooms.set(roomId, {
        visitorSocketId,
        visitorId,
        ownerSocketId: socket.id
      });

      socketRooms.set(
        visitorSocketId,
        roomId
      );

      /*
        Owner can handle multiple rooms.
      */

      socket.join(roomId);
      visitorSocket.join(roomId);

      waiting.delete(visitorSocketId);

      socket.emit("newChat", {
        room: roomId,
        visitorId,
        topic: waitingCustomer.topic
      });

      visitorSocket.emit("paired", {
        room: roomId,
        topic: waitingCustomer.topic
      });

      /*
        Send previous messages for this room.
      */

      const history =
        await getMessages(roomId);

      if (history.length) {
        visitorSocket.emit(
          "history",
          history
        );

        socket.emit(
          "history",
          history
        );
      }

      broadcastWaitingList();

      console.log(
        `Private room created: ${roomId}`
      );
    } catch (err) {
      console.error("ownerAccept error:", err);

      socket.emit(
        "errorMessage",
        "Could not accept this customer."
      );
    }
  });

  /* VISITOR MESSAGE */

  socket.on("message", async text => {
    try {
      if (socket.data.role !== "visitor") {
        return;
      }

      const cleanText =
        String(text || "").trim();

      if (!cleanText) return;

      if (cleanText.length > 2000) {
        socket.emit(
          "errorMessage",
          "Message is too long."
        );

        return;
      }

      const roomId =
        socketRooms.get(socket.id);

      if (!roomId) {
        socket.emit(
          "errorMessage",
          "Please wait for the listener to join."
        );

        return;
      }

      const room = rooms.get(roomId);

      if (!room) {
        return;
      }

      /*
        SECURITY CHECK:
        This visitor can only send inside their own room.
      */

      if (
        room.visitorSocketId !== socket.id
      ) {
        return;
      }

      await saveMessage(
        roomId,
        room.visitorId,
        "visitor",
        cleanText
      );

      io.to(roomId).emit("message", {
        from: "visitor",
        text: cleanText
      });
    } catch (err) {
      console.error("visitor message error:", err);
    }
  });

  /* OWNER MESSAGE */

  socket.on("ownerMessage", async data => {
    try {
      if (socket.data.role !== "owner") {
        return;
      }

      const roomId =
        String(data?.room || "");

      const cleanText =
        String(data?.text || "").trim();

      if (!roomId || !cleanText) {
        return;
      }

      if (cleanText.length > 2000) {
        socket.emit(
          "errorMessage",
          "Message is too long."
        );

        return;
      }

      const room =
        rooms.get(roomId);

      if (!room) {
        return;
      }

      /*
        SECURITY CHECK:
        Only the listener who owns this room can send.
      */

      if (
        room.ownerSocketId !== socket.id
      ) {
        return;
      }

      await saveMessage(
        roomId,
        room.visitorId,
        "owner",
        cleanText
      );

      io.to(roomId).emit("message", {
        from: "owner",
        text: cleanText
      });
    } catch (err) {
      console.error("owner message error:", err);
    }
  });

  /* DISCONNECT */

  socket.on("disconnect", () => {
    console.log(
      "Socket disconnected:",
      socket.id
    );

    /*
      If visitor was still waiting,
      remove them from waiting list.
    */

    if (waiting.has(socket.id)) {
      waiting.delete(socket.id);

      broadcastWaitingList();
    }

    /*
      If owner disconnects, notify customers
      whose rooms were connected to this owner.
    */

    if (owners.has(socket.id)) {
      owners.delete(socket.id);

      for (const [roomId, room] of rooms.entries()) {
        if (room.ownerSocketId === socket.id) {
          const visitorSocket =
            io.sockets.sockets.get(
              room.visitorSocketId
            );

          if (visitorSocket) {
            visitorSocket.emit(
              "ended",
              "The listener has disconnected."
            );
          }

          socketRooms.delete(
            room.visitorSocketId
          );

          rooms.delete(roomId);
        }
      }
    }

    /*
      If visitor disconnects,
      remove their room connection.
    */

    const roomId =
      socketRooms.get(socket.id);

    if (roomId) {
      const room =
        rooms.get(roomId);

      if (room) {
        const otherSocketId =
          room.ownerSocketId === socket.id
            ? room.visitorSocketId
            : room.ownerSocketId;

        const otherSocket =
          io.sockets.sockets.get(
            otherSocketId
          );

        if (otherSocket) {
          otherSocket.emit(
            "ended",
            "The customer has disconnected."
          );
        }

        rooms.delete(roomId);
      }

      socketRooms.delete(socket.id);
    }
  });
});

/*
  IMPORTANT:
  Express session is needed by Socket.IO.

  This middleware makes the same visitor session
  available to socket connections.
*/

io.engine.use(session(sessionOptions));

/* FALLBACK */

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* START */

async function start() {
  try {
    await setupDatabase();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `MindSpace v4 running on port ${PORT}`
      );

      if (!hasDatabase) {
        console.log(
          "DATABASE_URL is not set. Using temporary memory storage."
        );
      }

      if (!OWNER_KEY) {
        console.log(
          "MINDSPACE_OWNER_KEY is not set. Listener dashboard is disabled."
        );
      }
    });
  } catch (err) {
    console.error(
      "Startup error:",
      err
    );

    process.exit(1);
  }
}

start();
