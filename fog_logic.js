// Beta Quest Bingo Fog Mode game rules. Pure logic with no I/O, so the same file can later run inside a Cloudflare
// Durable Object.
// A room is a plain JSON object; every function here either reads it or mutates it.
//
// One room link, like BingoSync: people join with a nickname and a preset color. Fog belongs to a color, so
// teammates who pick the same color share what they've revealed. With "shared fog" on, everyone shares one view.
//
// Boards are 4x4, 5x5 (the BingoSync card) or 6x6. Cells are numbered row by row from 0 (BingoSync order:
// r1c1 = 0; on 5x5, r5c5 = 24).
//
// Names in the code vs. on the page (the data keeps the older names so saved rooms still load):
//   lens         Free Reveals (reveal any fogged square); config.lens = Starting Free Reveals per color
//   adj          adjacent reveals, from the "Choose" Claim Mode (reveal a fogged square next to yours)
//   free         Free Squares (claim a square without doing its goal); config.free = Starting Free Squares
//   freeReveals  the "Free Square Reveals" setting: does a Free Square reveal like a normal claim?
//   chests       Bonus Reveal Squares (+1 Free Reveal when claimed)
//   claimDelay   the claim undo timer, in seconds (0 = off)
//   homes        each color's random edge or corner start square
//   notes        note symbols (★ ☐ ✕ ○)
"use strict";

const SIZES = [4, 5, 6];
const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "white"]; // navy was dropped: too close to blue and purple
const SHARED = "_shared";
// The claim undo timer: a claim takes effect (its reveals land, other players see it) this many seconds after the
// click; until then it can be taken back. Lockout rooms can turn it off (0) or set 1-MAX_CLAIM_DELAY seconds.
const CLAIM_DELAY = 5;
const MAX_CLAIM_DELAY = 10;
// Players with a color (spectators don't count) a room takes.
const maxPlayers = (config) => (config.lockout ? 4 : 16);
// Recommended most players (teammates on one color count as one) per board size, from simulated games:
// node simulate.js --players (see the README). 16 = every color works, so up to the room limit.
const RECOMMENDED = {
  lockout: { private: { 4: 3, 5: 3, 6: 4 }, shared: { 4: 2, 5: 2, 6: 2 } },
  nonLockout: { private: { 4: 16, 5: 16, 6: 16 }, shared: { 4: 2, 5: 16, 6: 16 } },
};
const recommendedPlayers = (config) => RECOMMENDED[config.lockout ? "lockout" : "nonLockout"][config.sharedFog ? "shared" : "private"][config.size || 5];

const GOALS = {
  line: "first complete row, column or diagonal",
  sprint: "first 2x2 block of your own squares",
  corners: "corners (solo: all 4; versus: first to 2, or first to 3 for 2 colors without lockout)",
  open: "no set goal, so play your own rules (lockout, blackout...); the game only ends when someone presses End the game",
};

// Everything that depends on the board size, built once per size.
const GEO = {};
function geometry(n) {
  if (GEO[n]) return GEO[n];
  const idx = (r, c) => r * n + c;
  const span = [...Array(n).keys()];
  const lines = [];
  for (const r of span) lines.push({ name: `row ${r + 1}`, cells: span.map((c) => idx(r, c)) });
  for (const c of span) lines.push({ name: `column ${c + 1}`, cells: span.map((r) => idx(r, c)) });
  lines.push({ name: "diagonal (top-left to bottom-right)", cells: span.map((k) => idx(k, k)) });
  lines.push({ name: "diagonal (bottom-left to top-right)", cells: span.map((k) => idx(n - 1 - k, k)) });
  const blocks = [];
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++) blocks.push({ name: `2x2 block at r${r + 1}c${c + 1}`, cells: [idx(r, c), idx(r, c + 1), idx(r + 1, c), idx(r + 1, c + 1)] });
  const h = Math.floor(n / 2);
  // Odd sizes have one center square; even sizes have a central 2x2 block.
  const middle = n % 2 ? [idx(h, h)] : [idx(h - 1, h - 1), idx(h - 1, h), idx(h, h - 1), idx(h, h)];
  // First color to join starts top-left, second bottom-right, then top-right and bottom-left.
  const homes = [idx(0, 0), idx(n - 1, n - 1), idx(0, n - 1), idx(n - 1, 0)];
  // Each home also sees the center (odd) or the central square nearest to it (even: mirror-fair for two players).
  const nearCenter = n % 2 ? [middle[0], middle[0], middle[0], middle[0]] : [idx(h - 1, h - 1), idx(h, h), idx(h - 1, h), idx(h, h - 1)];
  // Corners mode starts everyone on the middle band: the middle row (odd) or the central 2x2 block (even).
  const band = n % 2 ? span.map((c) => idx(h, c)) : middle.slice();
  // Edge and corner squares: each color starts on a different one of these, picked at random.
  const border = [...Array(n * n).keys()].filter((i) => [0, n - 1].includes(Math.floor(i / n)) || [0, n - 1].includes(i % n));
  GEO[n] = { n, total: n * n, idx, lines, blocks, middle, homes, nearCenter, band, border, corners: [idx(0, 0), idx(0, n - 1), idx(n - 1, 0), idx(n - 1, n - 1)] };
  return GEO[n];
}
const geo = (room) => geometry(room.config.size || 5);

function neighbors(n, i, reveal) {
  const r = Math.floor(i / n), c = i % n;
  const d4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const d8 = d4.concat([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
  return (reveal === 8 ? d8 : d4).filter(([dr, dc]) => r + dr >= 0 && r + dr < n && c + dc >= 0 && c + dc < n).map(([dr, dc]) => (r + dr) * n + c + dc);
}

// What a claim does: reveal the 4 or 8 squares around it, or give 1/2/3 Free Reveals (any fogged square) or adjacent
// reveals (any fogged square touching one of your color's squares, diagonals included). In simulated 5x5 games 2 of
// either kind shows about as much of the board as "Reveal 4" and 3 about as much as "Reveal 8"; 4 or more showed
// most of the board (Free) or mostly went unused (adjacent), so they're not offered. Rooms saved with the older
// 2/4/6 values keep working: claimEffect reads any count.
const ON_CLAIM = ["reveal4", "reveal8", "free1", "free2", "free3", "adj1", "adj2", "adj3"];
function claimEffect(config) {
  const m = /^(reveal|free|adj)(\d)$/.exec(config.onClaim || "reveal4");
  return { kind: m[1], n: Number(m[2]) };
}

function clampInt(v, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
const bool = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : v === true || v === "true" || v === 1 || v === "1" || v === "on");

// Open is the only goal the page offers for now (players set their own win condition); the others stay in the
// rules so they can come back.
function normalizeConfig(cfg = {}) {
  const goal = GOALS[cfg.goal] ? cfg.goal : "open";
  const lens = clampInt(cfg.lens, 0, 3, 0); // starting Free Reveals per color: off by default
  return {
    goal,
    size: SIZES.includes(Number(cfg.size)) ? Number(cfg.size) : 5,
    // "reveal: 8" is the older form of this setting and is still accepted.
    onClaim: ON_CLAIM.includes(cfg.onClaim) ? cfg.onClaim : Number(cfg.reveal) === 8 ? "reveal8" : "reveal4",
    sharedFog: bool(cfg.sharedFog, false), // everyone sees every reveal
    lens,
    chests: clampInt(cfg.chests, 0, 6, 0), // Bonus Reveal Squares: +1 Free Reveal when claimed, in any Claim Mode
    free: clampInt(cfg.free, 0, 3, 0), // Starting Free Squares per color
    freeReveals: bool(cfg.freeReveals, true), // Free Square Reveals: does a Free Square have the Claim Mode's effect?
    lockout: bool(cfg.lockout, true), // off: several colors can mark the same square (BingoSync "non-lockout")
    noteShare: normalizeNoteShare(cfg.noteShare),
    claimDelay: clampInt(cfg.claimDelay, 0, MAX_CLAIM_DELAY, CLAIM_DELAY), // claim undo timer in seconds (0 = off)
  };
}

// Combinations that simulated games showed don't work (see simulate.js and the README). Returns a list of problems
// (empty = fine). The server refuses such rooms, and the page loads this same file to grey them out.
function configProblems(cfg) {
  const c = normalizeConfig(cfg);
  const fx = claimEffect(c);
  const tokens = fx.kind === "reveal" ? 0 : fx.n; // reveals handed out per claim
  const out = [];
  if (c.goal === "corners" && (fx.kind === "free" || c.lens > 0))
    out.push("Corners can't use Free Reveals: players would reveal the corners directly and skip the fog (16-19 min races).");
  if (c.sharedFog && tokens > 2)
    out.push("Shared fog allows at most 2 reveals per claim; with 3, nearly the whole board ends up seen.");
  if (c.size === 6 && c.goal === "corners" && (c.onClaim === "reveal4" || !c.lockout))
    out.push("6x6 Corners needs lockout and something other than Reveal 4; otherwise games run 90-140 min.");
  if (c.size === 4 && (c.onClaim === "reveal8" || tokens > 2))
    out.push("4x4 is small and lightly fogged: use Reveal 4 or 1-2 reveals per claim.");
  else if (c.size === 4 && c.sharedFog && tokens !== 1)
    out.push("4x4 with shared fog only works with 1 reveal per claim; otherwise 86-99% of the board ends up seen.");
  return out;
}

// Note symbols (right/ctrl/alt/shift-click). Each kind is private (kept in the browser), shared with your color
// ("team"), or shared with everyone ("all").
// Ctrl+click is a square; it used to be a red star ("redstar"), which older rooms and settings may still say.
const NOTE_KINDS = ["silver", "square", "x", "circle"];
const NOTE_SCOPES = ["private", "team", "all"];
const OLD_NOTE_KINDS = { redstar: "square" };
function normalizeNoteShare(v) {
  const src = v && typeof v === "object" ? { ...v } : {};
  for (const [old, now] of Object.entries(OLD_NOTE_KINDS)) if (src[now] === undefined && src[old] !== undefined) src[now] = src[old];
  return Object.fromEntries(NOTE_KINDS.map((k) => [k, NOTE_SCOPES.includes(src[k]) ? src[k] : "private"]));
}

// Each square holds a list of marks, one per color: [{color, at, by, free}]. With lockout on it holds at most one
// settled mark, plus any number of waiting ("pending") ones from different colors: nobody else knows about a waiting
// claim, so it can't block anyone. When the first of them takes effect, the rest are sniped (takeEffect).
const marksOn = (room, i) => room.claims[i] || [];
const markOf = (room, i, color) => marksOn(room, i).find((m) => m.color === color) || null;
function removeMark(room, i, color) {
  const rest = marksOn(room, i).filter((m) => m.color !== color);
  if (rest.length) room.claims[i] = rest;
  else delete room.claims[i];
}
function canTake(room, color, i) {
  if (markOf(room, i, color)) return false;
  return room.config.lockout ? !marksOn(room, i).some((m) => !m.pending) : true;
}

// Rooms saved by the previous version kept one claim object per square and had no lockout setting.
function upgradeRoom(room) {
  for (const k of Object.keys(room.claims || {})) if (!Array.isArray(room.claims[k])) room.claims[k] = [room.claims[k]];
  if (room.config.lockout === undefined) room.config.lockout = true;
  if (!room.config.size) room.config.size = 5;
  if (!room.config.onClaim) room.config.onClaim = room.config.reveal === 8 ? "reveal8" : "reveal4";
  delete room.config.reveal;
  room.adj = room.adj || Object.fromEntries((room.colors || []).map((c) => [c, 0]));
  room.config.noteShare = normalizeNoteShare(room.config.noteShare);
  room.notes = room.notes || {};
  upgradeNotes(room);
  if (room.config.claimDelay === undefined) room.config.claimDelay = CLAIM_DELAY;
  room.v = 3;
  return room;
}

// Each color starts seeing the center and its own random edge or corner square (no two colors share one). Boards
// with an even size have no single center, so you get the central square nearest your edge square.
function startingView(room, color) {
  const g = geo(room);
  if (room.config.goal === "corners") return g.band.slice(); // same distance to every corner
  if (room.starts) {
    const home = (room.homes || {})[color];
    return home === undefined ? g.middle.slice() : [...new Set([home, nearestCenter(g, home)])];
  }
  // Rooms made before random starts: corners by join order, then just the middle.
  const k = room.colors.indexOf(color);
  if (k < 0 || k >= g.homes.length) return g.middle.slice();
  return [...new Set([g.homes[k], g.nearCenter[k]])];
}
const dist2 = (n, a, b) => (Math.floor(a / n) - Math.floor(b / n)) ** 2 + ((a % n) - (b % n)) ** 2;
const nearestCenter = (g, i) => g.middle.reduce((best, m) => (dist2(g.n, i, m) < dist2(g.n, i, best) ? m : best));
// The next unused start square, skipping Bonus Reveal Squares while there are others left.
function pickHome(room) {
  const taken = new Set(Object.values(room.homes || {}));
  const left = room.starts.filter((i) => !taken.has(i));
  const plain = left.find((i) => !room.chests.includes(i));
  return plain !== undefined ? plain : left[0];
}

const fogKey = (room, color) => (room.config.sharedFog ? SHARED : color);
const seenOf = (room, color) => room.seen[fogKey(room, color)] || [];

// board: array of size*size {name, difficulty, types}. rand(): float in [0,1), used only to place Bonus Reveal Squares.
function createRoom({ id, board, cardSeed, filenameSeed, config, now, rand }) {
  const cfg = normalizeConfig(config);
  const g = geometry(cfg.size);
  if (!Array.isArray(board) || board.length !== g.total) throw new Error(`board must have ${g.total} goals`);
  const room = {
    v: 3,
    id,
    created: now,
    config: cfg,
    cardSeed,
    filenameSeed,
    board: board.map((g) => ({ name: String(g.name), difficulty: g.difficulty | 0, types: g.types || [] })),
    chests: [],
    starts: shuffled(g.border, rand), // start squares, handed out in this order as colors join
    homes: {}, // color -> its start square
    players: {}, // token -> {name, color, joined}   (color null = spectator)
    colors: [], // colors in the order they first joined
    seen: {}, // color (or "_shared") -> sorted cell list
    lens: {}, // Free Reveals left per color
    adj: {}, // adjacent reveals left per color
    freeLeft: {},
    ready: {},
    started: null,
    ended: null,
    claims: {}, // cell -> [{color, at, by, free, granted}]  (one mark per color; pending/until while its reveals wait)
    undo: null, // pending undo request {color, cell, at, by}
    notes: {}, // shared note symbols: color (team) or "_all" -> cell -> {kind, by, color}
    log: [],
  };
  if (cfg.chests > 0) {
    // Not on a center square, which everyone starts seeing. Start squares avoid them instead (pickHome).
    const banned = new Set([...g.middle, ...(cfg.goal === "corners" ? g.band : [])]);
    const pool = [...Array(g.total).keys()].filter((i) => !banned.has(i));
    for (let k = 0; k < cfg.chests && pool.length; k++) room.chests.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    room.chests.sort((a, b) => a - b);
  }
  return room;
}

const err = (message) => ({ ok: false, error: message });
function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function addSeen(room, color, cells) {
  const key = fogKey(room, color);
  const set = new Set(room.seen[key] || []);
  const added = [];
  for (const c of cells) if (!set.has(c)) { set.add(c); added.push(c); }
  room.seen[key] = [...set].sort((a, b) => a - b);
  return added;
}

function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 20);
}

// Join (or rejoin with the same token) as a color, or as a spectator with color null.
function join(room, token, name, color, now) {
  const nick = cleanName(name);
  if (!nick) return err("Pick a nickname.");
  if (color !== null && !COLORS.includes(color)) return err("Pick one of the preset colors.");
  if (color !== null) {
    const max = maxPlayers(room.config);
    const others = Object.entries(room.players).filter(([t, p]) => t !== token && p.color).length;
    if (others >= max) return err(`This room is full: ${room.config.lockout ? "lockout" : "non-lockout"} rooms take ${max} players. You can still spectate.`);
  }
  const old = room.players[token] ? room.players[token].color : null;
  room.players[token] = { name: nick, color, joined: now };
  // Switching color before the start: a color nobody is on any more leaves the room (it would block Ready forever).
  if (old && old !== color && room.started === null && !playersOn(room, old).length) dropColor(room, old, now, false);
  if (color && !room.colors.includes(color)) {
    room.colors.push(color);
    if (room.starts) (room.homes = room.homes || {})[color] = pickHome(room);
    addSeen(room, color, startingView(room, color));
    room.lens[color] = room.config.lens;
    room.adj = room.adj || {};
    room.adj[color] = 0;
    room.freeLeft[color] = room.config.free;
    room.ready[color] = false;
    if (room.started !== null) room.log.push({ at: now, type: "join-late", color, by: nick });
  }
  return { ok: true };
}

function claimable(room, color) {
  return seenOf(room, color).filter((i) => canTake(room, color, i));
}

// Fogged squares an adjacent reveal can reach: touching (diagonals included) a square your color holds.
function adjacentTargets(room, color) {
  const n = geo(room).n;
  const seen = new Set(seenOf(room, color));
  const out = new Set();
  for (const i of owned(room, color)) for (const j of neighbors(n, i, 8)) if (!seen.has(j)) out.add(j);
  return [...out].sort((a, b) => a - b);
}

const pendingMarks = (room, color) => Object.values(room.claims).flat().filter((m) => m.pending && (!color || m.color === color));

// Boxed in: nothing to claim and no reveal of any kind to spend. You then get one bonus Free Reveal (every time).
// A claim whose reveals are still on the way doesn't count as boxed in.
function isStuck(room, color) {
  if (claimable(room, color).length) return false;
  if (pendingMarks(room, color).length) return false;
  if (room.lens[color] > 0) return false;
  if ((room.adj && room.adj[color]) > 0 && adjacentTargets(room, color).length) return false;
  return true;
}

// --- actions ---------------------------------------------------------------------------------------------

function start(room, now) {
  if (room.started !== null) return err("The game has already started.");
  room.started = now;
  room.log.push({ at: now, type: "start" });
  return { ok: true };
}

// Before the start, a player whose page has been closed for a while is away (the server decides when). Only colors
// with someone still here have to press Ready, so a player who leaves can't hold the game up. A color with nobody
// here when the game starts is out of it: its players become spectators, and can join again (late) if they return.
const playersOn = (room, color) => Object.values(room.players).filter((p) => p.color === color);
const hereColors = (room) => room.colors.filter((c) => playersOn(room, c).some((p) => !p.away));

function maybeStart(room, now) {
  if (room.started !== null) return false;
  const here = hereColors(room);
  if (!here.length || !here.every((c) => room.ready[c])) return false;
  for (const c of room.colors.filter((x) => !here.includes(x))) dropColor(room, c, now, true);
  for (const p of Object.values(room.players)) delete p.away;
  start(room, now);
  return true;
}

// Take a color out of a room that hasn't started. atStart: nobody on it was here when the game began (logged, and
// its players see why they're watching); otherwise its last player switched to another color.
function dropColor(room, color, now, atStart) {
  const left = playersOn(room, color);
  room.colors = room.colors.filter((c) => c !== color);
  for (const key of ["ready", "lens", "adj", "freeLeft", "homes"]) if (room[key]) delete room[key][color];
  for (const p of left) { p.color = null; if (atStart) p.dropped = true; }
  // Nothing has been revealed yet, so shared fog is just the remaining colors' starting squares.
  if (room.config.sharedFog) room.seen[SHARED] = [...new Set(room.colors.flatMap((c) => startingView(room, c)))].sort((a, b) => a - b);
  else delete room.seen[color];
  if (atStart) room.log.push({ at: now, type: "dropped", color, by: left.map((p) => p.name).join(", ") || null });
}

// The server calls this when a player's page has been closed for a while (away) or opens again. It only matters
// before the start, and going away can start the game, if everyone still here is ready.
function setAway(room, token, away, now) {
  const p = room.players[token];
  if (!p || room.started !== null || !!p.away === !!away) return { ok: true, changed: false, started: false };
  if (away) p.away = true;
  else delete p.away;
  return { ok: true, changed: true, started: maybeStart(room, now) };
}

// The game starts once every color with someone here is ready.
function setReady(room, color, ready, now) {
  if (room.started !== null) return err("The game has already started.");
  if (!room.colors.includes(color)) return err("Only players with a color can do that.");
  room.ready[color] = !!ready;
  return { ok: true, started: maybeStart(room, now) };
}

function checkCell(room, color, cell) {
  if (room.started === null) return "The game hasn't started yet.";
  if (room.ended) return "The game is over.";
  if (!room.colors.includes(color)) return "Only players with a color can do that.";
  if (!Number.isInteger(cell) || cell < 0 || cell >= geo(room).total) return "That isn't a square on this board.";
  return null;
}

function claim(room, color, cell, now, by, free = false) {
  const bad = checkCell(room, color, cell);
  if (bad) return err(bad);
  if (markOf(room, cell, color)) return err("You already have that square.");
  if (!canTake(room, color, cell)) return err("That square is already claimed.");
  if (!seenOf(room, color).includes(cell)) return err("You can't see that square.");
  if (free && !(room.freeLeft[color] > 0)) return err("You have no Free Squares left.");
  if (free) room.freeLeft[color] -= 1;
  // The claim waits claimDelay seconds before it takes effect (settle() does that). Until then only your color sees
  // it, nothing is revealed, and Undo (cancelClaim) takes it back without a trace.
  const mark = { color, at: now, by: by || null, free: !!free };
  const delay = (room.config.claimDelay || 0) * 1000;
  if (delay > 0) Object.assign(mark, { pending: true, until: now + delay });
  room.claims[cell] = marksOn(room, cell).concat([mark]);
  room.log.push(Object.assign({ at: now, type: "claim", color, cell, free: !!free, by: by || null }, delay > 0 ? { pending: true } : {}));
  if (delay > 0) return { ok: true, pending: true, until: mark.until, revealed: [], chest: false, granted: null };
  const res = takeEffect(room, cell, mark, now);
  checkEnd(room, now);
  return { ok: true, ...res };
}

// A claim becomes real: in lockout, other colors still waiting on the same square are sniped (the earliest click
// wins), then the claim's effect applies and everyone can see it.
function takeEffect(room, cell, mark, at) {
  if (room.config.lockout) {
    for (const other of marksOn(room, cell).filter((o) => o !== mark && o.pending)) {
      removeMark(room, cell, other.color);
      if (other.free) room.freeLeft[other.color] += 1;
      const e = claimEntry(room, other, cell);
      if (e) e.sniped = true;
      room.log.push({ at, type: "snipe", color: mark.color, by: mark.by, victim: other.color, victimBy: other.by, cell });
    }
  }
  if (room.undo && room.undo.color !== mark.color) room.undo = null; // the board moved on; ask again
  return applyClaim(room, cell, mark);
}
// The log entry of a claim (newest first).
function claimEntry(room, mark, cell) {
  for (let k = room.log.length - 1; k >= 0; k--) {
    const e = room.log[k];
    if (e.type === "claim" && e.color === mark.color && e.cell === cell && e.at === mark.at) return e;
  }
  return null;
}

// A claim's effect: reveal the squares around it or hand out reveals, plus a Bonus Reveal Square's +1. What it gave
// is recorded on the mark, so an undo can take back what's unspent.
function applyClaim(room, cell, mark) {
  const color = mark.color;
  const granted = { lens: 0, adj: 0 };
  let revealed = [];
  if (!mark.free || room.config.freeReveals) {
    const fx = claimEffect(room.config);
    if (fx.kind === "reveal") revealed = addSeen(room, color, neighbors(geo(room).n, cell, fx.n));
    else if (fx.kind === "free") granted.lens += fx.n;
    else granted.adj += fx.n;
  }
  const chest = room.chests.includes(cell);
  if (chest) granted.lens += 1;
  room.lens[color] = (room.lens[color] || 0) + granted.lens;
  room.adj = room.adj || {};
  room.adj[color] = (room.adj[color] || 0) + granted.adj;
  mark.granted = granted;
  delete mark.pending;
  delete mark.until;
  const e = claimEntry(room, mark, cell);
  if (e) { Object.assign(e, { revealed, chest, gained: granted }); delete e.pending; }
  return { revealed, chest, granted };
}

// Let every waiting claim whose wait is over take effect, earliest click first (all: every waiting claim, as when
// the game is ended). Returns how many took effect. The server calls this before each request and from a timer, so
// reveals land on time without a click.
function settle(room, now, all = false) {
  if (room.ended) return 0;
  const due = [];
  for (const [k, list] of Object.entries(room.claims)) for (const m of list) if (m.pending && (all || m.until <= now)) due.push([Number(k), m]);
  due.sort((a, b) => a[1].until - b[1].until || a[1].at - b[1].at);
  let n = 0;
  for (const [cell, m] of due) {
    if (!m.pending || !marksOn(room, cell).includes(m)) continue; // sniped earlier in this pass
    const at = Math.min(m.until, now);
    takeEffect(room, cell, m, at);
    n++;
    checkEnd(room, at);
    if (room.ended) break;
  }
  if (room.ended) dropPending(room);
  return n;
}
// When the next pending claim settles (ms), or null.
function nextPending(room) {
  const list = pendingMarks(room);
  return list.length && !room.ended ? Math.min(...list.map((m) => m.until)) : null;
}
// A goal ended the game while claims were still waiting: they never took effect, so they go (free squares back).
function dropPending(room) {
  for (const [k, list] of Object.entries(room.claims))
    for (const m of list.filter((x) => x.pending)) { removeMark(room, Number(k), m.color); if (m.free) room.freeLeft[m.color] += 1; }
}

// Undo inside the wait: the mark goes, a free square comes back, and nothing was revealed.
function cancelClaim(room, color, cell, now, by) {
  const bad = checkCell(room, color, cell);
  if (bad) return err(bad);
  const m = markOf(room, cell, color);
  if (!m) return err("You don't have that square.");
  if (!m.pending || m.until <= now) return err("Too late: that claim has already taken effect. Ask for an undo instead.");
  removeMark(room, cell, color);
  if (m.free) room.freeLeft[color] += 1;
  room.log.push({ at: now, type: "cancel", color, cell, by: by || null });
  return { ok: true };
}

// Free Reveal (called "lens" in the data): reveal any one square. You get a bonus one, even with Free Reveals off,
// when your color has nothing left to claim.
function useLens(room, color, cell, now, by) {
  const bad = checkCell(room, color, cell);
  if (bad) return err(bad);
  if (seenOf(room, color).includes(cell)) return err("You can already see that square.");
  const free = !(room.lens[color] > 0) && isStuck(room, color);
  if (!(room.lens[color] > 0) && !free) return err(room.config.lens ? "You have no Free Reveals left." : "Free Reveals are off in this room.");
  if (!free) room.lens[color] -= 1;
  addSeen(room, color, [cell]);
  room.log.push({ at: now, type: "lens", color, cell, free, by: by || null });
  return { ok: true, free };
}

// Adjacent reveal: reveal a fogged square touching (diagonals included) one of your color's squares.
function useAdjacent(room, color, cell, now, by) {
  const bad = checkCell(room, color, cell);
  if (bad) return err(bad);
  if (seenOf(room, color).includes(cell)) return err("You can already see that square.");
  if (!((room.adj && room.adj[color]) > 0)) return err("You have no adjacent reveals left.");
  if (!adjacentTargets(room, color).includes(cell)) return err("An adjacent reveal must touch one of your squares.");
  room.adj[color] -= 1;
  addSeen(room, color, [cell]);
  room.log.push({ at: now, type: "adj", color, cell, by: by || null });
  return { ok: true };
}

function requestUndo(room, color, cell, now, by) {
  if (room.ended) return err("The game is over.");
  const mark = markOf(room, cell, color);
  if (!mark) return err("You can only undo your own color's squares.");
  if (mark.pending) return err("That claim hasn't taken effect yet: use Undo to take it back.");
  room.undo = { color, cell, at: now, by: by || null };
  room.log.push({ at: now, type: "undo-request", color, cell, by: by || null });
  if (room.colors.length === 1) return answerUndo(room, color, true, now, null, true);
  return { ok: true, pending: true };
}

// Any other color can answer (solo games approve automatically). Squares stay revealed: you can't unsee.
function answerUndo(room, color, yes, now, by, auto) {
  const u = room.undo;
  if (!u) return err("There's no undo request to answer.");
  if (!auto && u.color === color) return err("Another color has to answer this.");
  room.undo = null;
  if (!yes) {
    room.log.push({ at: now, type: "undo-denied", color: u.color, cell: u.cell, by: by || null });
    return { ok: true, undone: false };
  }
  const m = markOf(room, u.cell, u.color);
  if (!m) return err("That square has changed.");
  takeBack(room, u.cell, u.color, m);
  room.log.push({ at: now, type: "undo", color: u.color, cell: u.cell, by: u.by });
  return { ok: true, undone: true };
}

// Removing a mark returns a free square and takes back whatever reveals the claim gave that are still unspent.
// Squares it revealed stay revealed.
function takeBack(room, cell, color, mark) {
  removeMark(room, cell, color);
  if (mark.free) room.freeLeft[color] += 1;
  const g = mark.granted || { lens: room.chests.includes(cell) ? 1 : 0, adj: 0 }; // marks saved before "granted" existed
  room.lens[color] -= Math.min(g.lens, room.lens[color] || 0);
  if (room.adj) room.adj[color] = (room.adj[color] || 0) - Math.min(g.adj, room.adj[color] || 0);
}

// Toggle your color's shared note symbol of one kind on a square. Each color has its own symbols, so a square can
// carry several: layer[cell] is a list of {kind, by, color}, at most one per kind per color. You can only take off
// your own color's symbols (a teammate on your color can take off yours); clicking a kind another color has put
// there adds yours next to it. Private symbols never reach the server.
function toggleNote(room, color, cell, kind, by) {
  if (!room.colors.includes(color)) return err("Only players with a color can do that.");
  if (!Number.isInteger(cell) || cell < 0 || cell >= geo(room).total) return err("That isn't a square on this board.");
  if (!NOTE_KINDS.includes(kind)) return err("Unknown symbol.");
  const scope = room.config.noteShare[kind];
  if (scope === "private") return err("That symbol is private in this room.");
  const key = scope === "team" ? color : "_all";
  room.notes = room.notes || {};
  const layer = (room.notes[key] = room.notes[key] || {});
  const list = noteList(layer[cell]);
  const rest = list.filter((n) => !(n.kind === kind && n.color === color));
  if (rest.length === list.length) rest.push({ kind, by: by || null, color });
  rest.sort((a, b) => NOTE_KINDS.indexOf(a.kind) - NOTE_KINDS.indexOf(b.kind) || room.colors.indexOf(a.color) - room.colors.indexOf(b.color));
  if (rest.length) layer[cell] = rest;
  else delete layer[cell];
  return { ok: true };
}
// Notes saved before a square could hold several symbols were a single object, and the square was a red star.
const noteList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
function upgradeNotes(room) {
  for (const layer of Object.values(room.notes || {}))
    for (const cell of Object.keys(layer)) layer[cell] = noteList(layer[cell]).map((n) => (OLD_NOTE_KINDS[n.kind] ? { ...n, kind: OLD_NOTE_KINDS[n.kind] } : n));
}

function endEarly(room, color, now, by) {
  if (room.started === null) return err("The game hasn't started yet.");
  if (room.ended) return err("The game is already over.");
  // Claims still waiting take effect now (earliest click first, snipes included), so a last-second claim counts.
  settle(room, now, true);
  if (room.ended) return { ok: true }; // a waiting claim just finished the goal
  if (room.config.goal === "open") {
    // The players' own rules decide the winner; the page just reports the counts.
    const tally = room.colors.map((c) => `${c.charAt(0).toUpperCase() + c.slice(1)} ${owned(room, c).length}`).join(", ");
    room.ended = { at: now, winner: null, reason: `ended by ${by || color} (squares: ${tally})`, cells: [] };
    room.log.push({ at: now, type: "end", winner: null, color, by: by || null });
    return { ok: true };
  }
  const res = leader(room);
  room.ended = { at: now, winner: res.winner, reason: `ended early by ${by || color}; ${res.reason}`, cells: [] };
  room.log.push({ at: now, type: "end", winner: res.winner, color, by: by || null });
  return { ok: true };
}

// --- winning ---------------------------------------------------------------------------------------------

// Squares a color holds. A claim still waiting doesn't count yet (counts are public, so this also keeps it secret).
function owned(room, color) {
  return Object.keys(room.claims).map(Number).filter((i) => { const m = markOf(room, i, color); return m && !m.pending; }).sort((a, b) => a - b);
}

// Solo: all 4. With lockout and 2+ colors the first to 2 corners has already won (the others can reach 2 at most,
// and a tie goes to whoever got there first), so the game ends right there instead of playing on. Without lockout
// nobody can be blocked, so 2 colors race to 3.
function cornersNeeded(room) {
  const n = room.colors.length;
  if (n <= 1) return 4;
  return room.config.lockout || n > 2 ? 2 : 3;
}

function completeShape(room, color) {
  const g = geo(room);
  const mine = new Set(owned(room, color));
  if (room.config.goal === "corners") {
    const got = g.corners.filter((i) => mine.has(i));
    return got.length >= cornersNeeded(room) ? { name: `${got.length} corners`, cells: got } : null;
  }
  const shapes = room.config.goal === "sprint" ? g.blocks : g.lines;
  return shapes.find((s) => s.cells.every((i) => mine.has(i))) || null;
}

function shapeStillPossible(room, color) {
  if (!room.config.lockout) return true; // nobody can block you without lockout
  const theirs = new Set(Object.keys(room.claims).map(Number).filter((i) => marksOn(room, i).some((m) => m.color !== color && !m.pending)));
  const g = geo(room);
  if (room.config.goal === "corners") return g.corners.filter((i) => !theirs.has(i)).length >= cornersNeeded(room);
  const shapes = room.config.goal === "sprint" ? g.blocks : g.lines;
  return shapes.some((s) => s.cells.every((i) => !theirs.has(i)));
}

// Most squares (corners, in Corners mode); on a tie, whoever reached that count first.
function leader(room) {
  const corners = room.config.goal === "corners";
  const unit = corners ? "corners" : "squares";
  const rows = room.colors.map((color) => {
    const cells = owned(room, color).filter((i) => !corners || geo(room).corners.includes(i));
    const reached = cells.length ? Math.max(...cells.map((i) => markOf(room, i, color).at)) : Infinity;
    return { color, n: cells.length, reached };
  });
  rows.sort((a, b) => b.n - a.n || a.reached - b.reached);
  if (rows.length === 0) return { winner: null, reason: "nobody joined" };
  if (rows.length === 1) return { winner: null, reason: `${rows[0].n} ${unit}` };
  const [a, b] = rows;
  if (a.n === 0) return { winner: null, reason: "nobody claimed anything" };
  const how = a.n > b.n ? `most ${unit} (${a.n}-${b.n})` : `tied ${a.n}-${b.n} on ${unit}, got there first`;
  return { winner: a.color, reason: how };
}

function checkEnd(room, now) {
  if (room.ended || room.config.goal === "open") return; // Open never ends by itself
  for (const color of room.colors) {
    const s = completeShape(room, color);
    if (s) {
      room.ended = { at: now, winner: color, reason: s.name, cells: s.cells };
      room.log.push({ at: now, type: "end", winner: color });
      return;
    }
  }
  if (room.colors.length > 1 && room.colors.every((c) => !shapeStillPossible(room, c))) {
    const res = leader(room);
    const what = { line: "line", sprint: "2x2 block", corners: "corner win" }[room.config.goal];
    room.ended = { at: now, winner: res.winner, reason: `no ${what} left for anyone; ${res.reason}`, cells: [] };
    room.log.push({ at: now, type: "end", winner: res.winner });
  }
}

// --- what each person is allowed to see -------------------------------------------------------------------

// color: the viewer's color, or null for a spectator. Players get only their color's visible squares; other
// claims show as color (and FREE) without text. Spectators, and everyone once the game ends, get the full card.
// A claim still waiting (and its Undo) exists only for the claimer's color: nobody else, spectators included, sees
// the mark, the log line, the square count or a spent free square until it takes effect.
function viewFor(room, color, now, extras = {}) {
  const isPlayer = !!color && room.colors.includes(color);
  const everything = !isPlayer || !!room.ended;
  const showBoard = room.started !== null || !!room.ended; // nobody sees the card before the start
  const seen = new Set(isPlayer ? seenOf(room, color) : []);
  const canRead = (i) => showBoard && (everything || seen.has(i));
  const mineOnly = (c) => isPlayer && c === color;
  const cells = [];
  for (let i = 0; i < geo(room).total; i++) {
    cells.push({
      i,
      name: canRead(i) ? room.board[i].name : null,
      // public, even under fog, once a claim takes effect; "until" = when your waiting claim takes effect
      marks: marksOn(room, i).filter((m) => !m.pending || mineOnly(m.color))
        .map((m) => (m.pending ? { color: m.color, free: !!m.free, by: m.by, pending: true, until: m.until } : { color: m.color, free: !!m.free, by: m.by })),
      seen: isPlayer ? seen.has(i) : true,
      chest: canRead(i) && room.chests.includes(i),
    });
  }
  // Other colors' free squares spent on claims that are still waiting are counted as unspent.
  const freeLeft = { ...room.freeLeft };
  for (const m of pendingMarks(room)) if (m.free && !mineOnly(m.color)) freeLeft[m.color] += 1;
  const hidden = (e) => ((e.type === "claim" && e.pending) || e.type === "cancel") && !mineOnly(e.color);
  const log = room.log.filter((e) => !hidden(e)).map((e) => {
    const out = { at: e.at, type: e.type, color: e.color, by: e.by || null };
    if (e.winner !== undefined) out.winner = e.winner;
    if (e.free) out.free = true;
    if (e.cell !== undefined) {
      const secretLens = (e.type === "lens" || e.type === "adj") && !everything && e.color !== color && !room.config.sharedFog;
      if (!secretLens) {
        out.cell = e.cell;
        if (canRead(e.cell)) out.name = room.board[e.cell].name;
      }
    }
    if (e.type === "claim" && e.chest && (everything || e.color === color)) out.chest = true;
    if (e.type === "claim" && e.gained && (everything || e.color === color)) out.gained = e.gained;
    if (e.type === "claim" && e.sniped) out.sniped = true;
    if (e.type === "snipe") Object.assign(out, { victim: e.victim, victimBy: e.victimBy || null });
    return out;
  });
  const view = {
    id: room.id,
    you: isPlayer ? { color } : { color: null, spectator: true },
    colors: room.colors,
    // "away": closed the page before the start, so they don't count for Ready
    players: Object.values(room.players).map((p) => (p.away && room.started === null ? { name: p.name, color: p.color, away: true } : { name: p.name, color: p.color })),
    config: room.config,
    goalText: GOALS[room.config.goal],
    filenameSeed: room.filenameSeed,
    started: room.started,
    ended: room.ended,
    now,
    cells,
    lens: { ...room.lens },
    adj: { ...(room.adj || {}) },
    adjTargets: isPlayer && room.started !== null && !room.ended && (room.adj || {})[color] > 0 ? adjacentTargets(room, color) : [],
    freeLeft,
    ready: { ...room.ready },
    counts: Object.fromEntries(room.colors.map((c) => [c, owned(room, c).length])),
    stuck: isPlayer && room.started !== null && !room.ended ? isStuck(room, color) : false,
    undo: room.undo,
    log,
    chestCount: room.chests.length,
    ...extras,
  };
  const notes = room.notes || {};
  view.notes = { all: notes._all || {}, team: isPlayer ? notes[color] || {} : {} };
  if (!isPlayer) view.notes.byColor = Object.fromEntries(room.colors.map((c) => [c, notes[c] || {}]));
  // Spectators get each color's revealed squares: for the color views, and for the Whole card's colored edges and
  // faded never-revealed squares (shared fog too, where every color's list is the same).
  if (!isPlayer) view.seenBy = Object.fromEntries(room.colors.map((c) => [c, seenOf(room, c)]));
  if (everything && showBoard) view.cardSeed = room.cardSeed;
  return view;
}

module.exports = {
  SIZES, COLORS, GOALS, NOTE_KINDS, ON_CLAIM, CLAIM_DELAY, MAX_CLAIM_DELAY,
  geometry, neighbors, claimEffect, normalizeConfig, configProblems, createRoom, upgradeRoom, join, start, setReady, claim, cancelClaim,
  settle, nextPending, setAway, toggleNote, useLens, useAdjacent, adjacentTargets, requestUndo, answerUndo, endEarly, viewFor, checkEnd, leader,
  claimable, seenOf, maxPlayers, recommendedPlayers,
};
