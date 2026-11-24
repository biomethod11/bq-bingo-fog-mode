// Fog Mode game simulator: plays bot games through the real rules (fog_logic.js) on real cards (board.js) to see
// how settings play out: game length, stalemates, players getting boxed in, unused reveals, first-player advantage.
//
//   node simulate.js                 # the standard 1v1 sweep over every setting, writes simulation_results.json
//   node simulate.js --games 400     # more games per setting
//   node simulate.js --players       # 2-10 players per board size, lockout on/off; writes simulation_players.json
//
// The page only offers Open now (players pick their own win condition). The bots race for the first line (or
// Sprint/Corners in the full sweep), the most common BingoSync format, as a stand-in.
//
// Model (assumptions, not measurements):
// - A goal of BingoSync difficulty tier t takes about 3 + 0.55*t minutes (tier 1 ~ 3.5 min, tier 13 ~ 10 min,
//   tier 25 ~ 17 min), times random noise (lognormal, about +/-35%). That puts a 5-square line near the 45-75 minute
//   range the design aimed for. Squares under fog are guessed at tier 13 plus 2 minutes of uncertainty.
// - Bots go for the cheapest finishable shape, block an opponent who is one square from winning (lockout), spend
//   reveals right away on the most useful fogged squares, take a free square on an expensive goal, and drop a goal
//   the moment someone else claims it (that time is "wasted"). Reveals take no time.
"use strict";

const Fog = require("./fog_logic");
const { loadGenerator } = require("./load_generator");

const cardFor = loadGenerator();
const CARDS = {};
for (const n of Fog.SIZES) CARDS[n] = Array.from({ length: 40 }, (_, k) => cardFor(String(1000 + k * 7919), n));

function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const minutesFor = (tier) => 3 + 0.55 * tier;
const UNKNOWN = minutesFor(13) + 2;

function playGame(config, cardIndex, seed, players = 2) {
  const rand = rngFor(seed);
  const n = config.size;
  const card = CARDS[n][cardIndex % CARDS[n].length];
  // claimDelay 0: the 5-second wait doesn't matter next to minutes per goal, and bots don't misclick.
  const room = Fog.createRoom({ id: "sim", board: card, cardSeed: "1", filenameSeed: "2", config: { claimDelay: 0, ...config }, now: 0, rand });
  if (config.tryOnClaim) room.config.onClaim = config.tryOnClaim; // test a claim effect the page doesn't offer (e.g. "free3")
  const colors = Fog.COLORS.slice(0, players);
  colors.forEach((c) => { const j = Fog.join(room, c, c, c, 0); if (!j.ok) throw new Error(j.error); });
  Fog.start(room, 0);
  const g = Fog.geometry(n);
  const goal = room.config.goal;
  const lockout = room.config.lockout;
  const stats = { bonus: 0, bonusBy: new Set(), wasted: 0, freeUsed: 0, revealsSpent: 0, abandons: 0 };
  const state = Object.fromEntries(colors.map((c) => [c, { at: 0, target: null, began: 0, need: 0 }]));

  const mine = (c, i) => (room.claims[i] || []).some((m) => m.color === c);
  const theirs = (c, i) => (room.claims[i] || []).some((m) => m.color !== c);
  const seen = (c) => new Set(Fog.seenOf(room, c));
  const est = (c, i, seenSet) => (seenSet.has(i) ? minutesFor(card[i].difficulty) : UNKNOWN);
  const shapes = goal === "sprint" ? g.blocks : g.lines;
  const feasible = (c, s) => !lockout || s.cells.every((i) => !theirs(c, i));
  const remainingCost = (c, s, seenSet, assume) => s.cells.reduce((t, i) => t + (mine(c, i) || i === assume ? 0 : est(c, i, seenSet)), 0);
  const cornersNeed = room.colors.length === 1 ? 4 : 3;
  const dist = (a, b) => Math.max(Math.abs(Math.floor(a / n) - Math.floor(b / n)), Math.abs((a % n) - (b % n)));
  const openCorners = (c) => g.corners.filter((k) => !mine(c, k) && (!lockout || !theirs(c, k)));

  // How useful it is to see (or claim) square i, for picking reveals.
  function value(c, i) {
    if (goal === "corners") return Math.max(0, n - Math.min(...openCorners(c).map((k) => dist(i, k)), n));
    let best = 0;
    for (const s of shapes) if (s.cells.includes(i) && feasible(c, s)) best = Math.max(best, 1 + s.cells.filter((j) => mine(c, j)).length);
    return best;
  }

  function spendReveals(c, now) {
    for (let guard = 0; guard < 40; guard++) {
      const view = seen(c);
      const fogged = [...Array(g.total).keys()].filter((i) => !view.has(i));
      if (!fogged.length) return;
      let spent = false;
      if ((room.adj[c] || 0) > 0) {
        const targets = Fog.adjacentTargets(room, c);
        if (targets.length) {
          const pick = targets.reduce((a, b) => (value(c, b) > value(c, a) ? b : a));
          spent = Fog.useAdjacent(room, c, pick, now, c).ok;
        }
      }
      if (!spent && (room.lens[c] || 0) > 0) {
        const pick = fogged.reduce((a, b) => (value(c, b) > value(c, a) ? b : a));
        spent = Fog.useLens(room, c, pick, now, c).ok;
      }
      if (!spent) return;
      stats.revealsSpent++;
    }
  }

  function chooseTarget(c) {
    const view = seen(c);
    const options = Fog.claimable(room, c);
    if (!options.length) return null;
    // Block: an opponent is one square from finishing and I can see that square.
    if (lockout && goal !== "corners") {
      for (const opp of colors) {
        if (opp === c) continue;
        for (const s of shapes) {
          if (!feasible(opp, s)) continue;
          const left = s.cells.filter((i) => !mine(opp, i));
          if (left.length === 1 && options.includes(left[0])) return left[0];
        }
      }
    }
    let best = null, bestScore = Infinity;
    for (const i of options) {
      let score;
      if (goal === "corners") {
        const oc = openCorners(c);
        score = oc.length ? Math.min(...oc.map((k) => dist(i, k))) * UNKNOWN + est(c, i, view) : est(c, i, view);
      } else {
        score = Infinity;
        for (const s of shapes) if (s.cells.includes(i) && feasible(c, s)) score = Math.min(score, remainingCost(c, s, view, -1));
        if (score === Infinity) score = 1e6 + est(c, i, view); // nothing finishable through it: last resort
      }
      score += est(c, i, view) * 0.01;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function decide(c, now) {
    spendReveals(c, now);
    let target = chooseTarget(c);
    if (target === null) {
      // Boxed in: the rules give a bonus Free Reveal.
      const view = seen(c);
      const fogged = [...Array(g.total).keys()].filter((i) => !view.has(i));
      if (fogged.length) {
        const pick = fogged.reduce((a, b) => (value(c, b) > value(c, a) ? b : a));
        const r = Fog.useLens(room, c, pick, now, c);
        if (r.ok && r.free) { stats.bonus++; stats.bonusBy.add(c); }
        if (r.ok) target = chooseTarget(c);
      }
    }
    const st = state[c];
    if (target === null) { st.target = null; st.at = Infinity; return; }
    const need = minutesFor(card[target].difficulty) * Math.exp(0.35 * gauss(rand));
    if ((room.freeLeft[c] || 0) > 0 && card[target].difficulty >= 17) {
      Fog.claim(room, c, target, now, c, true);
      stats.freeUsed++;
      return decide(c, now);
    }
    Object.assign(st, { target, began: now, at: now + need });
  }

  colors.forEach((c) => decide(c, 0));
  const LIMIT = 6 * 60;
  while (!room.ended) {
    const c = colors.reduce((a, b) => (state[b].at < state[a].at ? b : a));
    const st = state[c];
    if (st.at === Infinity) return { result: "deadlock", minutes: null, room, stats };
    const now = st.at;
    if (now > LIMIT) return { result: "timeout", minutes: LIMIT, room, stats };
    const r = Fog.claim(room, c, st.target, now, c);
    if (r.ok) {
      // Anyone else working on that square sees the claim and drops it (lockout).
      for (const o of colors) {
        if (o !== c && lockout && state[o].target === st.target) {
          stats.wasted += now - state[o].began;
          stats.abandons++;
          decide(o, now);
        }
      }
    }
    decide(c, now);
    // A claim can open up a square for an opponent who had nothing to do.
    for (const o of colors) if (o !== c && state[o].at === Infinity) decide(o, now);
  }
  const reason = room.ended.cells.length ? "shape" : "stalemate";
  return { result: reason, winner: room.ended.winner, minutes: room.ended.at, room, stats, colors };
}

function summarize(config, games, seedBase, players = 2) {
  const rows = [];
  for (let k = 0; k < games; k++) rows.push(playGame(config, k, seedBase + k * 7, players));
  const finished = rows.filter((r) => r.minutes !== null).map((r) => r.minutes).sort((a, b) => a - b);
  const pct = (p) => finished.length ? Math.round(finished[Math.min(finished.length - 1, Math.floor(p * finished.length))]) : NaN;
  const count = (f) => rows.filter(f).length / rows.length;
  const avg = (f) => rows.reduce((t, r) => t + f(r), 0) / rows.length;
  const decided = rows.filter((r) => r.winner);
  const each = (r, f) => r.colors.reduce((t, c) => t + f(c), 0);
  // Per player: share of the board seen by the end, unspent reveals, squares claimed, time lost to goals someone else got first.
  const seenFrac = avg((r) => each(r, (c) => Fog.seenOf(r.room, c).length) / (r.colors.length * r.room.board.length));
  const unspent = avg((r) => each(r, (c) => (r.room.lens[c] || 0) + (r.room.adj[c] || 0)) / r.colors.length);
  return {
    players, median: pct(0.5), p90: pct(0.9),
    stalemate: count((r) => r.result === "stalemate"), timeout: count((r) => r.result === "timeout"), deadlock: count((r) => r.result === "deadlock"),
    firstWins: decided.length ? decided.filter((r) => r.winner === r.colors[0]).length / decided.length : NaN,
    // boxedIn: share of players boxed in at least once; bonus: bonus Free Reveals per player
    boxedIn: avg((r) => r.stats.bonusBy.size / r.colors.length), bonus: avg((r) => r.stats.bonus / r.colors.length),
    wasted: avg((r) => r.stats.wasted / r.colors.length), seen: seenFrac, unspent,
    claims: avg((r) => Object.keys(r.room.claims).length),
    perPlayer: avg((r) => each(r, (c) => Object.values(r.room.claims).filter((l) => l.some((m) => m.color === c)).length) / r.colors.length),
  };
}

// A player count works when the fog still matters and the board isn't too crowded: under 10% of games end with no
// line left for anyone, under 10% of players get boxed in, and players see at most 85% of the board by the end.
const PLAYS_WELL = (s) => s.stalemate < 0.1 && s.boxedIn < 0.1 && s.seen <= 0.85;

// How many players a board takes: 2 up to the room limit (lockout 4; non-lockout every color), private and shared
// fog. Reveals 4, except 4x4 shared fog, which only allows 1 reveal per claim (Free 1 there).
function playerSweep(games) {
  const out = [];
  const rec = {};
  const pc = (x) => (Number.isNaN(x) ? "  -" : `${Math.round(100 * x)}%`.padStart(4));
  console.log(`${games} games per row. Bots race for the first line.\n`);
  console.log("size lock shared effect  players median  p90 stalemate boxedIn bonus/pl wasted/pl seen sq/player board ok");
  let seed = 7;
  for (const size of [4, 5, 6])
    for (const lockout of [true, false])
      for (const sharedFog of [false, true]) {
        const onClaim = size === 4 && sharedFog ? "free1" : "reveal4";
        const top = lockout ? Fog.maxPlayers({ lockout }) : Fog.COLORS.length;
        const key = `${size}|${lockout ? "lockout" : "nonLockout"}|${sharedFog ? "shared" : "private"}`;
        rec[key] = 1;
        for (let players = 2; players <= top; players++) {
          const config = { size, goal: "line", lockout, sharedFog, onClaim };
          const s = summarize(config, games, (seed += 100003), players);
          const ok = PLAYS_WELL(s);
          if (ok && rec[key] === players - 1) rec[key] = players;
          out.push({ config, ...s, ok });
          console.log(`${size}x${size} ${lockout ? "on " : "off"}  ${sharedFog ? "yes" : "no "}    ${onClaim.padEnd(7)} ${String(players).padStart(4)}   ${String(s.median).padStart(5)} ${String(s.p90).padStart(4)}   ${pc(s.stalemate)}     ${pc(s.boxedIn)}  ${s.bonus.toFixed(2).padStart(6)}  ${s.wasted.toFixed(1).padStart(7)}  ${pc(s.seen)}  ${s.perPlayer.toFixed(1).padStart(5)}  ${pc(s.claims / (size * size))}  ${ok ? "yes" : "no"}`);
        }
      }
  console.log("\nRecommended most players (largest count from 2 up where every smaller count also plays well):");
  for (const [k, v] of Object.entries(rec)) console.log(`  ${k.padEnd(24)} ${v < 2 ? "2 (even 2 misses the bar)" : v}`);
  require("fs").writeFileSync(require("path").join(__dirname, "simulation_players.json"), JSON.stringify({ rows: out, recommended: rec }, null, 1));
  console.log("\nwrote simulation_players.json");
}

if (require.main === module && process.argv.includes("--players")) {
  const gi = process.argv.indexOf("--games");
  playerSweep(gi > 0 ? Number(process.argv[gi + 1]) : 400);
} else if (require.main === module) {
  const gi = process.argv.indexOf("--games");
  const GAMES = gi > 0 ? Number(process.argv[gi + 1]) : 200;
  const effects = Fog.ON_CLAIM;
  const out = [];
  const pc = (x) => (Number.isNaN(x) ? "  -" : `${Math.round(100 * x)}%`.padStart(4));
  console.log(`${GAMES} games per row. Minutes are simulated (see the model notes at the top of simulate.js).\n`);
  console.log("size goal     lock shared effect   median  p90  stalemate timeout deadlock 1stWin boxedIn wasted seen unspent claims");
  let seed = 1;
  for (const size of [4, 5, 6])
    for (const goal of ["line", "sprint", "corners"])
      for (const lockout of [true, false])
        for (const sharedFog of [false, true])
          for (const onClaim of effects) {
            const config = { size, goal, lockout, sharedFog, onClaim };
            const s = summarize(config, GAMES, (seed += 100003));
            out.push({ config, ...s });
            console.log(`${size}x${size} ${goal.padEnd(8)} ${lockout ? "on " : "off"}  ${sharedFog ? "yes" : "no "}    ${onClaim.padEnd(8)} ${String(s.median).padStart(5)} ${String(s.p90).padStart(4)}   ${pc(s.stalemate)}     ${pc(s.timeout)}   ${pc(s.deadlock)}   ${pc(s.firstWins)}  ${pc(s.boxedIn)}  ${s.wasted.toFixed(1).padStart(5)} ${pc(s.seen)}  ${s.unspent.toFixed(1).padStart(5)} ${s.claims.toFixed(1).padStart(5)}`);
          }
  require("fs").writeFileSync(require("path").join(__dirname, "simulation_results.json"), JSON.stringify(out, null, 1));
  console.log("\nwrote simulation_results.json");
}

module.exports = { playGame, summarize, playerSweep };
