import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = +(process.env.PORT || 3101);

// Single-page app: every GET serves the scene, so it works mounted at any
// base path (e.g. behind `tailscale serve` at /brownstone). The vendored
// three.js files are the only other routes, matched by path suffix so they
// resolve under any mount point too.
const VENDOR = new Map([
  ['/vendor/three.module.min.js', readFileSync(join(here, 'vendor/three.module.min.js'))],
  ['/vendor/addons/controls/OrbitControls.js', readFileSync(join(here, 'vendor/addons/controls/OrbitControls.js'))],
]);
const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const path = (req.url || '').split('?')[0];
  for (const [suffix, body] of VENDOR) {
    if (path.endsWith(suffix)) {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
  }
  const page = readFileSync(join(here, 'brownstone.html'));
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : page);
});

/* ============================================================
   Minimal WebSocket server (RFC 6455), zero dependencies.
   Small JSON text frames only — ample for a 5-player game.
   ============================================================ */
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(data, op = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

const sockets = new Set(); // all live conns (players + spectators)
const MAX_CONNS = +(process.env.MAX_CONNS || 400);   // audience headroom, runaway guard

server.on('upgrade', (req, socket) => {
  if (sockets.size >= MAX_CONNS) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const conn = {
    socket,
    player: null,
    closed: false,
    send(obj) { if (!socket.destroyed) socket.write(frame(JSON.stringify(obj))); },
  };
  sockets.add(conn);

  let buf = Buffer.alloc(0);
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 65536) { dropConn(conn); socket.destroy(); return; }   // flood guard
    while (true) {
      if (buf.length < 2) break;
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16384) { dropConn(conn); socket.destroy(); return; }        // oversized frame
      const maskStart = off;
      if (masked) off += 4;
      if (buf.length < off + len) break;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) { const m = buf.subarray(maskStart, maskStart + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.subarray(off + len);
      if (op === 8) { dropConn(conn); socket.destroy(); return; }
      if (op === 9) { if (!socket.destroyed) socket.write(frame(payload, 10)); continue; } // ping -> pong
      if (op === 10) continue;
      if (op === 1) { try { onMessage(conn, JSON.parse(payload.toString('utf8'))); } catch { /* ignore bad msg */ } }
    }
  });
  socket.on('close', () => dropConn(conn));
  socket.on('error', () => dropConn(conn));

  conn.send({ t: 'hello', scene, booms, players: roster(), w: sockets.size, time: timeState || undefined });
});

/* ============================================================
   Game state — 1 corpo, up to 4 humans
   Humans: +1 point per second alive. Corpo: +50 per layoff.
   ============================================================ */
const COLORS = [0xff2424, 0x2486ff, 0xffd724, 0xb35cff];
const SPAWNS = [[21.5, 2, 17.5], [40.5, 2, 18.5], [-8.5, 2, 16.5], [13.5, 2, 50.5]];
const RESPAWN_MS = +(process.env.RESPAWN_MS || 10000);
const players = new Map(); // id -> player
const booms = [];          // [x,y,z] history, replayed to new connections
let nextId = 1;
let scene = 'default';     // 'default' | 'tech' | 'techlong' — all clients build the same scene
let timeState = null;      // { m, play } — the corpo's time of day, followed by everyone

/* ---- name filter: slurs and hate terms are refused; casual profanity is
       not our problem. Kept in sync with the copy in brownstone.html. ---- */
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't' };
const SLUR_PART = ['nigg', 'niga', 'fagg', 'fagot', 'kike', 'wetback', 'beaner', 'trann', 'hitler', 'swastik', 'towelhead', 'raghead', 'pedoph', 'negro'];
const SLUR_WORD = new Set(['fag', 'fags', 'spic', 'spics', 'coon', 'coons', 'gook', 'gooks', 'dyke', 'dykes',
  'paki', 'pakis', 'chink', 'chinks', 'jap', 'japs', 'nazi', 'nazis', 'retard', 'retards', 'tard',
  'rape', 'raping', 'rapist', 'heeb', 'yid', 'kys', 'pedo', 'pedos', 'homo']);
function nameOffensive(raw) {
  let flat = '', cur = '';
  const tokens = [];
  for (const ch of String(raw).toLowerCase()) {
    const c = LEET[ch] !== undefined ? LEET[ch] : ch;
    if (c >= 'a' && c <= 'z') { flat += c; cur += c; }
    else { if (cur) tokens.push(cur); cur = ''; }
  }
  if (cur) tokens.push(cur);
  for (const p of SLUR_PART) if (flat.includes(p)) return true;
  return tokens.some(w => SLUR_WORD.has(w));
}

const roster = () => [...players.values()].map(p => ({
  id: p.id, name: p.name, role: p.role, score: p.score, alive: p.alive,
  color: p.color, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
}));

function broadcast(obj, except = null) {
  const s = frame(JSON.stringify(obj));
  for (const c of sockets) if (c !== except && !c.socket.destroyed) c.socket.write(s);
}

// roster + connected head-count, shown in every client's panel
function pushPlayers() {
  broadcast({ t: 'players', list: roster(), w: sockets.size });
}

function dropConn(conn) {
  if (conn.closed) return;
  conn.closed = true;
  sockets.delete(conn);
  if (conn.player) {
    players.delete(conn.player.id);
    console.log(`left: ${conn.player.name} (${conn.player.role})`);
    pushPlayers();
  }
}

function onMessage(conn, m) {
  const p = conn.player;
  switch (m.t) {
    case 'join': {
      if (p) return;
      const name = String(m.name || '').trim().slice(0, 12) || 'player';
      if (nameOffensive(name)) { conn.send({ t: 'denied', reason: "that name won't fly — pick another" }); return; }
      const corpoTaken = [...players.values()].some(q => q.role === 'corpo');
      const humans = [...players.values()].filter(q => q.role === 'human').length;
      let role;
      if (m.want === 'corpo') {
        if (corpoTaken) { conn.send({ t: 'denied', reason: 'corpo seat is taken' }); return; }
        role = 'corpo';
      } else {
        if (humans >= 4) { conn.send({ t: 'denied', reason: 'all 4 human seats are full' }); return; }
        role = 'human';
      }
      const id = nextId++;
      const spawn = SPAWNS[humans % SPAWNS.length];
      const pl = {
        id, conn, name, role, score: 0,
        alive: role === 'human', diedAt: 0,
        color: role === 'corpo' ? 0x9aa0a6 : COLORS[humans % COLORS.length],
        x: spawn[0], y: spawn[1], z: spawn[2], yaw: 0,
      };
      conn.player = pl;
      players.set(id, pl);
      console.log(`joined: ${name} as ${role}`);
      conn.send({ t: 'welcome', id, role, color: pl.color, x: pl.x, y: pl.y, z: pl.z });
      pushPlayers();
      break;
    }
    case 'pos':
      if (p && p.role === 'human' && p.alive) {
        p.x = +m.x || 0; p.y = +m.y || 0; p.z = +m.z || 0; p.yaw = +m.yaw || 0;
        broadcast({ t: 'pos', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw }, conn);
      }
      break;
    case 'time': // the corpo's clock is authoritative for the whole lobby
      if (p && p.role === 'corpo') {
        timeState = { m: Math.max(0, Math.min(1439, +m.m || 0)), play: !!m.play };
        broadcast({ t: 'time', ...timeState }, conn);
      }
      break;
    case 'spot': // corpo's night searchlight aim + beam origin, relayed to everyone else
      if (p && p.role === 'corpo') broadcast({
        t: 'spot', x: +m.x || 0, y: +m.y || 0, z: +m.z || 0,
        ox: +m.ox || 0, oy: +m.oy || 0, oz: +m.oz || 0,
      }, conn);
      break;
    case 'boom': // corpo-only ability
      if (p && p.role === 'corpo') {
        const b = [Math.round(+m.x || 0), Math.round(+m.y || 0), Math.round(+m.z || 0)];
        booms.push(b);
        broadcast({ t: 'boom', x: b[0], y: b[1], z: b[2] });
      }
      break;
    case 'fire': // corpo lays off a human
      if (p && p.role === 'corpo') {
        const tgt = players.get(+m.target);
        if (tgt && tgt.role === 'human' && tgt.alive) {
          tgt.alive = false;
          tgt.diedAt = Date.now();
          p.score += 50;
          console.log(`layoff: ${tgt.name} by ${p.name}`);
          broadcast({ t: 'layoff', id: tgt.id, by: p.id, x: tgt.x, y: tgt.y, z: tgt.z });
          pushPlayers();
        }
      }
      break;
    case 'respawn':
      if (p && p.role === 'human' && !p.alive && Date.now() - p.diedAt >= RESPAWN_MS) {
        p.alive = true;
        const s = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
        p.x = s[0]; p.y = s[1]; p.z = s[2];
        broadcast({ t: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z });
        pushPlayers();
      }
      break;
    case 'reset': // any seated player may rebuild the block (client confirms first)
      if (p) {
        booms.length = 0;
        console.log(`scene reset by ${p.name}`);
        broadcast({ t: 'reset' });
      }
      break;
    case 'scene': // any seated player may switch scenes for everyone
      if (p && ['default', 'tech', 'techlong'].includes(m.scene) && m.scene !== scene) {
        scene = m.scene;
        booms.length = 0;
        console.log(`scene -> ${scene} by ${p.name}`);
        broadcast({ t: 'scene', scene });
      }
      break;
    case 'ping':
      break;
  }
}

// survival pay: +1/sec to every living human; the once-a-second push also
// keeps every client's scoreboard and connected head-count fresh
setInterval(() => {
  for (const p of players.values()) if (p.role === 'human' && p.alive) p.score++;
  if (sockets.size) pushPlayers();
}, 1000);

// protocol-level keepalive so idle proxies don't drop us
setInterval(() => {
  for (const c of sockets) if (!c.socket.destroyed) c.socket.write(frame(Buffer.alloc(0), 9));
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`voxel-brownstone (multiplayer) listening on http://${HOST}:${PORT}`);
});
