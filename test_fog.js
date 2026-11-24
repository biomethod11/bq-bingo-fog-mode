// Tests for Beta Quest Bingo Fog Mode: rules (fog_logic.js) and the server (fog_server.js), using the real BingoSync
// generator.
//   node test_fog.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Fog = require("./fog_logic");
const { loadGenerator } = require("./load_generator");
const { createServer } = require("./fog_server");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); }
}

const fakeBoardOf = (n) => Array.from({ length: n * n }, (_, i) => ({ name: `Goal ${i}`, difficulty: i + 1, types: [] }));
const fakeBoard = fakeBoardOf(5);
// A started room with Ann on red and Bo on blue (pass colors: ["red"] for solo). Most rules tests want fixed start
// squares (corners in join order: top-left, bottom-right, top-right, bottom-left), Line as the goal and instant
// claims; pass randomStarts / goal / claimDelay to test the real thing.
const mk = (config = {}, { colors = ["red", "blue"], rand = () => 0.5, started = true, randomStarts = false } = {}) => {
  const room = Fog.createRoom({ id: "t", board: fakeBoardOf(Number(config.size) || 5), cardSeed: "111", filenameSeed: "222", config: { goal: "line", claimDelay: 0, ...config }, now: 0, rand });
  if (!randomStarts) { const g = Fog.geometry(room.config.size); room.starts = [...g.homes, ...g.border.filter((i) => !g.homes.includes(i))]; }
  const names = { red: "Ann", blue: "Bo", green: "Cy", orange: "Di", pink: "Pi" };
  colors.forEach((c) => Fog.join(room, `tok-${c}`, names[c] || cap(c), c, 0));
  if (started) Fog.start(room, 1000);
  return room;
};
const cap = (c) => c.charAt(0).toUpperCase() + c.slice(1);
let t = 1000;
const claim = (room, color, cell, free = false) => { const r = Fog.claim(room, color, cell, (t += 1000), color, free); assert.ok(r.ok, r.error); return r; };
const walk = (room, color, cells) => cells.forEach((c) => claim(room, color, c));

(async () => {
  console.log("rules");

  await check("defaults: Open, Free Reveals off, no free squares, private fog, Reveal 4, 5-second claim wait", () => {
    const c = Fog.normalizeConfig({});
    assert.deepStrictEqual(c, { goal: "open", size: 5, onClaim: "reveal4", sharedFog: false, lens: 0, chests: 0, free: 0, freeReveals: true, lockout: true,
      noteShare: { silver: "private", square: "private", x: "private", circle: "private" }, claimDelay: 5 });
    assert.strictEqual(Fog.normalizeConfig({ chests: 3 }).chests, 3, "Bonus Reveal Squares no longer need Free Reveals on");
    assert.strictEqual(Fog.normalizeConfig({ lens: 5 }).lens, 3, "starting Free Reveals: 1-3");
  });

  await check("join: nickname + preset color; start squares in join order; spectators have no color", () => {
    const r = mk({ lockout: false }, { colors: ["blue", "red", "green", "orange"], started: false }); // non-lockout: room for a 5th player
    assert.deepStrictEqual(r.colors, ["blue", "red", "green", "orange"]);
    assert.deepStrictEqual(Fog.seenOf(r, "blue"), [0, 12]);
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [12, 24]);
    assert.deepStrictEqual(Fog.seenOf(r, "green"), [4, 12]);
    assert.deepStrictEqual(Fog.seenOf(r, "orange"), [12, 20]);
    assert.strictEqual(Fog.join(r, "x", "", "red", 0).ok, false, "needs a nickname");
    assert.strictEqual(Fog.join(r, "x", "Eve", "magenta", 0).ok, false, "preset colors only");
    assert.strictEqual(Fog.join(r, "x", "Eve", "navy", 0).ok, false, "navy was dropped (too close to blue)");
    assert.deepStrictEqual(Fog.COLORS, ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "white"]);
    assert.ok(Fog.join(r, "s", "Watcher", null, 0).ok);
    assert.strictEqual(r.colors.length, 4, "spectator adds no color");
    assert.ok(Fog.join(r, "y", "Ann2", "red", 0).ok, "teammate on an existing color");
    assert.strictEqual(r.colors.length, 4);
  });

  await check("ready: starts when every joined color is ready", () => {
    const r = mk({}, { started: false });
    assert.strictEqual(Fog.setReady(r, "red", true, 5).started, false);
    assert.strictEqual(Fog.setReady(r, "blue", true, 6).started, true);
    assert.strictEqual(r.started, 6);
  });

  await check("ready: a player who left doesn't count; the game starts without them and they watch (or join late)", () => {
    const r = mk({}, { colors: ["red", "blue", "green"], started: false });
    Fog.setReady(r, "red", true, 5);
    Fog.setReady(r, "green", true, 6);
    assert.strictEqual(r.started, null, "waiting for blue");
    const gone = Fog.setAway(r, "tok-blue", true, 7);
    assert.ok(gone.changed && gone.started, "blue left and everyone still here is ready: go");
    assert.strictEqual(r.started, 7);
    assert.deepStrictEqual(r.colors, ["red", "green"]);
    assert.deepStrictEqual([r.players["tok-blue"].color, r.players["tok-blue"].dropped], [null, true], "Bo is a spectator now");
    assert.strictEqual(r.homes.blue, undefined);
    assert.strictEqual(r.seen.blue, undefined);
    assert.ok(r.log.some((e) => e.type === "dropped" && e.color === "blue" && e.by === "Bo"));
    assert.ok(Object.values(r.players).every((p) => !p.away), "away only means something before the start");
    assert.strictEqual(Fog.setAway(r, "tok-red", true, 8).changed, false, "and isn't tracked after it");
    assert.ok(Fog.join(r, "tok-blue", "Bo", "blue", 9).ok, "Bo comes back and joins late");
    assert.ok(r.colors.includes("blue") && !r.players["tok-blue"].dropped && r.log.some((e) => e.type === "join-late"));
  });

  await check("ready: back before the start counts again; a teammate keeps a color in; nobody here never starts", () => {
    const r = mk({}, { started: false });
    Fog.setAway(r, "tok-blue", true, 5);
    assert.deepStrictEqual(Fog.viewFor(r, "red", 5).players.find((p) => p.name === "Bo").away, true, "shown as away");
    Fog.setAway(r, "tok-blue", false, 6);
    assert.strictEqual(Fog.setReady(r, "red", true, 7).started, false, "Bo is back, so Bo counts again");
    const t2 = mk({}, { started: false });
    Fog.join(t2, "tok-red2", "Ann2", "red", 0);
    Fog.setAway(t2, "tok-red", true, 5); // Ann left, her teammate is still here
    Fog.setReady(t2, "blue", true, 6);
    assert.strictEqual(t2.started, null, "red still has to be ready");
    Fog.setReady(t2, "red", true, 7);
    assert.ok(t2.started !== null && t2.colors.includes("red") && t2.players["tok-red"].color === "red", "red plays; Ann keeps her color");
    const t3 = mk({}, { colors: ["red"], started: false });
    Fog.setReady(t3, "red", true, 5);
    Fog.setReady(t3, "red", false, 6);
    assert.strictEqual(Fog.setAway(t3, "tok-red", true, 7).started, false, "an empty room doesn't start itself");
  });

  await check("ready: switching color before the start drops the color nobody is on any more", () => {
    const r = mk({}, { started: false });
    const blueHome = r.homes.blue;
    assert.ok(Fog.join(r, "tok-blue", "Bo", "green", 1).ok);
    assert.deepStrictEqual(r.colors, ["red", "green"], "blue would otherwise block Ready forever");
    assert.strictEqual(r.homes.blue, undefined);
    assert.ok(!r.log.some((e) => e.type === "dropped"), "nothing to log: Bo is still playing");
    Fog.setReady(r, "red", true, 2);
    assert.strictEqual(Fog.setReady(r, "green", true, 3).started, true);
    assert.strictEqual(r.homes.green, blueHome, "Bo keeps the same start square");
    // Shared fog, a color dropped at the start: its start square is no longer part of what everyone sees.
    const s = mk({ sharedFog: true }, { started: false });
    const sharedBlueHome = s.homes.blue;
    Fog.setAway(s, "tok-blue", true, 1);
    Fog.setReady(s, "red", true, 2);
    assert.ok(s.started !== null);
    assert.deepStrictEqual(Fog.seenOf(s, "red"), [s.homes.red, 12].sort((a, b) => a - b));
    assert.ok(!Fog.seenOf(s, "red").includes(sharedBlueHome));
  });

  await check("can't claim before start, or a fogged square", () => {
    const r = mk({}, { started: false });
    assert.strictEqual(Fog.claim(r, "red", 0, 1).ok, false);
    Fog.start(r, 1);
    assert.strictEqual(Fog.claim(r, "red", 1, 2).error, "You can't see that square.");
    assert.strictEqual(Fog.claim(r, "red", 0, 2).ok, true, "your start square is claimable");
  });

  await check("claim reveals 4 neighbors to your color only (8 with reveal=8)", () => {
    const r = mk();
    assert.deepStrictEqual(claim(r, "red", 12).revealed.sort((a, b) => a - b), [7, 11, 13, 17]);
    assert.ok(!Fog.seenOf(r, "blue").includes(7));
    assert.strictEqual(claim(mk({ reveal: 8 }), "red", 12).revealed.length, 8);
  });

  await check("shared fog: one view for everyone, starting with all homes", () => {
    const r = mk({ sharedFog: true });
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [0, 12, 24]);
    claim(r, "red", 12);
    assert.deepStrictEqual(Fog.seenOf(r, "blue"), Fog.seenOf(r, "red"));
    assert.ok(Fog.seenOf(r, "blue").includes(7));
    claim(r, "blue", 7); // blue can claim what red revealed
    const v = Fog.viewFor(r, "blue", 1);
    assert.strictEqual(v.seenBy, undefined);
    // Spectators still learn what has been revealed (for the Whole card's fading), the same list for every color.
    const sp = Fog.viewFor(r, null, 1);
    assert.deepStrictEqual(sp.seenBy.red, Fog.seenOf(r, "red"));
    assert.deepStrictEqual(sp.seenBy.blue, sp.seenBy.red);
  });

  await check("free square: counts, shown as free, limited, optional reveal", () => {
    const r = mk({ free: 1, freeReveals: false });
    const res = claim(r, "red", 0, true);
    assert.deepStrictEqual(res.revealed, [], "no reveal when freeReveals is off");
    assert.strictEqual(r.claims[0][0].free, true);
    assert.strictEqual(r.freeLeft.red, 0);
    assert.strictEqual(Fog.claim(r, "red", 12, 5, "Ann", true).error, "You have no Free Squares left.");
    const v = Fog.viewFor(r, "blue", 1);
    assert.strictEqual(v.cells[0].marks[0].color, "red");
    assert.strictEqual(v.cells[0].marks[0].free, true, "blue can tell it was free, even under fog");
    assert.strictEqual(v.cells[0].name, null);
    const r2 = mk({ free: 2 });
    assert.strictEqual(claim(r2, "red", 0, true).revealed.length, 2, "reveals when freeReveals is on");
    assert.strictEqual(Fog.claim(mk(), "red", 0, 5, "Ann", true).error, "You have no Free Squares left.", "off by default");
  });

  await check("free square undo gives the free square back", () => {
    const r = mk({ free: 1 });
    claim(r, "red", 0, true);
    Fog.requestUndo(r, "red", 0, 1, "Ann");
    assert.ok(Fog.answerUndo(r, "blue", true, 2, "Bo").undone);
    assert.strictEqual(r.freeLeft.red, 1);
  });

  await check("lockout: first line wins; no claims after", () => {
    const r = mk();
    walk(r, "red", [0, 5, 10, 15]);
    assert.strictEqual(r.ended, null);
    claim(r, "red", 20);
    assert.strictEqual(r.ended.winner, "red");
    assert.deepStrictEqual(r.ended.cells, [0, 5, 10, 15, 20]);
    assert.strictEqual(Fog.claim(r, "blue", 24, 99999).ok, false);
  });

  await check("free squares count toward a line", () => {
    const r = mk({ free: 1 });
    claim(r, "red", 0, true);
    walk(r, "red", [5, 10, 15, 20]);
    assert.strictEqual(r.ended.winner, "red");
  });

  await check("Free Reveals off: none, except a bonus one when boxed in", () => {
    const r = mk();
    assert.strictEqual(Fog.useLens(r, "red", 22, 2).error, "Free Reveals are off in this room.");
    claim(r, "blue", 12);
    claim(r, "red", 0);
    r.claims[1] = [{ color: "blue", at: 1 }]; r.claims[5] = [{ color: "blue", at: 1 }];
    assert.deepStrictEqual(Fog.claimable(r, "red"), []);
    const res = Fog.useLens(r, "red", 2, 9000);
    assert.ok(res.ok && res.free);
  });

  await check("Free Reveals on: private reveal, limited; chest gives +1 and undo takes it back", () => {
    const r = mk({ lens: 1, chests: 1 }, { rand: () => 0 });
    assert.ok(Fog.useLens(r, "red", 22, 2).ok);
    assert.ok(Fog.seenOf(r, "red").includes(22) && !Fog.seenOf(r, "blue").includes(22));
    assert.strictEqual(Fog.useLens(r, "red", 23, 3).error, "You have no Free Reveals left.");
    const chest = r.chests[0];
    Fog.seenOf(r, "red").push(chest);
    claim(r, "red", chest);
    assert.strictEqual(r.lens.red, 1);
    Fog.requestUndo(r, "red", chest, 4);
    Fog.answerUndo(r, "blue", true, 5);
    assert.strictEqual(r.lens.red, 0);
  });

  await check("undo: another color approves; deny keeps the claim; solo is automatic", () => {
    const r = mk();
    claim(r, "red", 0);
    assert.ok(Fog.requestUndo(r, "red", 0, 1).pending);
    assert.strictEqual(Fog.answerUndo(r, "red", true, 2).ok, false);
    assert.strictEqual(Fog.answerUndo(r, "blue", false, 3).undone, false);
    Fog.requestUndo(r, "red", 0, 4);
    assert.strictEqual(Fog.answerUndo(r, "blue", true, 5).undone, true);
    assert.ok(!r.claims[0] && Fog.seenOf(r, "red").includes(1), "reveals stay");
    const s = mk({}, { colors: ["red"] });
    claim(s, "red", 0);
    assert.ok(Fog.requestUndo(s, "red", 0, 1).undone);
  });

  await check("sprint and corners", () => {
    const r = mk({ goal: "sprint" });
    walk(r, "red", [0, 1, 5, 6]);
    assert.strictEqual(r.ended.winner, "red");
    const c = mk({ goal: "corners" });
    assert.deepStrictEqual(Fog.seenOf(c, "red"), [10, 11, 12, 13, 14]);
    walk(c, "red", [10, 5, 0, 14, 9]);
    assert.strictEqual(c.ended, null, "1 corner isn't enough");
    claim(c, "red", 4);
    assert.strictEqual(c.ended.winner, "red", "lockout versus: first to 2 corners (that player can't lose any more)");
    const nl = mk({ goal: "corners", lockout: false });
    walk(nl, "red", [10, 5, 0, 14, 9, 4]);
    assert.strictEqual(nl.ended, null, "without lockout, 2 colors need 3");
    walk(nl, "red", [15, 20]);
    assert.strictEqual(nl.ended.winner, "red");
    const s = mk({ goal: "corners" }, { colors: ["red"] });
    walk(s, "red", [10, 5, 0, 14, 9, 4, 15, 20]);
    assert.strictEqual(s.ended, null);
    walk(s, "red", [19, 24]);
    assert.strictEqual(s.ended.winner, "red", "solo: all 4");
  });

  await check("open: a line, a stalemate or a full board never ends it; End reports counts, no winner", () => {
    const r = mk({ goal: "open" });
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [0, 12], "starts like Line");
    walk(r, "red", [0, 5, 10, 15, 20]);
    assert.strictEqual(r.ended, null, "a full line doesn't end Open");
    for (let i = 0; i < 25; i++) if (!r.claims[i]) r.claims[i] = [{ color: i % 2 ? "red" : "blue", at: 1 }];
    Fog.checkEnd(r, 9);
    assert.strictEqual(r.ended, null, "a full board doesn't end Open");
    assert.ok(Fog.endEarly(r, "blue", 10, "Bo").ok);
    assert.strictEqual(r.ended.winner, null);
    assert.strictEqual(r.ended.reason, "ended by Bo (squares: Red 15, Blue 10)");
    const s = mk({ goal: "open" }, { colors: ["red"] });
    walk(s, "red", [0, 1, 2, 3, 4]);
    assert.strictEqual(s.ended, null, "solo blackout keeps going");
  });

  await check("non-lockout: colors share squares, no blocking, both can finish a line", () => {
    const r = mk({ lockout: false, reveal: 8 });
    claim(r, "red", 12);
    claim(r, "blue", 12);
    assert.deepStrictEqual(r.claims[12].map((m) => m.color), ["red", "blue"]);
    assert.strictEqual(Fog.claim(r, "red", 12, 5, "Ann").error, "You already have that square.");
    const v = Fog.viewFor(r, "red", 6);
    assert.deepStrictEqual(v.cells[12].marks.map((m) => m.color), ["red", "blue"]);
    walk(r, "blue", [18, 24, 6]);
    assert.strictEqual(r.ended, null);
    claim(r, "blue", 0);
    assert.strictEqual(r.ended.winner, "blue", "blue's diagonal through a shared center counts");
    const lock = mk();
    claim(lock, "red", 12);
    assert.strictEqual(Fog.claim(lock, "blue", 12, 5, "Bo").error, "That square is already claimed.", "lockout still blocks");
  });

  await check("claim wait: your color sees the mark at once, its reveals land 5 s later; Undo inside the wait reveals nothing", () => {
    const r = mk({ claimDelay: 5, free: 1, chests: 1 }, { rand: () => 0.99 });
    const res = Fog.claim(r, "red", 12, 10_000, "Ann");
    assert.ok(res.ok && res.pending && res.until === 15_000);
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [0, 12], "nothing revealed yet");
    assert.deepStrictEqual(Fog.viewFor(r, "red", 11_000).cells[12].marks, [{ color: "red", free: false, by: "Ann", pending: true, until: 15_000 }], "the claimer sees it, waiting");
    assert.match(Fog.requestUndo(r, "red", 12, 12_000).error, /hasn't taken effect yet/);
    assert.strictEqual(Fog.settle(r, 14_999), 0, "not yet");
    assert.strictEqual(Fog.nextPending(r), 15_000);
    assert.ok(Fog.cancelClaim(r, "red", 12, 14_000, "Ann").ok);
    assert.strictEqual(r.claims[12], undefined, "Undo removes the mark");
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [0, 12], "and nothing was revealed");
    assert.strictEqual(Fog.nextPending(r), null);
    assert.strictEqual(Fog.viewFor(r, "red", 14_001).log.at(-1).type, "cancel", "your log shows the Undo");
    assert.ok(!Fog.viewFor(r, "blue", 14_001).log.some((e) => e.type === "claim" || e.type === "cancel"), "nobody else ever saw the claim");
    // A free square: Undo in the wait gives it back.
    Fog.claim(r, "red", 0, 20_000, "Ann", true);
    assert.strictEqual(r.freeLeft.red, 0);
    assert.ok(Fog.cancelClaim(r, "red", 0, 21_000, "Ann").ok);
    assert.strictEqual(r.freeLeft.red, 1);
    // Let one settle: reveals land, the claim's log entry gets what it gave, and Undo is too late.
    Fog.claim(r, "red", 12, 30_000, "Ann");
    assert.strictEqual(Fog.settle(r, 35_000), 1);
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [0, 7, 11, 12, 13, 17]);
    assert.strictEqual(r.claims[12][0].pending, undefined);
    assert.deepStrictEqual(r.claims[12][0].granted, { lens: 0, adj: 0 });
    assert.match(Fog.cancelClaim(r, "red", 12, 36_000).error, /Too late/);
    assert.ok(Fog.requestUndo(r, "red", 12, 36_000).pending, "after the wait: ask for an undo");
  });

  await check("claim wait: Choose/Free tokens and a Bonus Reveal Square's +1 arrive with the reveals; not boxed in while waiting", () => {
    const r = mk({ claimDelay: 5, onClaim: "adj2" });
    Fog.claim(r, "red", 0, 1000, "Ann");
    assert.strictEqual(r.adj.red, 0, "tokens wait too");
    r.claims[12] = [{ color: "blue", at: 1 }]; // red has nothing else to claim
    assert.strictEqual(Fog.viewFor(r, "red", 2000).stuck, false, "a waiting claim isn't boxed in");
    Fog.settle(r, 6000);
    assert.strictEqual(r.adj.red, 2);
    const red = Fog.viewFor(r, "red", 7000);
    assert.deepStrictEqual(red.log.find((e) => e.type === "claim" && e.cell === 0).gained, { lens: 0, adj: 2 }, "your log shows what the claim gave");
    const c = mk({ claimDelay: 5, chests: 1 }, { rand: () => 0 });
    const chest = c.chests[0];
    Fog.seenOf(c, "red").push(chest);
    Fog.claim(c, "red", chest, 1000);
    assert.strictEqual(c.lens.red || 0, 0);
    Fog.settle(c, 6000);
    assert.strictEqual(c.lens.red, 1);
  });

  await check("waiting claims are hidden: no mark, log line, square count or spent free square for anyone else", () => {
    const r = mk({ claimDelay: 5, free: 1 });
    Fog.claim(r, "red", 12, 1000, "Ann", true);
    for (const who of ["blue", null]) {
      const v = Fog.viewFor(r, who, 1500);
      assert.deepStrictEqual(v.cells[12].marks, [], `${who || "spectator"}: no mark`);
      assert.ok(!v.log.some((e) => e.type === "claim"), `${who || "spectator"}: no log line`);
      assert.strictEqual(v.counts.red, 0, "no square count");
      assert.strictEqual(v.freeLeft.red, 1, "the free square still looks unspent");
    }
    const mine = Fog.viewFor(r, "red", 1500);
    assert.strictEqual(mine.freeLeft.red, 0, "you see your own free square spent");
    assert.strictEqual(mine.counts.red, 0, "counts only include claims that took effect");
    Fog.settle(r, 6000);
    const after = Fog.viewFor(r, "blue", 6500);
    assert.strictEqual(after.cells[12].marks[0].color, "red");
    assert.strictEqual(after.counts.red, 1);
    assert.strictEqual(after.log.filter((e) => e.type === "claim").length, 1, "the claim shows once it takes effect");
  });

  await check("snipes (lockout): two colors on one square within the wait, the first click gets it", () => {
    const r = mk({ claimDelay: 5, free: 1 });
    Fog.claim(r, "red", 12, 1000, "Ann");
    const b = Fog.claim(r, "blue", 12, 2000, "Bo", true);
    assert.ok(b.ok && b.pending, "blue can go for a square red is waiting on (blue can't know)");
    assert.strictEqual(Fog.claim(r, "red", 12, 2500, "Ann").error, "You already have that square.");
    assert.strictEqual(Fog.settle(r, 6000), 1, "red's earlier click takes effect");
    assert.deepStrictEqual(r.claims[12].map((m) => [m.color, m.pending]), [["red", undefined]], "blue's claim is gone");
    assert.strictEqual(r.freeLeft.blue, 1, "blue's free square comes back");
    assert.ok(!Fog.seenOf(r, "blue").includes(7), "the sniped claim revealed nothing");
    assert.strictEqual(Fog.nextPending(r), null);
    for (const who of ["red", "blue", null]) {
      const s = Fog.viewFor(r, who, 6500).log.find((e) => e.type === "snipe");
      assert.ok(s && s.color === "red" && s.by === "Ann" && s.victim === "blue" && s.victimBy === "Bo" && s.cell === 12, `${who || "spectator"} sees "Ann sniped Bo"`);
    }
    assert.ok(!Fog.viewFor(r, "red", 6500).log.some((e) => e.type === "claim" && e.color === "blue"), "blue's own claim line stays hidden from red");
    assert.ok(Fog.viewFor(r, "blue", 6500).log.some((e) => e.type === "claim" && e.color === "blue" && e.sniped), "blue's log marks it sniped");
    assert.strictEqual(Fog.claim(r, "blue", 12, 7000, "Bo").error, "That square is already claimed.", "once it took effect, it blocks as usual");
    // First click among claims still waiting: if the first one is undone, the next one gets the square, no snipe.
    const u = mk({ claimDelay: 5 });
    Fog.claim(u, "red", 12, 1000, "Ann");
    Fog.claim(u, "blue", 12, 2000, "Bo");
    Fog.cancelClaim(u, "red", 12, 3000, "Ann");
    Fog.settle(u, 7000);
    assert.deepStrictEqual(u.claims[12].map((m) => m.color), ["blue"]);
    assert.ok(!u.log.some((e) => e.type === "snipe"));
    // Without lockout both claims stand.
    const nl = mk({ claimDelay: 5, lockout: false });
    Fog.claim(nl, "red", 12, 1000, "Ann");
    Fog.claim(nl, "blue", 12, 2000, "Bo");
    assert.strictEqual(Fog.settle(nl, 7000), 2);
    assert.deepStrictEqual(nl.claims[12].map((m) => m.color), ["red", "blue"]);
    assert.ok(!nl.log.some((e) => e.type === "snipe"));
  });

  await check("End the game: waiting claims take effect first (earliest click wins, snipes included), so they count", () => {
    const r = mk({ goal: "open", claimDelay: 5 });
    Fog.claim(r, "red", 12, 1000, "Ann");
    Fog.claim(r, "blue", 12, 1500, "Bo");
    Fog.claim(r, "blue", 24, 1600, "Bo");
    assert.ok(Fog.endEarly(r, "blue", 2000, "Bo").ok);
    assert.deepStrictEqual(r.claims[12].map((m) => [m.color, m.pending]), [["red", undefined]]);
    assert.strictEqual(Fog.nextPending(r), null);
    assert.ok(r.log.some((e) => e.type === "snipe" && e.victim === "blue"));
    assert.match(r.ended.reason, /Red 1, Blue 1/);
  });

  await check("random starts: center + a different edge or corner square per color, avoiding Bonus Reveal Squares", () => {
    for (const size of [4, 5, 6]) {
      for (let seed = 1; seed <= 30; seed++) {
        let x = seed;
        const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
        const r = mk({ size, lockout: false, chests: 3 }, { colors: Fog.COLORS, randomStarts: true, rand, started: false });
        const g = Fog.geometry(size);
        const homes = Fog.COLORS.map((c) => r.homes[c]);
        assert.strictEqual(new Set(homes).size, 10, "every color gets its own square");
        for (const c of Fog.COLORS) {
          const seen = Fog.seenOf(r, c);
          assert.strictEqual(seen.length, 2);
          assert.ok(g.border.includes(r.homes[c]) && seen.includes(r.homes[c]), "an edge or corner square");
          assert.ok(seen.some((i) => g.middle.includes(i)), "plus the center");
        }
        if (size > 4) assert.ok(homes.every((h) => !r.chests.includes(h)), "no start on a Bonus Reveal Square while others are free");
        assert.ok(r.chests.every((i) => !g.middle.includes(i)));
      }
    }
    const a = mk({}, { randomStarts: true, rand: () => 0.1 }), b = mk({}, { randomStarts: true, rand: () => 0.9 });
    assert.notDeepStrictEqual(a.homes, b.homes, "the squares depend on the room's random draw");
  });

  await check("player limits: lockout rooms take 4 players, non-lockout 16; spectators and rejoins don't count", () => {
    const r = mk({}, { colors: ["red", "blue", "green", "orange"], started: false });
    const full = Fog.join(r, "tok-pink", "Pi", "pink", 0);
    assert.ok(!full.ok && /full/.test(full.error), full.error);
    assert.strictEqual(Fog.join(r, "tok-red2", "Ann2", "red", 0).ok, false, "a teammate is a player too");
    assert.ok(Fog.join(r, "tok-watch", "Watcher", null, 0).ok, "spectators always fit");
    assert.ok(Fog.join(r, "tok-red", "Ann", "blue", 0).ok, "a player can switch color");
    const nl = mk({ lockout: false }, { colors: [], started: false });
    for (let k = 0; k < 16; k++) assert.ok(Fog.join(nl, `p${k}`, `P${k}`, Fog.COLORS[k % 10], 0).ok, `player ${k + 1}`);
    assert.strictEqual(Fog.join(nl, "p16", "P16", "red", 0).ok, false, "17th player");
    assert.ok(Fog.join(nl, "p3", "P3", "teal", 0).ok, "rejoin with the same token");
    assert.strictEqual(Fog.maxPlayers({ lockout: true }), 4);
    assert.strictEqual(Fog.maxPlayers({ lockout: false }), 16);
    assert.strictEqual(Fog.recommendedPlayers({ size: 5, lockout: true }), 3);
    assert.strictEqual(Fog.recommendedPlayers({ size: 6, lockout: true }), 4);
    assert.strictEqual(Fog.recommendedPlayers({ size: 5, lockout: true, sharedFog: true }), 2);
    assert.strictEqual(Fog.recommendedPlayers({ size: 5, lockout: false }), 16);
    assert.strictEqual(Fog.recommendedPlayers({ size: 4, lockout: false, sharedFog: true }), 2);
  });

  await check("shared notes: team symbols reach teammates only, 'all' symbols reach everyone, private stay off the server", () => {
    const r = mk({ noteShare: { silver: "team", square: "all", x: "private", circle: "bogus" } });
    assert.strictEqual(r.config.noteShare.circle, "private", "unknown scope falls back to private");
    Fog.join(r, "tok-red2", "Ann2", "red", 0); // a teammate
    assert.ok(Fog.toggleNote(r, "red", 7, "silver", "Ann").ok);
    assert.ok(Fog.toggleNote(r, "blue", 3, "square", "Bo").ok);
    assert.match(Fog.toggleNote(r, "red", 1, "x", "Ann").error, /private/);
    const red = Fog.viewFor(r, "red", 1), blue = Fog.viewFor(r, "blue", 1), spec = Fog.viewFor(r, null, 1);
    assert.deepStrictEqual(red.notes.team[7], [{ kind: "silver", by: "Ann", color: "red" }], "teammates (same color) see it");
    assert.deepStrictEqual(blue.notes.team, {}, "the other color doesn't");
    assert.strictEqual(red.notes.all[3][0].kind, "square");
    assert.strictEqual(blue.notes.all[3][0].by, "Bo");
    assert.strictEqual(spec.notes.byColor.red[7][0].kind, "silver", "spectators can view each color's notes");
    assert.ok(!JSON.stringify(blue).includes('"silver"') || !blue.notes.team[7], "blue's JSON has no red team note");
    Fog.toggleNote(r, "red", 7, "silver", "Ann2");
    assert.strictEqual(r.notes.red[7], undefined, "a teammate can remove your color's symbol");
    assert.match(Fog.toggleNote(r, "red", 7, "heart", "Ann").error, /Unknown symbol/);
  });

  await check("symbols shared with everyone: you can't remove another color's; the same click adds yours beside it", () => {
    const r = mk({ noteShare: { square: "all" } });
    Fog.join(r, "tok-red2", "Ann2", "red", 0);
    Fog.toggleNote(r, "blue", 3, "square", "Bo");
    Fog.toggleNote(r, "red", 3, "square", "Ann");
    assert.deepStrictEqual(r.notes._all[3], [{ kind: "square", by: "Ann", color: "red" }, { kind: "square", by: "Bo", color: "blue" }],
      "Bo's square stays; Ann's is added (red before blue: join order)");
    Fog.toggleNote(r, "red", 3, "square", "Ann2");
    assert.deepStrictEqual(r.notes._all[3], [{ kind: "square", by: "Bo", color: "blue" }], "Ann's teammate took red's off, Bo's stays");
    Fog.toggleNote(r, "blue", 3, "square", "Bo");
    assert.strictEqual(r.notes._all[3], undefined, "Bo takes his own off");
  });

  await check("Ctrl+click used to be a red star: old settings and saved symbols become the square", () => {
    assert.strictEqual(Fog.normalizeConfig({ noteShare: { redstar: "all" } }).noteShare.square, "all");
    assert.strictEqual(Fog.normalizeConfig({ noteShare: { redstar: "all", square: "team" } }).noteShare.square, "team", "the new name wins");
    const old = mk({});
    old.config.noteShare = { silver: "private", redstar: "team", x: "private", circle: "private" };
    old.notes = { red: { 4: [{ kind: "redstar", by: "Ann", color: "red" }] } };
    Fog.upgradeRoom(old);
    assert.strictEqual(old.config.noteShare.square, "team");
    assert.strictEqual(old.config.noteShare.redstar, undefined);
    assert.deepStrictEqual(old.notes.red[4], [{ kind: "square", by: "Ann", color: "red" }]);
    Fog.toggleNote(old, "red", 4, "square", "Ann");
    assert.strictEqual(old.notes.red[4], undefined, "and toggles off as a square");
  });

  await check("one square can carry several symbols; each toggles on its own; old single-symbol notes upgrade", () => {
    const r = mk({ noteShare: { silver: "all", square: "all", x: "all", circle: "team" } });
    for (const k of ["x", "silver", "square"]) Fog.toggleNote(r, "red", 5, k, "Ann");
    Fog.toggleNote(r, "blue", 5, "circle", "Bo");
    assert.deepStrictEqual(Fog.viewFor(r, "blue", 1).notes.all[5].map((n) => n.kind), ["silver", "square", "x"], "all three, in a fixed order");
    assert.deepStrictEqual(Fog.viewFor(r, "blue", 1).notes.team[5].map((n) => n.kind), ["circle"]);
    Fog.toggleNote(r, "red", 5, "square", "Ann");
    assert.deepStrictEqual(r.notes._all[5].map((n) => n.kind), ["silver", "x"], "removing one leaves the others");
    Fog.toggleNote(r, "red", 5, "silver", "Ann");
    Fog.toggleNote(r, "red", 5, "x", "Ann");
    assert.strictEqual(r.notes._all[5], undefined, "an empty square is cleaned up");
    const old = mk({ noteShare: { silver: "all" } });
    old.notes = { _all: { 2: { kind: "silver", by: "Bo", color: "blue" } } };
    Fog.upgradeRoom(old);
    assert.deepStrictEqual(old.notes._all[2], [{ kind: "silver", by: "Bo", color: "blue" }]);
    Fog.toggleNote(old, "blue", 2, "silver", "Bo");
    assert.strictEqual(old.notes._all[2], undefined, "and still toggles off (by its own color)");
  });

  await check("board sizes: 4x4 and 6x6 geometry, starting views, lines of 4 and 6", () => {
    const g4 = Fog.geometry(4), g6 = Fog.geometry(6);
    assert.strictEqual(g4.lines.length, 10);
    assert.strictEqual(g6.lines.length, 14);
    assert.deepStrictEqual(g4.corners, [0, 3, 12, 15]);
    assert.deepStrictEqual(g4.border, [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]);
    assert.strictEqual(g6.border.length, 20);
    assert.deepStrictEqual(g6.lines.find((l) => l.name.startsWith("diagonal (bottom")).cells, [30, 25, 20, 15, 10, 5]);
    const r4 = mk({ size: 4, lockout: false }, { colors: ["red", "blue", "green", "orange", "pink"] });
    assert.deepStrictEqual(Fog.seenOf(r4, "red"), [0, 5], "start square + nearest central square");
    assert.deepStrictEqual(Fog.seenOf(r4, "blue"), [10, 15], "mirror image");
    assert.deepStrictEqual(Fog.seenOf(r4, "pink"), [1, 5], "5th color: the next edge square and its nearest central square");
    assert.strictEqual(Fog.claim(r4, "red", 16, 5).error, "That isn't a square on this board.");
    walk(r4, "red", [0, 1, 2]);
    assert.strictEqual(r4.ended, null);
    claim(r4, "red", 3);
    assert.strictEqual(r4.ended.winner, "red", "4 in a row wins on 4x4");
    const r6 = mk({ size: 6, goal: "corners", onClaim: "reveal8" });
    assert.deepStrictEqual(Fog.seenOf(r6, "red"), [14, 15, 20, 21], "corners mode: the central 2x2 block");
    const r6l = mk({ size: 6 });
    assert.deepStrictEqual(Fog.seenOf(r6l, "red"), [0, 14]);
    walk(r6l, "red", [0, 6, 12, 18, 24]);
    assert.strictEqual(r6l.ended, null, "5 isn't enough on 6x6");
    claim(r6l, "red", 30);
    assert.strictEqual(r6l.ended.reason, "column 1");
    assert.throws(() => Fog.createRoom({ id: "t", board: fakeBoard, cardSeed: "1", filenameSeed: "2", config: { size: 6 }, now: 0, rand: Math.random }), /36 goals/);
  });

  await check("a claim gives Free Reveals: no automatic reveal; tokens usable anywhere; undo takes back unspent", () => {
    const r = mk({ onClaim: "free3" });
    const res = claim(r, "red", 12);
    assert.deepStrictEqual(res.revealed, []);
    assert.deepStrictEqual(Fog.seenOf(r, "red"), [0, 12]);
    assert.strictEqual(r.lens.red, 3);
    assert.ok(Fog.useLens(r, "red", 24, 5).ok, "any fogged square");
    assert.strictEqual(r.lens.red, 2);
    Fog.requestUndo(r, "red", 12, 6);
    Fog.answerUndo(r, "blue", true, 7);
    assert.strictEqual(r.lens.red, 0, "unspent ones go back");
    assert.ok(Fog.seenOf(r, "red").includes(24), "what you saw stays seen");
  });

  await check("a claim gives adjacent reveals: only squares touching your own (diagonals count)", () => {
    const r = mk({ onClaim: "adj2" });
    claim(r, "red", 0);
    assert.strictEqual(r.adj.red, 2);
    assert.deepStrictEqual(Fog.adjacentTargets(r, "red"), [1, 5, 6]);
    assert.match(Fog.useAdjacent(r, "red", 24, 5).error, /must touch/);
    assert.ok(Fog.useAdjacent(r, "red", 6, 6).ok, "diagonal neighbor");
    assert.match(Fog.useLens(r, "red", 24, 7).error, /off in this room/, "adjacent reveals aren't Free Reveals");
    const v = Fog.viewFor(r, "red", 8);
    assert.deepStrictEqual(v.adjTargets, [1, 5]);
    assert.strictEqual(v.adj.red, 1);
    const blue = Fog.viewFor(r, "blue", 8);
    const e = blue.log.find((x) => x.type === "adj");
    assert.ok(e && e.cell === undefined, "where red looked is hidden from blue");
    assert.strictEqual(blue.log.find((x) => x.type === "claim").gained, undefined, "and what red gained");
  });

  await check("reveal counts are 1/2/3; blocked combinations are reported; Bonus Reveal Squares work on their own", () => {
    assert.deepStrictEqual(Fog.ON_CLAIM, ["reveal4", "reveal8", "free1", "free2", "free3", "adj1", "adj2", "adj3"]);
    assert.strictEqual(Fog.normalizeConfig({ onClaim: "free4" }).onClaim, "reveal4", "4 is no longer offered");
    const bad = (c) => Fog.configProblems(c).length > 0;
    assert.ok(!bad({}), "defaults are fine");
    assert.ok(bad({ goal: "corners", onClaim: "free1" }) && bad({ goal: "corners", lens: 1 }), "Corners + any Free Reveals");
    assert.ok(!bad({ goal: "corners", onClaim: "adj2" }));
    assert.ok(bad({ sharedFog: true, onClaim: "free3" }) && bad({ sharedFog: true, onClaim: "adj3" }) && !bad({ sharedFog: true, onClaim: "adj2" }));
    assert.ok(bad({ size: 6, goal: "corners" }) && bad({ size: 6, goal: "corners", onClaim: "reveal8", lockout: false }) && !bad({ size: 6, goal: "corners", onClaim: "reveal8" }));
    assert.ok(bad({ size: 4, onClaim: "reveal8" }) && bad({ size: 4, onClaim: "adj3" }) && !bad({ size: 4, onClaim: "free2" }));
    assert.ok(bad({ size: 4, sharedFog: true }) && bad({ size: 4, sharedFog: true, onClaim: "adj2" }) && !bad({ size: 4, sharedFog: true, onClaim: "free1" }), "4x4 + shared fog: 1 reveal only");
    const r = mk({ chests: 1 }, { rand: () => 0 });
    assert.strictEqual(r.config.lens, 0);
    assert.strictEqual(r.chests.length, 1, "Bonus Reveal Squares without starting Free Reveals");
    const old = mk({ onClaim: "free2" });
    old.config.onClaim = "free6"; // a room saved before the change
    claim(old, "red", 12);
    assert.strictEqual(old.lens.red, 6, "old rooms keep their setting");
  });

  await check("adjacent mode: a free square without reveals gives none; boxed in still gets a bonus Free Reveal", () => {
    const r = mk({ onClaim: "adj3", free: 1, freeReveals: false });
    claim(r, "red", 0, true);
    assert.strictEqual(r.adj.red, 0);
    r.claims[12] = [{ color: "blue", at: 1 }];
    assert.deepStrictEqual(Fog.claimable(r, "red"), []);
    assert.strictEqual(Fog.viewFor(r, "red", 2).stuck, true);
    assert.ok(Fog.useLens(r, "red", 1, 3).free, "bonus reveal when nothing else is possible");
  });

  await check("rooms saved by the previous version upgrade to the new square format", () => {
    const old = mk();
    old.v = 2; delete old.config.lockout;
    old.claims = { 0: { color: "red", at: 5, by: "Ann", free: false } };
    Fog.upgradeRoom(old);
    assert.strictEqual(old.v, 3);
    assert.strictEqual(old.config.lockout, true);
    assert.deepStrictEqual(old.claims[0], [{ color: "red", at: 5, by: "Ann", free: false }]);
    assert.deepStrictEqual(Fog.viewFor(old, "red", 6).cells[0].marks, [{ color: "red", free: false, by: "Ann" }]);
  });

  await check("stalemate: most squares; tie -> got there first; early end by a player", () => {
    const r = mk();
    [..."RBRBR" + "BRBRB" + "BRBRB" + "RBRBR" + "BRBRB"].forEach((ch, i) => { r.claims[i] = [{ color: ch === "R" ? "red" : "blue", at: 100 + i }]; });
    Fog.checkEnd(r, 5000);
    assert.strictEqual(r.ended.winner, "blue");
    assert.match(r.ended.reason, /most squares \(13-12\)/);
    const tie = mk();
    [..."RBRBR" + "BRBRB" + "BRBRB" + "RBRBR" + "BRBR."].forEach((ch, i) => { if (ch !== ".") tie.claims[i] = [{ color: ch === "R" ? "red" : "blue", at: ch === "R" ? 10 : 20 }]; });
    Fog.checkEnd(tie, 5000);
    assert.strictEqual(tie.ended.winner, "red");
    const e = mk();
    claim(e, "blue", 24);
    assert.ok(Fog.endEarly(e, "red", 9, "Ann").ok);
    assert.strictEqual(e.ended.winner, "blue");
    assert.match(e.ended.reason, /ended early by Ann/);
  });

  await check("view: players see only their color's squares; other claims as color; lens target hidden; no difficulty tiers", () => {
    const r = mk({ lens: 2 });
    claim(r, "blue", 24);
    Fog.useLens(r, "blue", 2, 5000, "Bo");
    const v = Fog.viewFor(r, "red", 6000);
    assert.deepStrictEqual(v.cells.filter((c) => c.name).map((c) => c.i), [0, 12]);
    assert.strictEqual(v.cells[24].marks[0].color, "blue");
    assert.strictEqual(v.cells[24].marks[0].by, "blue");
    assert.strictEqual(v.cells[24].name, null);
    const lensEntry = v.log.find((e) => e.type === "lens");
    assert.ok(lensEntry && lensEntry.cell === undefined);
    assert.strictEqual(v.cardSeed, undefined);
    assert.strictEqual(v.seenBy, undefined);
    assert.ok(!JSON.stringify(v).includes("Goal 2\""));
    assert.deepStrictEqual(v.players.map((p) => p.name), ["Ann", "Bo"]);
    assert.ok(!JSON.stringify(v).includes("tok-"), "no tokens in a view");
    assert.ok(Fog.viewFor(r, null, 6000).cells.every((c) => c.difficulty === undefined), "no BingoSync tiers, even for spectators");
  });

  await check("view: nobody sees the card before the start; spectators see all after; everyone at the end", () => {
    const r = mk({}, { started: false });
    assert.ok(Fog.viewFor(r, null, 1).cells.every((c) => c.name === null), "spectator, before start");
    assert.ok(Fog.viewFor(r, "red", 1).cells.every((c) => c.name === null));
    Fog.start(r, 2);
    const sp = Fog.viewFor(r, null, 3);
    assert.ok(sp.cells.every((c) => c.name) && sp.seenBy && sp.cardSeed === "111");
    Fog.endEarly(r, "red", 4, "Ann");
    assert.ok(Fog.viewFor(r, "blue", 5).cells.every((c) => c.name));
  });

  console.log("server");
  const cardFor = loadGenerator();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fog-test-"));
  let now = 1_000_000;
  const { server, rooms } = createServer({ roomsDir: dir, cardFor, clock: () => now, log: () => {}, createLimit: { max: 1000, windowMs: 3_600_000 } });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };

  let id, red, blue, spec;
  await check("card matches the BingoSync generator", () => {
    const card = cardFor("812345");
    assert.strictEqual(card.length, 25);
    assert.strictEqual(card[0].name, "Spirit Temple Boss Key");
  });

  await check("create: validates seeds and nickname; creator is joined", async () => {
    assert.strictEqual((await call("/api/rooms", { name: "Ann", color: "red", filenameSeed: "5000", cardSeed: "5000" })).status, 400);
    assert.strictEqual((await call("/api/rooms", { name: "Ann", color: "red", filenameSeed: "way too long" })).status, 400);
    assert.strictEqual((await call("/api/rooms", { name: "", color: "red" })).status, 400);
    const ok = await call("/api/rooms", { name: "Ann", color: "red", filenameSeed: "812345", cardSeed: "4242", free: 1, goal: "line" });
    assert.strictEqual(ok.status, 200);
    ({ id, token: red } = ok.data);
    assert.strictEqual(rooms.get(id).config.goal, "open", "Open, whatever the request says");
    assert.strictEqual(rooms.get(id).config.claimDelay, 5, "and the default 5-second claim undo timer");
  });

  await check("claim undo timer: lockout rooms pick off or 1-10 seconds; rooms without lockout always get the default", async () => {
    const timerOf = async (body) => rooms.get((await call("/api/rooms", { name: "Ann", color: "red", ...body })).data.id).config.claimDelay;
    assert.strictEqual(await timerOf({ claimDelay: 3 }), 3, "lockout is on by default");
    assert.strictEqual(await timerOf({ lockout: true, claimDelay: 0 }), 0, "off");
    assert.strictEqual(await timerOf({ lockout: true, claimDelay: 99 }), 10, "at most 10");
    assert.strictEqual(await timerOf({ lockout: false, claimDelay: 2 }), 5, "not a non-lockout setting");
    // With the timer off, a claim takes effect at once: no waiting, its reveals are there straight away.
    const off = (await call("/api/rooms", { name: "Ann", color: "red", lockout: true, claimDelay: 0 })).data;
    await call(`/api/rooms/${off.id}/action?t=${off.token}`, { type: "ready" });
    const c = (await call(`/api/rooms/${off.id}/action?t=${off.token}`, { type: "claim", cell: 12 })).data;
    assert.ok(c.ok && !c.pending, JSON.stringify(c));
    assert.ok((await call(`/api/rooms/${off.id}/state?t=${off.token}`)).data.cells[7].name, "revealed at once");
  });

  await check("join with one link: info is public, join gives a token, rejoin keeps it", async () => {
    const info = (await call(`/api/rooms/${id}/info`)).data;
    assert.deepStrictEqual(info.players, [{ name: "Ann", color: "red" }]);
    assert.ok(!JSON.stringify(info).includes("4242") && !JSON.stringify(info).includes(red));
    blue = (await call(`/api/rooms/${id}/join`, { name: "Bo", color: "blue" })).data.token;
    spec = (await call(`/api/rooms/${id}/join`, { name: "Viewer", color: "spectator" })).data.token;
    assert.ok(blue && spec && blue !== red);
    const again = await call(`/api/rooms/${id}/join`, { name: "Bo", color: "blue", token: blue });
    assert.strictEqual(again.data.token, blue);
    const newTab = await call(`/api/rooms/${id}/join`, { name: " Bo ", color: "blue" });
    assert.strictEqual(newTab.data.token, blue, "same nickname + color in a new tab takes the old place");
    assert.strictEqual((await call(`/api/rooms/${id}/info`)).data.players.length, 3, "no duplicate");
    assert.strictEqual((await call(`/api/rooms/${id}/state?t=nope`)).status, 403);
    assert.strictEqual((await call(`/api/rooms/${id}/join`, { name: "X", color: "magenta" })).status, 400);
  });

  await check("ready up; the claim's reveals land 5 s later; red's JSON never contains a hidden goal", async () => {
    const card = cardFor("4242");
    await call(`/api/rooms/${id}/action?t=${red}`, { type: "ready" });
    assert.ok((await call(`/api/rooms/${id}/action?t=${blue}`, { type: "ready" })).data.started);
    now += 60_000;
    const c = await call(`/api/rooms/${id}/action?t=${red}`, { type: "claim", cell: 12 });
    assert.ok(c.data.ok && c.data.pending, c.data.error);
    const waiting = (await call(`/api/rooms/${id}/state?t=${red}`)).data;
    assert.strictEqual(waiting.cells[7].name, null, "nothing revealed during the wait");
    assert.strictEqual(waiting.cells[12].marks[0].pending, true);
    const blueWaiting = (await call(`/api/rooms/${id}/state?t=${blue}`)).data;
    assert.deepStrictEqual(blueWaiting.cells[12].marks, [], "blue can't see red's waiting claim");
    assert.ok(!blueWaiting.log.some((e) => e.type === "claim"), "or its log line");
    now += 5_000;
    const raw = JSON.stringify((await call(`/api/rooms/${id}/state?t=${red}`)).data);
    const home = rooms.get(id).homes.red;
    assert.ok(Fog.geometry(5).border.includes(home), "red starts on an edge or corner square");
    const visible = new Set([home, 12, 7, 11, 13, 17]);
    for (let i = 0; i < 25; i++) {
      const has = raw.includes(JSON.stringify(card[i].name));
      if (visible.has(i)) assert.ok(has, `missing visible ${i}`);
      else assert.ok(!has, `leaked hidden square ${i}: ${card[i].name}`);
    }
    assert.ok(!raw.includes('"cardSeed"'));
  });

  await check("free claim and Undo over HTTP; spectators can't act", async () => {
    const bh = rooms.get(id).homes.blue;
    const f = await call(`/api/rooms/${id}/action?t=${blue}`, { type: "claim", cell: bh, free: true });
    assert.ok(f.data.ok, f.data.error);
    const v = (await call(`/api/rooms/${id}/state?t=${blue}`)).data;
    assert.strictEqual(v.cells[bh].marks[0].free, true);
    assert.strictEqual(v.cells[bh].marks[0].by, "Bo");
    assert.strictEqual((await call(`/api/rooms/${id}/state?t=${red}`)).data.freeLeft.blue, 1, "red can't tell blue spent a free square");
    assert.ok((await call(`/api/rooms/${id}/action?t=${blue}`, { type: "cancel", cell: bh })).data.ok, "Undo during the wait");
    assert.strictEqual((await call(`/api/rooms/${id}/state?t=${blue}`)).data.freeLeft.blue, 1, "free square back");
    assert.ok((await call(`/api/rooms/${id}/action?t=${blue}`, { type: "claim", cell: bh, free: true })).data.ok);
    assert.strictEqual((await call(`/api/rooms/${id}/action?t=${spec}`, { type: "claim", cell: 0 })).status, 400);
  });

  await check("SSE pushes a personalized state, and nothing at all to blue while red's claim waits", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/rooms/${id}/events?t=${blue}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextEvent = async () => {
      while (!buf.includes("\n\n")) { const { value } = await reader.read(); buf += dec.decode(value); }
      const i = buf.indexOf("\n\n"); const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      return JSON.parse(ev.split("\n").find((l) => l.startsWith("data: ")).slice(6));
    };
    assert.strictEqual((await nextEvent()).you.color, "blue");
    await call(`/api/rooms/${id}/action?t=${red}`, { type: "claim", cell: 7 }); // hidden from blue: no push
    now += 5_000;
    await call(`/api/rooms/${id}/state?t=${red}`); // any request settles it
    const second = await nextEvent(); // so blue's next push is the one where the claim took effect
    assert.strictEqual(second.cells[7].marks[0].color, "red");
    assert.strictEqual(second.cells[7].name, null, "blue can't read red's square");
    ctrl.abort();
  });

  await check("rooms survive a restart; End the game reveals the card and seeds, no explorer link", async () => {
    const again = createServer({ roomsDir: dir, cardFor, clock: () => now, log: () => {} });
    assert.ok(again.rooms.has(id));
    again.server.close();
    await call(`/api/rooms/${id}/action?t=${blue}`, { type: "end" });
    const v = (await call(`/api/rooms/${id}/state?t=${blue}`)).data;
    assert.strictEqual(v.ended.winner, null, "Open: the players decide");
    assert.match(v.ended.reason, /ended by Bo \(squares: Red 2, Blue 1\)/);
    assert.strictEqual(v.cardSeed, "4242");
    assert.ok(v.cells.every((c) => c.name));
    assert.strictEqual(v.explorer, undefined);
  });

  await check("server refuses blocked combinations; the page gets the same rules from /rules.js", async () => {
    const r = await call("/api/rooms", { name: "Ann", color: "red", size: 4, onClaim: "reveal8" });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /4x4 is small/);
    const js = await (await fetch(base + "/rules.js")).text();
    const vm = require("vm");
    const sandbox = { window: {} };
    vm.runInNewContext(js, sandbox);
    assert.strictEqual(typeof sandbox.window.FogRules.configProblems, "function");
    for (const c of [{ size: 4, onClaim: "reveal8" }, { size: 4, sharedFog: true }, { goal: "corners", lens: 2 }, {}])
      assert.strictEqual(JSON.stringify(sandbox.window.FogRules.configProblems(c)), JSON.stringify(Fog.configProblems(c)));
    assert.strictEqual(sandbox.window.FogRules.recommendedPlayers({ size: 4, lockout: true }), 3, "the page gets the player advice too");
  });

  await check("pages: /, /play (streamer mode) and /r/<code> serve the page; the estimates endpoint is gone", async () => {
    for (const p of ["/", "/play", `/r/${id}`]) {
      const res = await fetch(base + p);
      assert.strictEqual(res.status, 200, p);
      assert.match(await res.text(), /<title>Beta Quest Bingo Fog Mode<\/title>/);
    }
    assert.strictEqual((await call("/api/estimates")).status, 404);
  });

  await check("a full lockout room refuses a 5th player over HTTP but takes spectators", async () => {
    const r = (await call("/api/rooms", { name: "P0", color: "red" })).data;
    for (const [k, c] of [[1, "blue"], [2, "green"], [3, "teal"]]) assert.strictEqual((await call(`/api/rooms/${r.id}/join`, { name: `P${k}`, color: c })).status, 200);
    const fifth = await call(`/api/rooms/${r.id}/join`, { name: "P4", color: "pink" });
    assert.strictEqual(fifth.status, 400);
    assert.match(fifth.data.error, /full/);
    assert.strictEqual((await call(`/api/rooms/${r.id}/join`, { name: "P4", color: "spectator" })).status, 200);
    assert.strictEqual((await call(`/api/rooms/${r.id}/join`, { name: "P2", color: "green" })).status, 200, "an old player can take their place back");
  });

  await check("6x6 room with a real card: 36 goals, no hidden ones leak", async () => {
    const r = await call("/api/rooms", { name: "Ann", color: "red", size: 6, onClaim: "adj2", filenameSeed: "812345", cardSeed: "777" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const rid = r.data.id, red6 = r.data.token;
    const blue6 = (await call(`/api/rooms/${rid}/join`, { name: "Bo", color: "blue" })).data.token;
    await call(`/api/rooms/${rid}/action?t=${red6}`, { type: "ready" });
    await call(`/api/rooms/${rid}/action?t=${blue6}`, { type: "ready" });
    const room = rooms.get(rid), home = room.homes.red;
    assert.ok((await call(`/api/rooms/${rid}/action?t=${red6}`, { type: "claim", cell: home })).data.ok);
    now += 5_000;
    await call(`/api/rooms/${rid}/state?t=${red6}`); // settles the claim
    const target = Fog.adjacentTargets(room, "red")[0];
    assert.ok((await call(`/api/rooms/${rid}/action?t=${red6}`, { type: "adj", cell: target })).data.ok, "adjacent reveal over HTTP, after the wait");
    const card = cardFor("777", 6);
    const v = (await call(`/api/rooms/${rid}/state?t=${red6}`)).data;
    assert.strictEqual(v.cells.length, 36);
    const raw = JSON.stringify(v);
    const visible = new Set(Fog.seenOf(room, "red"));
    assert.strictEqual(visible.size, 3);
    for (let i = 0; i < 36; i++) assert.strictEqual(raw.includes(JSON.stringify(card[i].name)), visible.has(i), `square ${i}`);
  });

  await check("a waiting claim settles on its own and is pushed to everyone (real clock, 1 s wait)", async () => {
    const live = createServer({ roomsDir: fs.mkdtempSync(path.join(os.tmpdir(), "fog-live-")), cardFor, log: () => {}, claimDelay: 1 });
    await new Promise((res) => live.server.listen(0, "127.0.0.1", res));
    const lb = `http://127.0.0.1:${live.server.address().port}`;
    const post = async (p, body) => (await fetch(lb + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    const { id: lid, token: a } = await post("/api/rooms", { name: "Ann", color: "red" });
    const { token: b } = await post(`/api/rooms/${lid}/join`, { name: "Bo", color: "blue" });
    await post(`/api/rooms/${lid}/action?t=${a}`, { type: "ready" });
    await post(`/api/rooms/${lid}/action?t=${b}`, { type: "ready" });
    const ctrl = new AbortController();
    const listen = async (tok) => {
      const res = await fetch(`${lb}/api/rooms/${lid}/events?t=${tok}`, { signal: ctrl.signal });
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      return async () => {
        while (!buf.includes("\n\n")) { const { value } = await reader.read(); buf += dec.decode(value); }
        const i = buf.indexOf("\n\n"); const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        return JSON.parse(ev.split("\n").find((l) => l.startsWith("data: ")).slice(6));
      };
    };
    const annNext = await listen(a), boNext = await listen(b);
    await annNext(); await boNext();
    const started = Date.now();
    assert.ok((await post(`/api/rooms/${lid}/action?t=${a}`, { type: "claim", cell: 12 })).pending);
    assert.strictEqual((await annNext()).cells[12].marks[0].pending, true, "Ann sees her claim at once");
    const settled = await annNext();
    const waited = Date.now() - started;
    assert.strictEqual(settled.cells[12].marks[0].pending, undefined);
    assert.ok(settled.cells[7].name, "reveals pushed without another click");
    assert.ok(waited >= 900 && waited < 3000, `settled after ${waited} ms`);
    const bo = await boNext();
    const boWaited = Date.now() - started;
    assert.strictEqual(bo.cells[12].marks[0].color, "red", "Bo's first push after the click already has the claim in effect");
    assert.ok(boWaited >= 900, `Bo heard nothing for ${boWaited} ms`);
    ctrl.abort();
    live.server.closeAllConnections();
    await new Promise((r) => live.server.close(r));
  });

  await check("room password: optional, anything goes; needed to join or spectate; never sent or stored in plain text", async () => {
    const made = await call("/api/rooms", { name: "Ann", color: "red", password: " 1234 " });
    assert.strictEqual(made.status, 200, JSON.stringify(made.data));
    const pid = made.data.id, ann = made.data.token;
    const info = (await call(`/api/rooms/${pid}/info`)).data;
    assert.strictEqual(info.password, true, "the join form knows to ask");
    assert.strictEqual((await call(`/api/rooms/${id}/info`)).data.password, false, "rooms without one don't");
    const none = await call(`/api/rooms/${pid}/join`, { name: "Bo", color: "blue" });
    assert.deepStrictEqual([none.status, none.data.error], [403, "This room needs a password."]);
    const wrong = await call(`/api/rooms/${pid}/join`, { name: "Bo", color: "blue", password: "4321" });
    assert.deepStrictEqual([wrong.status, wrong.data.error], [403, "Wrong room password."]);
    assert.strictEqual((await call(`/api/rooms/${pid}/join`, { name: "Viewer", color: "spectator" })).status, 403, "spectators need it too (they see the whole card)");
    assert.strictEqual((await call(`/api/rooms/${pid}/join`, { name: "Ann", color: "red" })).status, 403, "taking over a place by nickname and color needs it");
    const bo = await call(`/api/rooms/${pid}/join`, { name: "Bo", color: "blue", password: "1234" });
    assert.strictEqual(bo.status, 200, "spaces around it don't matter");
    assert.strictEqual((await call(`/api/rooms/${pid}/join`, { name: "Bo B", color: "green", token: bo.data.token })).status, 200, "in the room already: changing name or color needs no password");
    const state = (await call(`/api/rooms/${pid}/state?t=${ann}`)).data;
    const onDisk = fs.readFileSync(path.join(dir, `${pid}.json`), "utf8");
    // (as a whole JSON string: a random seed like "512345" may contain the digits)
    for (const raw of [JSON.stringify(info), JSON.stringify(state), onDisk]) assert.ok(!raw.includes('"1234"') && !raw.includes('" 1234 "'), "the password itself is nowhere");
    for (const raw of [JSON.stringify(info), JSON.stringify(state)]) assert.ok(!raw.includes(rooms.get(pid).pass.hash), "and neither is its hash");
    assert.match((await call("/api/rooms", { name: "Ann", color: "red", password: "x".repeat(65) })).data.error, /up to 64/);
    assert.strictEqual(rooms.get((await call("/api/rooms", { name: "Ann", color: "red", password: "   " })).data.id).pass, undefined, "blank = an open room");
  });

  await check("room password: 10 wrong guesses a minute, then the room waits", async () => {
    const pid = (await call("/api/rooms", { name: "Ann", color: "red", password: "pw" })).data.id;
    for (let k = 0; k < 10; k++) assert.strictEqual((await call(`/api/rooms/${pid}/join`, { name: "Eve", color: "blue", password: `guess${k}` })).status, 403);
    const blocked = await call(`/api/rooms/${pid}/join`, { name: "Eve", color: "blue", password: "pw" });
    assert.strictEqual(blocked.status, 429, "even the right one, for now");
    now += 61_000;
    assert.strictEqual((await call(`/api/rooms/${pid}/join`, { name: "Bo", color: "blue", password: "pw" })).status, 200, "a minute later it works");
  });

  await check("before the start, a page closed for longer than the window stops counting for Ready (real clock)", async () => {
    const live = createServer({ roomsDir: fs.mkdtempSync(path.join(os.tmpdir(), "fog-away-")), cardFor, log: () => {}, awayAfter: 200 });
    await new Promise((res) => live.server.listen(0, "127.0.0.1", res));
    const lb = `http://127.0.0.1:${live.server.address().port}`;
    const post = async (p, body) => (await fetch(lb + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    const get = async (p) => (await fetch(lb + p)).json();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { id: lid, token: a } = await post("/api/rooms", { name: "Ann", color: "red" });
    const { token: b } = await post(`/api/rooms/${lid}/join`, { name: "Bo", color: "blue" });
    const openPage = async (tok) => {
      const ctrl = new AbortController();
      const res = await fetch(`${lb}/api/rooms/${lid}/events?t=${tok}`, { signal: ctrl.signal });
      await res.body.getReader().read(); // the first state push
      return ctrl;
    };
    const annPage = await openPage(a);
    let boPage = await openPage(b);
    boPage.abort(); // a refresh: closed and open again well inside the window
    boPage = await openPage(b);
    await wait(350);
    await post(`/api/rooms/${lid}/action?t=${a}`, { type: "ready" });
    assert.strictEqual((await get(`/api/rooms/${lid}/state?t=${a}`)).started, null, "Bo is here (not ready), so no start");
    boPage.abort(); // Bo closes the page for good
    await wait(80);
    let v = await get(`/api/rooms/${lid}/state?t=${a}`);
    assert.strictEqual(v.started, null, "still inside the window");
    await wait(350);
    v = await get(`/api/rooms/${lid}/state?t=${a}`);
    assert.ok(v.started, "Ann is ready and the only one here: the game starts");
    assert.deepStrictEqual(v.colors, ["red"]);
    const bo = await get(`/api/rooms/${lid}/state?t=${b}`);
    assert.deepStrictEqual([bo.you.color, bo.me.dropped], [null, true], "Bo watches, and his page says why");
    annPage.abort();
    live.server.closeAllConnections();
    await new Promise((r) => live.server.close(r));
  });

  // A server of its own on a fake clock, for the checks below that move time a long way or count requests.
  async function ownServer(options = {}) {
    let clockNow = 5_000_000;
    const roomsDir = options.roomsDir || fs.mkdtempSync(path.join(os.tmpdir(), "fog-own-"));
    const s = createServer({ roomsDir, cardFor, clock: () => clockNow, log: () => {}, ...options });
    await new Promise((res) => s.server.listen(0, "127.0.0.1", res));
    const b = `http://127.0.0.1:${s.server.address().port}`;
    const req = async (p, body) => {
      const res = await fetch(b + p, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
    const stop = async () => { s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); };
    return { ...s, req, stop, roomsDir, advance: (ms) => { clockNow += ms; } };
  }

  await check("a room nobody touches for a week is deleted (any activity restarts the week)", async () => {
    const own = await ownServer();
    const { id: rid, token } = (await own.req("/api/rooms", { name: "Ann", color: "red" })).data;
    own.advance(6 * 24 * 3600_000);
    assert.strictEqual((await own.req(`/api/rooms/${rid}/action?t=${token}`, { type: "ready" })).status, 200, "day 6: still there; this counts as activity");
    own.advance(6 * 24 * 3600_000);
    assert.strictEqual((await own.req(`/api/rooms/${rid}/info`)).status, 200, "6 days after that activity: still there (looking doesn't count)");
    own.advance(1 * 24 * 3600_000 + 60_000);
    const gone = await own.req(`/api/rooms/${rid}/info`);
    assert.deepStrictEqual([gone.status, gone.data.error], [404, "There's no room with that code."]);
    assert.ok(!fs.existsSync(path.join(own.roomsDir, `${rid}.json`)), "and its file is gone");
    await own.stop();
  });

  await check("room creation is limited per address; new passwords are PBKDF2, old scrypt ones still work", async () => {
    const own = await ownServer({ createLimit: { max: 2, windowMs: 3_600_000 } });
    const first = await own.req("/api/rooms", { name: "Ann", color: "red", password: "pw" });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(own.rooms.get(first.data.id).pass.algo, "pbkdf2-sha256");
    assert.strictEqual((await own.req("/api/rooms", { name: "Ann", color: "red" })).status, 200);
    const third = await own.req("/api/rooms", { name: "Ann", color: "red" });
    assert.deepStrictEqual([third.status, /new rooms/.test(third.data.error)], [429, true]);
    own.advance(3_600_000);
    assert.strictEqual((await own.req("/api/rooms", { name: "Ann", color: "red" })).status, 200, "an hour later it works again");
    // A room saved by the older server, with a scrypt password hash.
    const room = own.rooms.get(first.data.id);
    const salt = "oldsalt";
    const old = { ...JSON.parse(JSON.stringify(room)), id: "old123", pass: { salt, hash: require("crypto").scryptSync("1234", salt, 32).toString("base64url") } };
    fs.writeFileSync(path.join(own.roomsDir, "old123.json"), JSON.stringify(old));
    await own.stop();
    const again = await ownServer({ roomsDir: own.roomsDir });
    assert.strictEqual((await again.req("/api/rooms/old123/join", { name: "Bo", color: "blue", password: "nope" })).status, 403);
    assert.strictEqual((await again.req("/api/rooms/old123/join", { name: "Bo", color: "blue", password: "1234" })).status, 200);
    await again.stop();
  });

  server.closeAllConnections();
  await new Promise((res) => server.close(res));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0; // let Node exit on its own (process.exit can trip libuv on Windows)
})();
