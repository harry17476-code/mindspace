const express = require("express");
const http = require("http");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024,
  cors: { origin: false }
});

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(require("path").join(__dirname, "public")));

const OWNER_KEY = process.env.MINDSPACE_OWNER_KEY;
if (!OWNER_KEY) console.warn("Set MINDSPACE_OWNER_KEY before public deployment.");

const waiting = [];
const rooms = new Map();

function token(){ return crypto.randomBytes(16).toString("hex"); }

io.on("connection", socket => {
  socket.on("visitorJoin", () => {
    if (socket.data.room) return;
    socket.data.role = "visitor";
    waiting.push(socket);
    socket.emit("waiting");
    tryPair();
  });

  socket.on("ownerAuth", key => {
    if (!OWNER_KEY || typeof key !== "string" ||
      Buffer.byteLength(key) !== Buffer.byteLength(OWNER_KEY) ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(OWNER_KEY))) {
      socket.emit("ownerAuthResult", { ok:false });
      return;
    }
    socket.data.role = "owner";
    socket.data.owner = true;
    socket.emit("ownerAuthResult", { ok:true });
    sendWaiting();
  });

  socket.on("ownerAccept", visitorId => {
    if (!socket.data.owner) return;
    const visitor = waiting.find(s => s.id === visitorId && s.connected && !s.data.room);
    if (!visitor) return;
    const room = token();
    visitor.data.room = room;
    socket.data.rooms = socket.data.rooms || new Set();
    socket.data.rooms.add(room);
    visitor.join(room);
    socket.join(room);
    const idx = waiting.indexOf(visitor);
    if (idx >= 0) waiting.splice(idx,1);
    visitor.emit("paired", { room });
    socket.emit("newChat", { room, visitorId });
    sendWaiting();
  });

  socket.on("message", text => {
    if (typeof text !== "string") return;
    const clean = text.trim().slice(0, 2000);
    const room = socket.data.room;
    if (!clean || !room) return;
    // Only sockets joined to THIS room receive this message.
    io.to(room).emit("message", {
      from: socket.data.owner ? "owner" : "visitor",
      text: clean,
      time: new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})
    });
  });

  socket.on("ownerMessage", ({room, text}) => {
    if (!socket.data.owner || !socket.data.rooms?.has(room) || typeof text !== "string") return;
    const clean = text.trim().slice(0, 2000);
    if (!clean) return;
    io.to(room).emit("message", {
      from:"owner", text:clean,
      time:new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})
    });
  });

  socket.on("leave", () => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit("ended");
      socket.leave(room);
      socket.data.room = null;
    }
  });

  socket.on("disconnect", () => {
    const i = waiting.indexOf(socket);
    if (i >= 0) waiting.splice(i,1);
    if (socket.data.rooms) {
      for (const room of socket.data.rooms) {
        socket.to(room).emit("ended");
      }
    }
    if (socket.data.room) socket.to(socket.data.room).emit("ended");
    sendWaiting();
  });
});

function tryPair(){ sendWaiting(); }
function sendWaiting(){
  io.sockets.sockets.forEach(s => {
    if (s.data.owner) {
      s.emit("waitingList", waiting.filter(v => v.connected && !v.data.room).map(v => ({id:v.id})));
    }
  });
}

server.listen(process.env.PORT || 3000, () =>
  console.log("MindSpace secure prototype running on http://localhost:" + (process.env.PORT || 3000))
);
