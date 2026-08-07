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
const JS = 'text/javascript; charset=utf-8';
const VENDOR = new Map([
  ['/vendor/three.module.min.js', { body: readFileSync(join(here, 'vendor/three.module.min.js')), type: JS }],
  ['/vendor/addons/controls/OrbitControls.js', { body: readFileSync(join(here, 'vendor/addons/controls/OrbitControls.js')), type: JS }],
  ['/vendor/press-start-2p.woff2', { body: readFileSync(join(here, 'vendor/press-start-2p.woff2')), type: 'font/woff2' }],
]);
const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const path = (req.url || '').split('?')[0];
  for (const [suffix, file] of VENDOR) {
    if (path.endsWith(suffix)) {
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'public, max-age=86400',
      });
      res.end(req.method === 'HEAD' ? undefined : file.body);
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

// CORPO_KEY set => "show mode": the corpo seat needs the key (?corpo=… in the
// operator's URL) and reset/scene-switch are corpo-only. Empty => casual mode.
const CORPO_KEY = process.env.CORPO_KEY || '';

server.on('upgrade', (req, socket) => {
  if (sockets.size >= MAX_CONNS) { socket.destroy(); return; }
  // browsers always send Origin: reject pages on foreign hosts trying to
  // ride along; non-browser clients (no Origin) pass — the rate limiter
  // and role gates bound what they can do anyway
  const origin = req.headers.origin;
  if (origin) {
    let oh;
    try { oh = new URL(origin).host; } catch { socket.destroy(); return; }
    const sameHost = oh === (req.headers.host || '');
    const tsnet = /\.ts\.net(:\d+)?$/.test(oh);
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(oh);
    if (!sameHost && !tsnet && !local) { socket.destroy(); return; }
  }
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
    tokens: 80, tLast: Date.now(),   // message-rate token bucket
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
      if (op === 1) {
        // ~40 msg/s sustained (burst 80) is 2.5x a busy client; floods get cut
        const now = Date.now();
        conn.tokens = Math.min(80, conn.tokens + (now - conn.tLast) * 0.04);
        conn.tLast = now;
        if (--conn.tokens < 0) { dropConn(conn); socket.destroy(); return; }
        try { onMessage(conn, JSON.parse(payload.toString('utf8'))); } catch { /* ignore bad msg */ }
      }
    }
  });
  socket.on('close', () => dropConn(conn));
  socket.on('error', () => dropConn(conn));

  conn.send({ t: 'hello', scene, booms, players: roster(), w: sockets.size, time: timeState || undefined, marquee: marqueeText || undefined, pk: pkState(), maxh: MAX_HUMANS });
});

/* ============================================================
   Game state — 1 corpo, up to 4 humans
   Humans: +1 point per second alive. Corpo: +50 per layoff.
   ============================================================ */
const MAX_HUMANS = +(process.env.MAX_HUMANS || 50);
const COLORS = [0xff2424, 0x2486ff, 0xffd724, 0xb35cff, 0x2ad4a8, 0xff7a24,
                0x24c8ff, 0xff4fa3, 0x8fd820, 0xd0d0d8, 0xa86a32, 0x7a8cff];
const SPAWNS = {
  default: [[21.5, 2, 17.5], [40.5, 2, 18.5], [-8.5, 2, 16.5], [13.5, 2, 50.5]],
  boston: [[10.5, 2, 17.5], [64.5, 2, 17.5], [36.5, 2, 50.5], [-14.5, 2, 50.5]],
  bostonlong: [[21.5, 2, 17.5], [44.5, 2, 18.5], [80.5, 2, 17.5], [102.5, 2, 17.5],
               [134.5, 2, 17.5], [13.5, 2, 58.5], [72.5, 2, 58.5], [118.5, 2, 58.5]],
  seattle: [[-12.5, 3, 60.5], [-2.5, 3, 10.5], [45.5, 11, 14.5], [17.5, 3, -13.5],
            [56.5, 11, -28.5], [78.5, 17, 6.5], [46.5, 11, 54.5], [78.5, 17, -30.5]],
  // 4th element = spawn yaw: 0 faces north (-z), 3.14 south, -1.57 east, 1.57 west.
  // Every Seattle Long spawn opens onto street/water/promenade — never nose-to-wall.
  seattlelong: [[-38.5, 3, -4.5, 3.14], [8.5, 3, -4.5, 3.14], [30.5, 3, 11.5, -1.57], [43.5, 3, -4.5, 3.14],
                [88.5, 3, -4.5, 3.14], [105.5, 3, -4.5, 3.14], [90.5, 3, 26.5, 3.14], [75.5, 3, 44.5, 3.14]],
  la: [[24.5, 3, 4.5, 0], [40.5, 3, -2.5, -1.57], [70.5, 3, -2.5, -1.57], [12.5, 3, 26.5, 0],
    [50.5, 3, 8.5, 3.14], [-14.5, 4, 20.5, -1.57], [88.5, 3, 28.5, 0], [-26.5, 2, 40.5, -1.57]],
  sf: [[-32.5, 3, 18.5, 0], [-32.5, 3, -30.5, 0], [24.5, 3, 27.5, -1.57], [70.5, 3, 27.5, -1.57],
    [101.5, 3, 10.5, 0], [101.5, 3, -30.5, 0], [-8.5, 3, 40.5, 3.14], [33.5, 3, -8.5, 0]],
  sanjose: [[-20.5, 3, -6.5, 3.14], [28.5, 3, -6.5, 3.14], [76.5, 3, -6.5, 3.14], [110.5, 3, -6.5, 3.14],
            [58.5, 3, 24.5, 0], [-38.5, 3, 32.5, -1.57], [98.5, 3, 32.5, 3.14], [33.5, 3, 13.5, -1.57]],
};
const spawnsFor = () => SPAWNS[scene] || SPAWNS.default;
const randomSpawn = () => { const s = spawnsFor(); return s[Math.floor(Math.random() * s.length)]; };
const RESPAWN_MS = +(process.env.RESPAWN_MS || 10000);
const players = new Map(); // id -> player
const booms = [];          // [x,y,z] history, replayed to new connections
let nextId = 1;
let scene = 'default';     // 'default' | 'tech' | 'techlong' — all clients build the same scene
let timeState = null;      // { m, play } — the corpo's time of day, followed by everyone
let marqueeText = '';      // the corpo's line to the room, shown top-center everywhere
let pickups = [];          // merch drops: [{id, kind, x, y, z, code, foundBy}]
let pickupsOn = false;
const PICKUP_SPOTS = {
  sf: [
    { kind: 'sticker', name: 'green lady roof', x: -37.5, y: 33.5, z: -25.5 },
    { kind: 'sticker', name: 'alcatraz roof', x: 37.5, y: 16.5, z: -32.5 },
    { kind: 'tshirt', name: 'pyramid sky deck', x: 61.5, y: 45.5, z: 38.5 },
  ],
  la: [
    { kind: 'sticker', name: 'ferris wheel hub', x: -29.5, y: 26.5, z: 21.5 },
    { kind: 'sticker', name: 'the fallen O', x: 54.5, y: 45.5, z: -32.5 },
    { kind: 'tshirt', name: 'tower exec floor', x: 85.5, y: 38.5, z: 16.5 },
  ],
  sanjose: [
    { kind: 'sticker', name: 'basilica dome', x: 63.5, y: 27, z: -22.5 },
    { kind: 'sticker', name: 'hotel roof sign', x: -30.5, y: 38.5, z: -26.5 },
    { kind: 'tshirt', name: 'observatory dome', x: -19.5, y: 45, z: -49.5 },
  ],
  seattlelong: [
    { kind: 'sticker', name: 'needle deck', x: -39.5, y: 58.5, z: -19.5 },
    { kind: 'sticker', name: 'sphere crown', x: 43.5, y: 26.5, z: -18.5 },
    { kind: 'tshirt', name: 'ferry cabin', x: 61.5, y: 13.5, z: 46.5 },
  ],
};
const genCode = kind => (kind === 'tshirt' ? 'TEE-' : 'STKR-') +
  Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
function spawnPickups() {   // scene defaults: every slot on, default kinds
  pickups = (PICKUP_SPOTS[scene] || []).map((s, i) => ({ id: i + 1, ...s, on: true, code: genCode(s.kind), foundBy: null }));
}
function respawnCodes() {   // fresh unfound codes, keep per-slot on/kind config
  for (const u of pickups) { u.code = genCode(u.kind); u.foundBy = null; }
}
const pkState = () => ({ on: pickupsOn, list: pickups.map(u => ({ id: u.id, kind: u.kind, name: u.name, x: u.x, y: u.y, z: u.z, taken: !!u.foundBy, on: u.on })) });

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

/* ---- synthetic show-test bots: server-side seats, no sockets ---- */
const bots = [];
function spawnBot(i) {
  const humans = [...players.values()].filter(q => q.role === 'human').length;
  if (humans >= MAX_HUMANS) return false;
  const id = nextId++;
  const spawn = randomSpawn();
  const stub = { send: () => {}, socket: {} };
  stub.socket.end = () => dropConn(stub);
  const pl = {
    id, conn: stub, name: 'bot' + (i + 1), role: 'human', score: 0,
    alive: true, diedAt: 0, bot: true,
    color: COLORS[humans % COLORS.length],
    x: spawn[0], y: spawn[1], z: spawn[2], yaw: spawn[3] || 0,
  };
  stub.player = pl;
  players.set(id, pl);
  bots.push({ pl, kind: i % 2, cx: pl.x, cz: pl.z, r: 4 + (i % 4) * 2, ph: i * 0.7, tx: pl.x, tz: pl.z, retarget: 0 });
  return true;
}
function clearBots() {
  for (const b of bots) if (players.has(b.pl.id)) dropConn(b.pl.conn);
  bots.length = 0;
}
setInterval(() => {   // bot mover: half circle their spawn, half roam spawn-to-spawn
  if (!bots.length) return;
  const t = Date.now() / 1000;
  for (let bi = bots.length - 1; bi >= 0; bi--) {
    const b = bots[bi];
    if (!players.has(b.pl.id)) { bots.splice(bi, 1); continue; }
    const pl = b.pl;
    if (!pl.alive) continue;
    if (b.kind === 0) {
      pl.x = b.cx + Math.cos(t * 0.9 + b.ph) * b.r;
      pl.z = b.cz + Math.sin(t * 0.9 + b.ph) * b.r;
      pl.yaw = -((t * 0.9 + b.ph) % 6.283);
    } else {
      if (t > b.retarget) {
        const s = randomSpawn();
        b.tx = s[0] + (Math.random() - 0.5) * 16;
        b.tz = s[2] + (Math.random() - 0.5) * 16;
        b.retarget = t + 4 + Math.random() * 4;
      }
      const dx = b.tx - pl.x, dz = b.tz - pl.z, L = Math.hypot(dx, dz);
      if (L > 0.4) { pl.x += dx / L * 0.5; pl.z += dz / L * 0.5; pl.yaw = Math.atan2(-dx, -dz); }
    }
    pl.x = +pl.x.toFixed(2); pl.z = +pl.z.toFixed(2); pl.yaw = +pl.yaw.toFixed(2);
    pl.moved = true;
  }
}, 66);

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
        const hasKey = CORPO_KEY !== '' && String(m.key || '') === CORPO_KEY;
        if (CORPO_KEY && !hasKey) {
          conn.send({ t: 'denied', reason: 'the corpo seat is locked for this show' }); return;
        }
        if (corpoTaken) {
          if (!hasKey) { conn.send({ t: 'denied', reason: 'corpo seat is taken' }); return; }
          // the host link always wins: evict whoever holds the seat (ghost tabs included)
          for (const q of [...players.values()]) if (q.role === 'corpo') {
            console.log(`corpo seat reclaimed by host key — evicting ${q.name}`);
            q.conn.send({ t: 'evicted' });
            q.conn.send({ t: 'msg', text: 'the host reclaimed the corpo seat' });
            dropConn(q.conn);
            q.conn.socket.end();   // flush the eviction notice, then close
          }
        }
        role = 'corpo';
      } else {
        if (humans >= MAX_HUMANS) { conn.send({ t: 'denied', reason: 'all human seats are full' }); return; }
        role = 'human';
      }
      const id = nextId++;
      const spawn = randomSpawn();
      const pl = {
        id, conn, name, role, score: 0,
        alive: role === 'human', diedAt: 0,
        color: role === 'corpo' ? 0x9aa0a6 : COLORS[humans % COLORS.length],
        x: spawn[0], y: spawn[1], z: spawn[2], yaw: spawn[3] || 0,
      };
      conn.player = pl;
      players.set(id, pl);
      console.log(`joined: ${name} as ${role}`);
      conn.send({ t: 'welcome', id, role, color: pl.color, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw });
      pushPlayers();
      break;
    }
    case 'pos':
      // accumulated only — one combined broadcast per tick keeps the
      // fan-out at 15 msgs/sec/conn no matter how many humans move
      if (p && p.role === 'human' && p.alive) {
        p.x = +m.x || 0; p.y = +m.y || 0; p.z = +m.z || 0; p.yaw = +m.yaw || 0;
        p.moved = true;
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
    case 'marquee': // the corpo types a line to the room
      if (p && p.role === 'corpo') {
        marqueeText = String(m.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
        broadcast({ t: 'marquee', text: marqueeText }, conn);
      }
      break;
    case 'pickups': // corpo toggles the merch drops
      if (p && p.role === 'corpo') {
        pickupsOn = !!m.on;
        if (pickupsOn && pickups.length === 0) spawnPickups();
        broadcast({ t: 'pickupstate', ...pkState() });
      }
      break;
    case 'pickuprespawn': // corpo re-rolls fresh, unfound codes (keeps per-slot config)
      if (p && p.role === 'corpo') {
        if (pickups.length === 0) spawnPickups(); else respawnCodes();
        broadcast({ t: 'pickupstate', ...pkState() });
        console.log('pickups respawned by ' + p.name);
      }
      break;
    case 'pickupcfg': // corpo tunes one slot: on/off, sticker <-> tshirt
      if (p && p.role === 'corpo') {
        const u = pickups.find(q => q.id === +m.id);
        if (!u) break;
        if (typeof m.on === 'boolean') u.on = m.on;
        if ((m.kind === 'sticker' || m.kind === 'tshirt') && m.kind !== u.kind) {
          u.kind = m.kind;             // a different prize: new code, back up for grabs
          u.code = genCode(u.kind);
          u.foundBy = null;
        }
        broadcast({ t: 'pickupstate', ...pkState() });
      }
      break;
    case 'pickupcodes': // corpo-only reveal
      if (p && p.role === 'corpo')
        conn.send({ t: 'pickupcodes', list: pickups.map(u => ({ kind: u.kind, code: u.code, foundBy: u.foundBy })) });
      break;
    case 'pickup': { // first human to reach it wins — exactly one
      if (!p || p.role !== 'human' || !p.alive || !pickupsOn) break;
      const u = pickups.find(q => q.id === +m.id);
      if (!u || !u.on || u.foundBy) break;
      const dd = (p.x - u.x) ** 2 + (p.y + 2 - u.y) ** 2 + (p.z - u.z) ** 2;
      if (dd > 36) break;                                  // must actually be standing there
      u.foundBy = p.name;
      conn.send({ t: 'pickupcode', kind: u.kind, code: u.code });
      broadcast({ t: 'pickupstate', ...pkState() });
      marqueeText = `${p.name} found a free ${u.kind} code!`;
      broadcast({ t: 'marquee', text: marqueeText });
      console.log(`pickup: ${p.name} -> ${u.kind} ${u.code}`);
      break;
    }
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
        const s = randomSpawn();
        p.x = s[0]; p.y = s[1]; p.z = s[2]; p.yaw = s[3] || 0;
        broadcast({ t: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
        pushPlayers();
      }
      break;
    case 'reset': // any seated player may rebuild the block (corpo-only in show mode)
      if (p) {
        if (CORPO_KEY && p.role !== 'corpo') { conn.send({ t: 'msg', text: 'show mode — only the corpo can reset the scene' }); break; }
        booms.length = 0;
        console.log(`scene reset by ${p.name}`);
        broadcast({ t: 'reset' });
      }
      break;
    case 'scene': // any seated player may switch scenes (corpo-only in show mode)
      if (p && CORPO_KEY && p.role !== 'corpo') { conn.send({ t: 'msg', text: 'show mode — only the corpo can switch scenes' }); break; }
      if (p && ['default', 'tech', 'techlong', 'boston', 'bostonlong', 'seattle', 'seattlelong', 'sanjose', 'sf', 'la'].includes(m.scene) && m.scene !== scene) {
        scene = m.scene;
        clearBots();
        booms.length = 0;
        pickups = [];
        if (pickupsOn) spawnPickups();
        broadcast({ t: 'pickupstate', ...pkState() });
        console.log(`scene -> ${scene} by ${p.name}`);
        broadcast({ t: 'scene', scene });
      }
      break;
    case 'botswarm': // corpo toggles the 50-seat synthetic test swarm
      if (p && p.role === 'corpo') {
        if (bots.length) { clearBots(); console.log(`bot swarm cleared by ${p.name}`); break; }
        let n = 0;
        for (let i = 0; i < 50; i++) if (spawnBot(i)) n++;
        console.log(`bot swarm seated by ${p.name}: ${n}`);
        pushPlayers();
      }
      break;
    case 'kickall': // corpo clears the floor before the show
      if (p && p.role === 'corpo') {
        const msg = 'thank you for playing, now we have to focus on grabbing your data before the show starts';
        let n = 0;
        for (const q of [...players.values()]) if (q.role === 'human') {
          q.conn.send({ t: 'kicked', msg });
          q.conn.socket.end();   // flush the notice, then close; dropConn frees the seat
          n++;
        }
        bots.length = 0;
        console.log(`kickall by ${p.name}: ${n} humans dropped`);
      }
      break;
    case 'ping':
      break;
  }
}

// movement tick: every moved human's position goes out in ONE frame
setInterval(() => {
  const l = [];
  for (const q of players.values())
    if (q.role === 'human' && q.alive && q.moved) {
      q.moved = false;
      l.push({ id: q.id, x: q.x, y: q.y, z: q.z, yaw: q.yaw });
    }
  if (l.length && sockets.size) broadcast({ t: 'poss', l });
}, 66);

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
  console.log(`voxel-brownstone (multiplayer) listening on http://${HOST}:${PORT}`
    + (CORPO_KEY ? ' — show mode: corpo seat locked, reset/scene are corpo-only' : ''));
});
