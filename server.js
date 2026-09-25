const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = Number(process.env.PORT || 3000);

const OWNER_KEY =
  process.env.MINDSPACE_OWNER_KEY || "mindspace123";

const ACCESS_TIME =
  24 * 60 * 60 * 1000;

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/", apiLimiter);


/* =========================
   DATABASE
========================= */

let pool = null;
let databaseReady = false;

if (process.env.DATABASE_URL) {

  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl: process.env.DATABASE_URL.includes("localhost")
      ? false
      : {
          rejectUnauthorized: false
        }
  });

  pool
    .query(`
      CREATE TABLE IF NOT EXISTS mindspace_messages (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS
      mindspace_messages_room_idx
      ON mindspace_messages(room_id, created_at);

      CREATE TABLE IF NOT EXISTS mindspace_feedback (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    .then(() => {

      databaseReady = true;

      console.log(
        "PostgreSQL connected."
      );

    })
    .catch(error => {

      console.error(
        "PostgreSQL setup failed:",
        error.message
      );

    });

} else {

  console.log(
    "DATABASE_URL is not set. Persistent database storage is disabled."
  );
}


/* =========================
   MEMORY DATA
========================= */

const waiting = new Map();

const rooms = new Map();

const visitorState = new Map();

const accessCodes = new Map();

const socketVisitors = new Map();

const owners = new Set();

const feedbackMemory = [];


/* =========================
   HELPERS
========================= */

function cleanText(value, max = 2000) {

  return String(value ?? "")
    .trim()
    .slice(0, max);
}


function validTopic(topic) {

  return [
    "Relationship",
    "Friends",
    "Love",
    "Family",
    "Studies",
    "Work",
    "Stress",
    "Other"
  ].includes(topic);
}


function createId(prefix = "") {

  return (
    prefix +
    crypto.randomBytes(10).toString("hex")
  );
}


function findRoom(visitorId) {

  for (const room of rooms.values()) {

    if (
      room.visitorId === visitorId
    ) {
      return room;
    }

  }

  return null;
}


function getActiveRoom(visitorId) {

  const room =
    findRoom(visitorId);

  if (!room) {
    return null;
  }

  const state =
    visitorState.get(visitorId);

  if (
    !state ||
    state.expiresAt <= Date.now()
  ) {
    return null;
  }

  return room;
}


/* =========================
   WAITING LIST
========================= */

function updateWaitingList() {

  const list =
    [...waiting.values()]
      .filter(
        customer =>
          customer.expiresAt >
          Date.now()
      )
      .map(customer => ({
        visitorId:
          customer.visitorId,

        socketId:
          customer.socketId,

        topic:
          customer.topic,

        waitingSince:
          customer.waitingSince
      }));

  for (const ownerSocket of owners) {

    io
      .to(ownerSocket)
      .emit(
        "waitingList",
        list
      );

  }
}


/* =========================
   ACTIVE ROOMS
========================= */

function updateActiveRooms() {

  const list =
    [...rooms.values()]
      .map(room => ({
        room:
          room.roomId,

        visitorId:
          room.visitorId,

        topic:
          room.topic,

        connected:
          Boolean(
            room.visitorSocketId
          ),

        startedAt:
          room.createdAt
      }));

  for (const ownerSocket of owners) {

    io
      .to(ownerSocket)
      .emit(
        "activeRooms",
        list
      );

  }
}


/* =========================
   HISTORY
========================= */

async function getHistory(roomId) {

  if (databaseReady) {

    const result =
      await pool.query(
        `
        SELECT
          sender,
          message,
          created_at
        FROM mindspace_messages
        WHERE room_id = $1
        ORDER BY created_at ASC
        LIMIT 500
        `,
        [roomId]
      );

    return result.rows.map(row => ({
      from:
        row.sender,

      text:
        row.message,

      createdAt:
        row.created_at
    }));
  }

  const room =
    rooms.get(roomId);

  if (!room) {
    return [];
  }

  return room.messages.slice(-500);
}


/* =========================
   SAVE MESSAGE
========================= */

async function saveMessage(
  roomId,
  sender,
  text
) {

  const message = {

    from:
      sender,

    text:
      text,

    createdAt:
      new Date().toISOString()

  };


  const room =
    rooms.get(roomId);

  if (room) {

    room.messages.push(
      message
    );

    if (
      room.messages.length >
      500
    ) {

      room.messages.shift();

    }

  }


  if (databaseReady) {

    await pool.query(
      `
      INSERT INTO
      mindspace_messages
      (room_id, sender, message)
      VALUES ($1, $2, $3)
      `,
      [
        roomId,
        sender,
        text
      ]
    );

  }


  return message;
}


/* =========================
   SEND MESSAGE TO ROOM
========================= */

function sendRoomMessage(
  room,
  message
) {

  if (
    room.visitorSocketId
  ) {

    io
      .to(room.visitorSocketId)
      .emit(
        "message",
        message
      );

  }


  if (
    room.ownerSocketId
  ) {

    io
      .to(room.ownerSocketId)
      .emit(
        "message",
        message
      );

  }

}


/* =========================
   API
========================= */

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service: "MindSpace",
      database:
        databaseReady
    });

  }
);


/* TOPIC */

app.post(
  "/api/topic",
  (req, res) => {

    const topic =
      cleanText(
        req.body.topic,
        50
      );

    if (!validTopic(topic)) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid topic."
        });

    }

    res.json({
      ok: true,
      topic
    });

  }
);

/* =========================
   TEST PAYMENT / UNLOCK
========================= */

app.post("/api/unlock", (req, res) => {

  const visitorId = cleanText(req.body.visitorId, 100);

  const topic = validTopic(req.body.topic)
    ? req.body.topic
    : "Other";

  if (!visitorId) {
    return res.status(400).json({
      ok: false,
      error: "Visitor ID is required."
    });
  }

  const accessCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  const expiresAt = Date.now() + ACCESS_TIME;

  visitorState.set(visitorId, {
    expiresAt,
    topic,
    roomId: null
  });

  accessCodes.set(accessCode, {
    visitorId,
    expiresAt,
    topic
  });

  res.json({
    ok: true,
    testPayment: true,
    alreadyActive: false,
    visitorId,
    accessCode,
    topic,
    expiresAt: new Date(expiresAt).toISOString()
  });

});

/* =========================
   ACCESS STATUS
========================= */

app.post(
  "/api/access-status",
  (req, res) => {

    const visitorId =
      cleanText(
        req.body.visitorId,
        100
      );

    const state =
      visitorState.get(
        visitorId
      );


    if (
      !state ||
      state.expiresAt <=
        Date.now()
    ) {

      return res.json({
        ok: true,
        active: false
      });

    }


    const room =
      getActiveRoom(
        visitorId
      );


    res.json({

      ok: true,

      active: true,

      topic:
        state.topic,

      expiresAt:
        new Date(
          state.expiresAt
        ).toISOString(),

      roomId:
        room
          ? room.roomId
          : null,

      paired:
        Boolean(
          room &&
          room.ownerSocketId
        )

    });

  }
);


/* =========================
   FEEDBACK
========================= */

app.post(
  "/api/feedback",
  async (req, res) => {

    const roomId =
      cleanText(
        req.body.roomId,
        100
      );

    const comment =
      cleanText(
        req.body.comment,
        1000
      );

    const rating =
      Number(
        req.body.rating
      );


    if (
      !roomId ||
      !Number.isInteger(
        rating
      ) ||
      rating < 1 ||
      rating > 5
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Rating must be between 1 and 5."
        });

    }


    if (databaseReady) {

      await pool.query(
        `
        INSERT INTO
        mindspace_feedback
        (room_id, rating, comment)
        VALUES ($1, $2, $3)
        `,
        [
          roomId,
          rating,
          comment || null
        ]
      );

    } else {

      feedbackMemory.push({

        roomId,

        rating,

        comment,

        createdAt:
          new Date().toISOString()

      });

    }


    res.json({
      ok: true
    });

  }
);


/* =========================
   SOCKET CONNECTION
========================= */

io.on(
  "connection",
  socket => {


    /* =====================
       CUSTOMER JOINS
    ===================== */

    socket.on(
      "visitorJoin",
      async data => {

        const visitorId =
          cleanText(
            data?.visitorId,
            100
          );

        const topic =
          cleanText(
            data?.topic,
            50
          );


        if (
          !visitorId ||
          !validTopic(topic)
        ) {

          socket.emit(
            "errorMessage",
            "Please select a valid topic."
          );

          return;
        }


        const state =
          visitorState.get(
            visitorId
          );


        if (
          !state ||
          state.expiresAt <=
            Date.now()
        ) {

          socket.emit(
            "accessExpired"
          );

          return;
        }


        socketVisitors.set(
          socket.id,
          visitorId
        );


        /* Existing room */

        const oldRoom =
          getActiveRoom(
            visitorId
          );


        if (oldRoom) {

          oldRoom.visitorSocketId =
            socket.id;

          socket.join(
            oldRoom.roomId
          );


          const history =
            await getHistory(
              oldRoom.roomId
            );


          socket.emit(
            "history",
            history
          );


          socket.emit(
            "paired",
            {
              room:
                oldRoom.roomId,

              topic:
                oldRoom.topic
            }
          );


          updateActiveRooms();

          return;
        }


        /* Waiting */

        const existing =
          waiting.get(
            visitorId
          );


        if (existing) {

          existing.socketId =
            socket.id;

          existing.topic =
            topic;

        } else {

          waiting.set(
            visitorId,
            {

              visitorId,

              socketId:
                socket.id,

              topic,

              waitingSince:
                new Date().toISOString(),

              expiresAt:
                state.expiresAt

            }
          );

        }


        state.topic =
          topic;


        socket.emit(
          "waiting",
          {

            topic,

            expiresAt:
              new Date(
                state.expiresAt
              ).toISOString()

          }
        );


        updateWaitingList();

      }
    );


    /* =====================
       OWNER LOGIN
    ===================== */

    socket.on(
      "ownerAuth",
      key => {

        if (
          String(key || "") !==
          OWNER_KEY
        ) {

          socket.emit(
            "ownerAuthResult",
            {
              ok: false,
              error:
                "Wrong listener access key."
            }
          );

          return;
        }


        owners.add(
          socket.id
        );


        socket.emit(
          "ownerAuthResult",
          {
            ok: true
          }
        );


        updateWaitingList();

        updateActiveRooms();

      }
    );


    /* =====================
       OWNER ACCEPTS CUSTOMER
    ===================== */

    socket.on(
      "ownerAccept",
      async data => {

        if (
          !owners.has(
            socket.id
          )
        ) {

          return;
        }


        const visitorId =
          cleanText(
            typeof data === "string"
              ? data
              : data?.visitorId,
            100
          );


        const customer =
          waiting.get(
            visitorId
          );


        if (!customer) {

          socket.emit(
            "errorMessage",
            "This customer is no longer waiting."
          );

          return;
        }


        const state =
          visitorState.get(
            visitorId
          );


        if (
          !state ||
          state.expiresAt <=
            Date.now()
        ) {

          waiting.delete(
            visitorId
          );

          updateWaitingList();

          socket.emit(
            "errorMessage",
            "Customer access has expired."
          );

          return;
        }


        const roomId =
          createId("room_");


        const room = {

          roomId,

          visitorId,

          visitorSocketId:
            customer.socketId,

          ownerSocketId:
            socket.id,

          topic:
            customer.topic,

          createdAt:
            new Date().toISOString(),

          messages: []

        };


        rooms.set(
          roomId,
          room
        );


        state.roomId =
          roomId;


        waiting.delete(
          visitorId
        );


        socket.join(
          roomId
        );


        if (
          customer.socketId
        ) {

          const customerSocket =
            io.sockets.sockets.get(
              customer.socketId
            );


          if (
            customerSocket
          ) {

            customerSocket.join(
              roomId
            );

          }

        }


        const history =
          await getHistory(
            roomId
          );


        socket.emit(
          "newChat",
          {

            room:
              roomId,

            visitorId,

            topic:
              room.topic

          }
        );


        socket.emit(
          "history",
          history
        );


        if (
          customer.socketId
        ) {

          io
            .to(
              customer.socketId
            )
            .emit(
              "paired",
              {

                room:
                  roomId,

                topic:
                  room.topic

              }
            );


          io
            .to(
              customer.socketId
            )
            .emit(
              "history",
              history
            );

        }


        updateWaitingList();

        updateActiveRooms();

      }
    );


    /* =====================
       OWNER REQUESTS HISTORY
    ===================== */

    socket.on(
      "requestHistory",
      async data => {

        if (
          !owners.has(
            socket.id
          )
        ) {

          return;
        }


        const roomId =
          cleanText(
            data?.room,
            100
          );


        const room =
          rooms.get(
            roomId
          );


        if (
          !room ||
          room.ownerSocketId !==
            socket.id
        ) {

          return;
        }


        const history =
          await getHistory(
            roomId
          );


        socket.emit(
          "history",
          history
        );

      }
    );


    /* =====================
       CUSTOMER MESSAGE
    ===================== */

    socket.on(
      "message",
      async data => {

        const visitorId =
          socketVisitors.get(
            socket.id
          );


        if (!visitorId) {

          socket.emit(
            "errorMessage",
            "You are not connected."
          );

          return;
        }


        const state =
          visitorState.get(
            visitorId
          );


        if (
          !state ||
          state.expiresAt <=
            Date.now()
        ) {

          socket.emit(
            "accessExpired"
          );

          return;
        }


        const room =
          getActiveRoom(
            visitorId
          );


        if (
          !room ||
          room.visitorSocketId !==
            socket.id
        ) {

          socket.emit(
            "errorMessage",
            "Please wait for the listener to accept your chat."
          );

          return;
        }


        const text =
          cleanText(
            typeof data === "string"
              ? data
              : data?.text
          );


        if (!text) {
          return;
        }


        const message =
          await saveMessage(
            room.roomId,
            "visitor",
            text
          );


        sendRoomMessage(
          room,
          message
        );

      }
    );


    /* =====================
       OWNER MESSAGE
    ===================== */

    socket.on(
      "ownerMessage",
      async data => {

        if (
          !owners.has(
            socket.id
          )
        ) {

          return;
        }


        const roomId =
          cleanText(
            data?.room,
            100
          );

        const text =
          cleanText(
            data?.text
          );


        if (
          !roomId ||
          !text
        ) {

          return;
        }


        const room =
          rooms.get(
            roomId
          );


        if (
          !room ||
          room.ownerSocketId !==
            socket.id
        ) {

          return;
        }


        const state =
          visitorState.get(
            room.visitorId
          );


        if (
          !state ||
          state.expiresAt <=
            Date.now()
        ) {

          socket.emit(
            "errorMessage",
            "Customer access has expired."
          );

          return;
        }


        const message =
          await saveMessage(
            room.roomId,
            "owner",
            text
          );


        sendRoomMessage(
          room,
          message
        );

      }
    );


    /* =====================
       END CHAT
    ===================== */

    socket.on(
      "ownerEndChat",
      data => {

        if (
          !owners.has(
            socket.id
          )
        ) {

          return;
        }


        const roomId =
          cleanText(
            data?.room,
            100
          );


        const room =
          rooms.get(
            roomId
          );


        if (
          !room ||
          room.ownerSocketId !==
            socket.id
        ) {

          return;
        }


        if (
          room.visitorSocketId
        ) {

          io
            .to(
              room.visitorSocketId
            )
            .emit(
              "ended",
              {
                room:
                  roomId
              }
            );

        }


        socket.emit(
          "ended",
          {
            room:
              roomId
          }
        );


        room.ownerSocketId =
          null;


        updateActiveRooms();

      }
    );


    /* =====================
       DISCONNECT
    ===================== */

    socket.on(
      "disconnect",
      () => {

        const visitorId =
          socketVisitors.get(
            socket.id
          );


        if (visitorId) {

          socketVisitors.delete(
            socket.id
          );


          const waitingCustomer =
            waiting.get(
              visitorId
            );


          if (
            waitingCustomer &&
            waitingCustomer.socketId ===
              socket.id
          ) {

            waitingCustomer.socketId =
              null;

            updateWaitingList();

          }


          const room =
            findRoom(
              visitorId
            );


          if (
            room &&
            room.visitorSocketId ===
              socket.id
          ) {

            room.visitorSocketId =
              null;


            if (
              room.ownerSocketId
            ) {

              io
                .to(
                  room.ownerSocketId
                )
                .emit(
                  "visitorDisconnected",
                  {
                    room:
                      room.roomId
                  }
                );

            }


            updateActiveRooms();

          }

        }


        if (
          owners.has(
            socket.id
          )
        ) {

          owners.delete(
            socket.id
          );


          for (
            const room
            of rooms.values()
          ) {

            if (
              room.ownerSocketId ===
                socket.id
            ) {

              room.ownerSocketId =
                null;


              if (
                room.visitorSocketId
              ) {

                io
                  .to(
                    room.visitorSocketId
                  )
                  .emit(
                    "listenerDisconnected",
                    {
                      room:
                        room.roomId
                    }
                  );

              }

            }

          }


          updateActiveRooms();

        }

      }
    );

  }
);


/* =========================
   CLEAN EXPIRED ACCESS
========================= */

setInterval(
  () => {

    const now =
      Date.now();


    for (
      const [
        visitorId,
        customer
      ]
      of waiting.entries()
    ) {

      if (
        customer.expiresAt <=
          now
      ) {

        waiting.delete(
          visitorId
        );


        if (
          customer.socketId
        ) {

          io
            .to(
              customer.socketId
            )
            .emit(
              "accessExpired"
            );

        }

      }

    }


    for (
      const [
        visitorId,
        state
      ]
      of visitorState.entries()
    ) {

      if (
        state.expiresAt <=
          now
      ) {

        const room =
          findRoom(
            visitorId
          );


        if (
          room &&
          room.visitorSocketId
        ) {

          io
            .to(
              room.visitorSocketId
            )
            .emit(
              "accessExpired"
            );

        }


        visitorState.delete(
          visitorId
        );

      }

    }


    updateWaitingList();

  },
  30000
);


/* =========================
   EXPRESS FALLBACK
========================= */

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );

  }
);


/* =========================
   START SERVER
========================= */

server.listen(
  PORT,
  () => {

    console.log(
      `MindSpace running on port ${PORT}`
    );

    console.log(
      `Listener access key: ${OWNER_KEY}`
    );

  }
);
