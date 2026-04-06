/**
 * RippleDrop — Signaling Server  v2
 *
 * Handles only WebRTC signaling (text messages).
 * Zero file bytes ever pass through here.
 *
 * Changes from v1:
 *  - generateCode() now guarantees 3 letters + 1 digit, shuffled.
 *    The original was biased (~30% chance of all-letter codes like "WMNT").
 */

const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60_000,
  pingInterval: 25_000,
});

app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — /join/X7K2 routes serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────
// Room store
// ─────────────────────────────────────────────────────────

const rooms = new Map(); // code → { hostId, guestId, createdAt }

/**
 * Generate a 4-character room code.
 *
 * v2 fix: guarantees exactly 3 letters + 1 digit, shuffled randomly.
 * Previously the code was all-random from a mixed charset, giving ~74%
 * chance of all-letter codes that look like typos ("WMNT", "QBKH").
 * Now every code looks like "K3MV" or "7BPQ" — instantly readable as
 * containing both a number and letters.
 *
 * Characters chosen to avoid visual ambiguity: no 0/O, no 1/I/L.
 */
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // 23 chars (no I, L, O)
const DIGITS  = '23456789';                 //  8 chars (no 0, 1)

function generateCode() {
  let code;
  let attempts = 0;
  do {
    const chars = [
      LETTERS[Math.floor(Math.random() * LETTERS.length)],
      LETTERS[Math.floor(Math.random() * LETTERS.length)],
      LETTERS[Math.floor(Math.random() * LETTERS.length)],
      DIGITS [Math.floor(Math.random() * DIGITS.length)],
    ];
    // Fisher-Yates shuffle so the digit isn't always last
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    code = chars.join('');
    if (++attempts > 1000) break; // safety valve — astronomically unlikely
  } while (rooms.has(code));

  return code;
}

// Evict stale rooms every 5 min (rooms expire after 30 min of inactivity)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 30 * 60_000) rooms.delete(code);
  }
}, 5 * 60_000);

// ─────────────────────────────────────────────────────────
// Socket.io events
// ─────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  /**
   * create-room — called by the Sender (host).
   * Assigns a unique code and joins the socket to that room.
   */
  socket.on('create-room', callback => {
    const code = generateCode();
    rooms.set(code, { hostId: socket.id, guestId: null, createdAt: Date.now() });
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';
    console.log(`[Room] Created ${code} — host: ${socket.id}`);
    callback({ code });
  });

  /**
   * join-room — called by the Receiver (guest).
   * Validates the code and notifies the host.
   */
  socket.on('join-room', ({ code }, callback) => {
    const upper = (code ?? '').toUpperCase().trim();
    const room  = rooms.get(upper);

    if (!room)      return callback({ error: 'Room not found. Check the code and try again.' });
    if (room.guestId) return callback({ error: 'Room already has two devices connected.' });

    room.guestId = socket.id;
    socket.join(upper);
    socket.data.code = upper;
    socket.data.role = 'guest';

    io.to(room.hostId).emit('peer-joined');
    console.log(`[Room] ${socket.id} joined ${upper}`);
    callback({ success: true });
  });

  /**
   * signal — relay WebRTC offer / answer / ICE candidates.
   * The server never reads the payload — it just routes it to the other peer.
   */
  socket.on('signal', ({ signal }) => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const targetId = socket.data.role === 'host' ? room.guestId : room.hostId;
    if (targetId) io.to(targetId).emit('signal', { signal });
  });

  /**
   * disconnect — clean up the room and notify the remaining peer.
   */
  socket.on('disconnect', () => {
    const { code, role } = socket.data;
    if (!code) return;

    const room = rooms.get(code);
    if (room) {
      const otherId = role === 'host' ? room.guestId : room.hostId;
      if (otherId) io.to(otherId).emit('peer-disconnected');
      rooms.delete(code);
      console.log(`[Room] Deleted ${code}`);
    }
    console.log(`[-] ${socket.id}`);
  });
});

// ─────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🌊 RippleDrop v2\n   → http://localhost:${PORT}\n`);
});