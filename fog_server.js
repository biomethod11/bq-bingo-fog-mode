// Beta Quest Bingo Fog Mode, the Node server: for playing on your own machine or network, and for the tests. The
// deployed site runs the same rooms on Cloudflare instead (cloudflare/). No npm packages: Node's http module,
// Server-Sent Events for live updates, and one JSON file per room so a restart loses nothing.
//
// The rules are in fog_logic.js and everything about a live room (its API, live updates, timers, passwords) is in
// room_host.js; this file only stores rooms as files, sets timers and speaks HTTP. The server builds the card and
// only ever sends each color the squares it may see, so the fog can't be lifted with the browser's devtools.
//
//   node fog_server.js [--port 8787] [--host 127.0.0.1] [--rooms <dir>]
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Fog = require("./fog_logic");
const { RoomHost, RateLimit, newRoom, newRoomId, parseBody, AWAY_AFTER, CREATE_LIMIT, ROOM_ID_RE } = require("./room_host");
const { loadGenerator } = require("./load_generator");

const PAGE = path.join(__dirname, "fog.html");
const RULES = path.join(__dirname, "fog_logic.js");

function parseArgs(argv) {
  const out = { port: 8787, host: "127.0.0.1", rooms: path.join(__dirname, "rooms") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--host") out.host = argv[++i];
    else if (argv[i] === "--rooms") out.rooms = argv[++i];
  }
  return out;
}

// Room passwords from before PBKDF2 were salted scrypt hashes; rooms saved by an older version still check out.
async function verifyScrypt(pass, password) {
  const got = await new Promise((resolve, reject) => crypto.scrypt(password, pass.salt, 32, (e, k) => (e ? reject(e) : resolve(k))));
  return crypto.timingSafeEqual(Buffer.from(pass.hash, "base64url"), got);
}

// roomsDir: where rooms are saved. cardFor(seed, size): builds a card. clock: ms timestamps (tests pass a fake one).
// claimDelay: the claim undo timer, in seconds, for rooms without lockout. awayAfter: ms before a player with no page
// open stops counting for Ready. createLimit: rooms one address may create per window.
function createServer({ roomsDir, cardFor, clock = () => Date.now(), log = console.log, claimDelay = Fog.CLAIM_DELAY, awayAfter = AWAY_AFTER, createLimit = CREATE_LIMIT }) {
  fs.mkdirSync(roomsDir, { recursive: true });
  const hosts = new Map(); // room id -> RoomHost
  const timers = new Map(); // room id -> the timer that wakes its host
  const creations = new RateLimit(createLimit.max, createLimit.windowMs);
  const fileOf = (id) => path.join(roomsDir, `${id}.json`);

  function addHost(room) {
    const host = new RoomHost(room, {
      clock, awayAfter, verifyLegacyPassword: verifyScrypt,
      save: (r) => fs.writeFileSync(fileOf(r.id), JSON.stringify(r)),
      schedule: (at) => schedule(room.id, at),
    });
    hosts.set(room.id, host);
    return host;
  }
  function schedule(id, at) {
    clearTimeout(timers.get(id));
    const delay = Math.min(Math.max(20, at - clock() + 20), 2 ** 31 - 1); // setTimeout's longest delay is ~24 days
    const handle = setTimeout(() => wake(id), delay);
    if (handle.unref) handle.unref();
    timers.set(id, handle);
  }
  // Returns the host, or null if the room has expired (and is now deleted).
  function wake(id) {
    const host = hosts.get(id);
    if (!host) return null;
    if (host.wake() !== "expired") return host;
    clearTimeout(timers.get(id));
    timers.delete(id);
    hosts.delete(id);
    try { fs.unlinkSync(fileOf(id)); } catch {}
    log(`room ${id}: deleted after a week without activity`);
    return null;
  }

  for (const f of fs.readdirSync(roomsDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const room = JSON.parse(fs.readFileSync(path.join(roomsDir, f), "utf8"));
      if (room.v === 2 || room.v === 3) addHost(room); // v1 used per-player links; skip it
    } catch (e) {
      log(`skipping unreadable room file ${f}: ${e.message}`);
    }
  }
  for (const id of [...hosts.keys()]) wake(id);

  function send(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; if (data.length > 20_000) req.destroy(); });
      req.on("end", () => { try { resolve(parseBody(data)); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  }

  async function createRoom(req, res) {
    if (!creations.allow(req.socket.remoteAddress || "?", clock())) {
      return send(res, 429, { error: "That's a lot of new rooms from here in the last hour. Try again later." });
    }
    const body = await readBody(req);
    let id;
    do id = newRoomId();
    while (hosts.has(id) || fs.existsSync(fileOf(id)));
    try {
      const { room, token } = await newRoom(id, body, { cardFor, now: clock(), defaultClaimDelay: claimDelay });
      addHost(room).changed();
      log(`room ${id}: ${room.config.size}x${room.config.size}, filename ${room.filenameSeed}`);
      return send(res, 200, { id, token });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // The page: "/", a room link "/r/<code>", and "/play" (a room with its code kept out of the address bar).
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/play" || (parts[0] === "r" && parts.length === 2))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        return res.end(fs.readFileSync(PAGE));
      }
      if (req.method === "GET" && url.pathname === "/rules.js") {
        // The rules file itself, wrapped for the browser, so the create page checks combinations exactly as the server does.
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(`(function () { var module = { exports: {} };\n${fs.readFileSync(RULES, "utf8")}\nwindow.FogRules = module.exports; })();\n`);
      }
      if (parts[0] !== "api" || parts[1] !== "rooms") return send(res, 404, { error: "Not found." });
      if (req.method === "POST" && parts.length === 2) return await createRoom(req, res);
      if (parts.length !== 4 || !ROOM_ID_RE.test(parts[2])) return send(res, 404, { error: "Not found." });

      const host = wake(parts[2]); // settles anything due first
      if (!host) return send(res, 404, { error: "There's no room with that code." });
      const token = url.searchParams.get("t") || "";

      if (req.method === "GET" && parts[3] === "events") {
        if (!host.playerOf(token)) return send(res, 403, { error: "Join the room first." });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        const close = host.openStream(token, (text) => res.write(text));
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => { clearInterval(ping); close(); });
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : {};
      const r = await host.handle(req.method, parts[3], token, body);
      return send(res, r.status, r.body);
    } catch (e) {
      if (e.status === 400) return send(res, 400, { error: e.message });
      log(`error: ${e.stack || e}`);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong on the server." });
    }
  });

  server.on("close", () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });
  // rooms: read-only access to the rooms themselves (the tests look inside them).
  const rooms = { get: (id) => (hosts.get(id) || {}).room, has: (id) => hosts.has(id) };
  return { server, rooms };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cardFor = loadGenerator();
  const { server } = createServer({ roomsDir: args.rooms, cardFor });
  server.listen(args.port, args.host, () => {
    console.log(`Beta Quest Bingo Fog Mode server on http://${args.host === "0.0.0.0" ? "localhost" : args.host}:${args.port}/`);
  });
}

module.exports = { createServer };
