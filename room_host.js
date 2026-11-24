// One live room, the same wherever it runs. The Node server (fog_server.js) keeps a RoomHost per room in memory; on
// Cloudflare each room is a Durable Object holding one (cloudflare/rooms/worker.js). A host answers the room's API,
// pushes live updates to the pages that have the room open, and says when it next needs waking up: a claim's undo
// timer running out, a player away before the start, or the room expiring after a week without activity.
//
// Only standard JavaScript and the Web Crypto API are used (both in Node 20+ and Workers), so both platforms run
// exactly this code; they differ only in how they store rooms, stream to pages and set timers.
"use strict";

const Fog = require("./fog_logic");

const AWAY_AFTER = 30_000; // before the start, a player whose page has been closed this long stops counting for Ready
const KEEP_FOR = 7 * 24 * 60 * 60 * 1000; // a room nobody has touched for a week is deleted
const PASSWORD_MAX = 64;
const WRONG_TRIES = 10; // wrong room passwords a room accepts per minute
// Cheap on purpose (Workers have a small CPU budget per request): the wrong-guess limit is what really guards a room.
const PBKDF2_ITERATIONS = 10_000;
const CREATE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 }; // rooms one address can create per hour
const MAX_BODY = 10_000; // bytes in a request body
const ROOM_ID_RE = /^[a-z0-9]{6}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;
const FILENAME_RE = /^[A-Za-z0-9. -]{1,8}$/;
const ROOM_ID_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

// --- small helpers ---------------------------------------------------------------------------------------------

// A uniform random integer in 0..n-1.
function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}
const random = () => randomInt(1 << 30) / (1 << 30);
function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const newToken = () => base64url(crypto.getRandomValues(new Uint8Array(12))); // 16 characters
const newRoomId = () => Array.from({ length: 6 }, () => ROOM_ID_LETTERS[randomInt(ROOM_ID_LETTERS.length)]).join("");
const cleanPassword = (pw) => (typeof pw === "string" ? pw.trim() : "");
const colorArg = (c) => (c === "spectator" || c === null || c === undefined || c === "" ? null : String(c));

// Room passwords are stored only as a salted PBKDF2-SHA256 hash.
async function pbkdf2(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return base64url(new Uint8Array(bits));
}
async function hashPassword(password) {
  const salt = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return { algo: "pbkdf2-sha256", salt, hash: await pbkdf2(password, salt) };
}
function sameText(a, b) { // compares in constant time for equal lengths
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A request body: JSON, at most MAX_BODY bytes. Throws an Error with status 400 otherwise.
function parseBody(text) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (text.length > MAX_BODY) throw bad("The request was too large.");
  try { return text ? JSON.parse(text) : {}; } catch { throw bad("The request wasn't valid JSON."); }
}

// At most `max` events per key in any `windowMs` (room creation per address). Kept in memory.
class RateLimit {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.seen = new Map(); }
  allow(key, now) {
    if (this.seen.size > 10_000) for (const [k, times] of this.seen) if (now - times[times.length - 1] >= this.windowMs) this.seen.delete(k);
    const recent = (this.seen.get(key) || []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.max;
    if (ok) recent.push(now);
    this.seen.set(key, recent);
    return ok;
  }
}

// --- creating a room -------------------------------------------------------------------------------------------

// A new room from the create form (setting names: normalizeConfig in fog_logic.js), with the creator joined.
// Returns { room, token }; throws an Error with a player-facing message if something's wrong.
// cardFor(seed, size) builds the card; defaultClaimDelay is the claim undo timer for rooms without lockout.
async function newRoom(id, input, { cardFor, now, defaultClaimDelay = Fog.CLAIM_DELAY }) {
  // Open is the only goal for now (players set their own win condition). The claim undo timer is a lockout setting
  // (off, or 1-10 seconds, sent as claimDelay); rooms without lockout always get the default.
  const lockout = Fog.normalizeConfig(input).lockout;
  const claimDelay = lockout && input.claimDelay !== undefined ? input.claimDelay : defaultClaimDelay;
  const body = { ...input, goal: "open", claimDelay };
  const problems = Fog.configProblems(body);
  if (problems.length) throw new Error(problems.join(" "));
  const password = cleanPassword(body.password);
  if (password.length > PASSWORD_MAX) throw new Error(`The room password can be up to ${PASSWORD_MAX} characters.`);
  const filenameSeed = body.filenameSeed === undefined || body.filenameSeed === "" ? String(1 + randomInt(999999)) : String(body.filenameSeed);
  if (!FILENAME_RE.test(filenameSeed)) throw new Error("The filename can be up to 8 characters: letters, digits, spaces, dots and dashes.");
  let cardSeed;
  if (body.cardSeed !== undefined && body.cardSeed !== "") {
    cardSeed = String(body.cardSeed);
    if (cardSeed === filenameSeed.trim()) throw new Error("The card seed must differ from the filename, or players could look the card up.");
  } else {
    do cardSeed = String(1 + randomInt(999999));
    while (cardSeed === filenameSeed.trim());
  }
  const board = cardFor(cardSeed, Fog.normalizeConfig(body).size);
  const room = Fog.createRoom({ id, board, cardSeed, filenameSeed, config: body, now, rand: random });
  room.touched = now;
  if (password) room.pass = await hashPassword(password); // kept out of config, so no view or /info ever sends it
  const token = newToken();
  const joined = Fog.join(room, token, body.name, colorArg(body.color), now);
  if (!joined.ok) throw new Error(joined.error);
  return { room, token };
}

// --- one live room ---------------------------------------------------------------------------------------------

const sse = (view) => `event: state\ndata: ${JSON.stringify(view)}\n\n`;
const viewKey = (view) => JSON.stringify({ ...view, now: 0 }); // what changed, ignoring the server time

class RoomHost {
  // room: the room as saved. Options:
  //   save(room)    store it (called after every change)
  //   schedule(at)  call wake() at time `at` (ms); a later call replaces the earlier one
  //   clock()       the time in ms (tests pass a fake one)
  //   awayAfter     ms before a player with no page open stops counting for Ready
  //   verifyLegacyPassword(pass, password)  rooms made before PBKDF2 (the Node server's old scrypt hashes)
  constructor(room, { save, schedule = () => {}, clock = () => Date.now(), awayAfter = AWAY_AFTER, verifyLegacyPassword = null }) {
    this.room = Fog.upgradeRoom(room);
    if (!this.room.touched) this.room.touched = this.room.created || clock();
    Object.assign(this, { save, schedule, clock, awayAfter, verifyLegacyPassword });
    this.streams = new Set(); // open pages: { token, send(text), last }
    this.open = new Map(); // token -> how many pages that player has open
    this.awayAt = new Map(); // token -> when to mark them away if no page opens (before the start)
    this.wrongTries = []; // times of recent wrong passwords
    // Nobody's page is open yet (a new room, or one just loaded): start everyone's away clock.
    const now = clock();
    for (const token of Object.keys(this.room.players)) this.awayAt.set(token, now + awayAfter);
  }

  playerOf(token) {
    const players = this.room.players;
    return token && TOKEN_RE.test(token) && Object.prototype.hasOwnProperty.call(players, token) ? players[token] : null;
  }

  // What this token may see. me.dropped: they were away when the game started, so they're watching (the page says why).
  view(token) {
    const p = this.playerOf(token);
    const me = p ? { name: p.name, color: p.color, ...(p.dropped ? { dropped: true } : {}) } : null;
    return Fog.viewFor(this.room, p ? p.color : null, this.clock(), { me });
  }

  // Push the new state to every open page whose view changed. Skipping unchanged views matters: a waiting claim is
  // invisible to other colors, and an update arriving the moment someone clicks would give it away.
  broadcast() {
    for (const s of this.streams) {
      const v = this.view(s.token);
      const key = viewKey(v);
      if (key === s.last) continue;
      s.last = key;
      s.send(sse(v));
    }
  }

  touch() { this.room.touched = this.clock(); }
  expiresAt() { return this.room.touched + KEEP_FOR; }
  // When wake() next has something to do.
  nextWakeAt() {
    const times = [this.expiresAt()];
    const claim = Fog.nextPending(this.room);
    if (claim !== null) times.push(claim);
    if (this.room.started === null) times.push(...this.awayAt.values());
    return Math.min(...times);
  }
  reschedule() { this.schedule(this.nextWakeAt()); }
  changed() { this.save(this.room); this.broadcast(); this.reschedule(); }

  // Do whatever is due: claims whose undo timer ran out take effect, and players away too long before the start
  // stop counting for Ready (which can start the game). Called on a timer and before every request.
  // Returns "expired" when the room should be deleted (a week without activity).
  wake() {
    const now = this.clock();
    if (now >= this.expiresAt()) return "expired";
    let dirty = Fog.settle(this.room, now) > 0;
    if (this.room.started === null) {
      for (const [token, at] of this.awayAt) {
        if (at > now) continue;
        this.awayAt.delete(token);
        if (!this.open.get(token) && Fog.setAway(this.room, token, true, now).changed) dirty = true;
      }
    } else this.awayAt.clear();
    if (dirty) { this.save(this.room); this.broadcast(); }
    this.reschedule();
    return "ok";
  }

  // The room's API: GET info / state, POST join / action. Returns { status, body }. (The live update stream is
  // openStream, since each platform streams its own way.)
  async handle(method, verb, token, body = {}) {
    if (method === "GET" && verb === "info") return { status: 200, body: this.info() };
    if (method === "POST" && verb === "join") return this.join(body);
    const player = this.playerOf(token);
    if (!player) return { status: 403, body: { error: "Join the room first." } };
    if (method === "GET" && verb === "state") return { status: 200, body: this.view(token) };
    if (method === "POST" && verb === "action") return this.action(player, body);
    return { status: 404, body: { error: "Not found." } };
  }

  // Public: what the join form needs. No card, and no seed but the filename.
  info() {
    const r = this.room;
    const v = Fog.viewFor(r, null, this.clock());
    return { id: r.id, config: r.config, goalText: v.goalText, filenameSeed: r.filenameSeed, started: r.started, ended: !!r.ended, players: v.players, colors: r.colors, password: !!r.pass };
  }

  async join(body) {
    const room = this.room;
    // Same tab rejoining keeps its token; a new tab joining with the same nickname and color takes over that
    // player's place (honor system, like BingoSync) instead of adding a duplicate.
    const nick = String(body.name || "").replace(/\s+/g, " ").trim().toLowerCase();
    const same = Object.keys(room.players).find((k) => room.players[k].name.toLowerCase() === nick && room.players[k].color === colorArg(body.color));
    const inRoom = !!this.playerOf(body.token);
    // A password-protected room: everyone joining or spectating needs it (taking over a place by nickname and color
    // too). Someone already in the room (this tab's token) changing name or color doesn't.
    if (!inRoom) {
      const pw = await this.checkPassword(body.password);
      if (pw === "wait") return { status: 429, body: { ok: false, error: "Too many wrong passwords for this room. Wait a minute and try again.", password: true } };
      if (pw === "wrong") return { status: 403, body: { ok: false, error: body.password ? "Wrong room password." : "This room needs a password.", password: true } };
    }
    const token = inRoom ? body.token : same || newToken();
    const result = Fog.join(room, token, body.name, colorArg(body.color), this.clock());
    if (!result.ok) return { status: 400, body: result };
    this.touch();
    if (!this.open.get(token)) this.awayAt.set(token, this.clock() + this.awayAfter); // away if their page never opens
    this.changed();
    return { status: 200, body: { token } };
  }

  // Is this the room's password? Wrong guesses are counted; too many in a minute and the room stops checking for a
  // while. Returns "ok", "wrong" or "wait".
  async checkPassword(given) {
    const pass = this.room.pass;
    if (!pass) return "ok";
    const now = this.clock();
    this.wrongTries = this.wrongTries.filter((t) => now - t < 60_000);
    if (this.wrongTries.length >= WRONG_TRIES) return "wait";
    const password = cleanPassword(given);
    let right;
    if (pass.algo === "pbkdf2-sha256") right = sameText(await pbkdf2(password, pass.salt), pass.hash);
    else right = this.verifyLegacyPassword ? await this.verifyLegacyPassword(pass, password) : false;
    if (right) return "ok";
    this.wrongTries.push(now);
    return "wrong";
  }

  action(player, body) {
    const now = this.clock();
    const color = player.color;
    const by = player.name;
    const cell = body.cell === undefined ? undefined : Number(body.cell);
    let result;
    if (!color) result = { ok: false, error: "Spectators can't do that. Join with a color to play." };
    else {
      switch (body.type) {
        case "ready": result = Fog.setReady(this.room, color, body.ready !== false, now); break;
        case "claim": result = Fog.claim(this.room, color, cell, now, by, body.free === true); break;
        case "cancel": result = Fog.cancelClaim(this.room, color, cell, now, by); break;
        case "note": result = Fog.toggleNote(this.room, color, cell, String(body.kind), by); break;
        case "lens": result = Fog.useLens(this.room, color, cell, now, by); break; // a Free Reveal
        case "adj": result = Fog.useAdjacent(this.room, color, cell, now, by); break;
        case "undo": result = Fog.requestUndo(this.room, color, cell, now, by); break;
        case "undo-answer": result = Fog.answerUndo(this.room, color, !!body.yes, now, by); break;
        case "end": result = Fog.endEarly(this.room, color, now, by); break;
        default: result = { ok: false, error: "Unknown action." };
      }
    }
    if (result.ok) { this.touch(); this.changed(); }
    return { status: result.ok ? 200 : 400, body: result };
  }

  // A page opened the live update stream (Server-Sent Events). send(text) writes to it. Returns close(), to call
  // when the page goes away, or null if the token isn't in the room (the platform answers 403).
  openStream(token, send) {
    const player = this.playerOf(token);
    if (!player) return null;
    this.open.set(token, (this.open.get(token) || 0) + 1);
    this.awayAt.delete(token);
    if (player.away && Fog.setAway(this.room, token, false, this.clock()).changed) this.broadcast(); // back before the start
    this.touch();
    this.save(this.room);
    const first = this.view(token);
    const entry = { token, send, last: viewKey(first) };
    this.streams.add(entry);
    send(sse(first));
    this.reschedule();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.streams.delete(entry);
      const left = (this.open.get(token) || 1) - 1;
      if (left > 0) { this.open.set(token, left); return; }
      this.open.delete(token);
      if (this.room.started === null) { this.awayAt.set(token, this.clock() + this.awayAfter); this.reschedule(); }
    };
  }
}

module.exports = {
  RoomHost, RateLimit, newRoom, newRoomId, parseBody,
  AWAY_AFTER, KEEP_FOR, CREATE_LIMIT, ROOM_ID_RE, PASSWORD_MAX,
};
