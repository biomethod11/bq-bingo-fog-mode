// Cards for Beta Quest Bingo Fog Mode. Pure code (no I/O), shared by the Node server and the Cloudflare Worker; each
// passes in BingoSync's Beta Quest generator, loaded its own way (load_generator.js, cloudflare/build.js).
//
// 5x5: BingoSync's own Beta Quest card for the card seed, from BingoSync's generator, so it matches BingoSync exactly.
//
// 4x4 and 6x6: BingoSync has no such cards, so we build one the same way in spirit. The same goal list and its 25
// difficulty tiers, laid out on a magic square so every row, column and long diagonal has the same total difficulty,
// with goals that share a "types" tag kept off the same line (BingoSync's anti-synergy rule). Seeded by the card seed,
// so the same seed and size always give the same card.
"use strict";

const SIZES = [4, 5, 6];

// Magic squares (every row, column and long diagonal sums to the same total).
const MAGIC = {
  4: [[16, 3, 2, 13], [5, 10, 11, 8], [9, 6, 7, 12], [4, 15, 14, 1]],
  6: [[35, 1, 6, 26, 19, 24], [3, 32, 7, 21, 23, 25], [31, 9, 2, 22, 27, 20], [8, 28, 33, 17, 10, 15], [30, 5, 34, 12, 14, 16], [4, 36, 29, 13, 18, 11]],
};

// Small seeded PRNG (mulberry32) so a card seed always gives the same card.
function rngFor(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) { h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// One of the 8 rotations/reflections of the magic square, chosen by the seed (all stay magic).
function orientedMagic(n, rand) {
  let m = MAGIC[n].map((row) => row.slice());
  const turns = Math.floor(rand() * 4);
  for (let t = 0; t < turns; t++) m = m[0].map((_, c) => m.map((row) => row[c]).reverse());
  if (rand() < 0.5) m = m.map((row) => row.slice().reverse());
  return m;
}

function linesThrough(n, r, c) {
  const out = [Array.from({ length: n }, (_, k) => r * n + k), Array.from({ length: n }, (_, k) => k * n + c)];
  if (r === c) out.push(Array.from({ length: n }, (_, k) => k * n + k));
  if (r + c === n - 1) out.push(Array.from({ length: n }, (_, k) => k * n + (n - 1 - k)));
  return out;
}

function customCard(bingoList, seed, n) {
  const rand = rngFor(`fog-${n}x${n}-${seed}`);
  const magic = orientedMagic(n, rand);
  const total = n * n;
  const card = new Array(total).fill(null);
  const used = new Set();
  const order = shuffle([...Array(total).keys()], rand);
  for (const i of order) {
    const r = Math.floor(i / n), c = i % n;
    const rank = magic[r][c]; // 1..n²
    const tier = Math.round(1 + ((rank - 1) * 24) / (total - 1)); // spread over BingoSync's tiers 1..25
    const lineTypes = new Set();
    for (const line of linesThrough(n, r, c)) for (const j of line) if (card[j]) card[j].types.forEach((t) => lineTypes.add(t));
    let pick = null;
    // Prefer the exact tier with no shared type on any of this square's lines; widen only if that runs dry.
    for (const strictTypes of [true, false]) {
      for (let d = 0; d <= 24 && !pick; d++) {
        for (const t of d === 0 ? [tier] : [tier - d, tier + d]) {
          if (t < 1 || t > 25 || pick) continue;
          const candidates = shuffle(bingoList[t], rand).filter((g) => !used.has(g.name) && (!strictTypes || !(g.types || []).some((x) => lineTypes.has(x))));
          if (candidates.length) pick = { name: candidates[0].name, difficulty: tier, types: (candidates[0].types || []).slice() };
        }
      }
      if (pick) break;
    }
    used.add(pick.name);
    card[i] = pick;
  }
  return card;
}

// cardFor(seed, size) from BingoSync's generator: { bingoGenerator, bingoList } as its Beta Quest file defines them.
function makeCardFor({ bingoGenerator, bingoList }) {
  return function cardFor(seed, size = 5) {
    const s = String(seed);
    if (!/^\d{1,6}$/.test(s) || Number(s) < 1 || Number(s) > 999999) throw new Error("The card seed must be a number from 1 to 999999.");
    const n = Number(size);
    if (!SIZES.includes(n)) throw new Error("The board size must be 4, 5 or 6.");
    if (n === 5) return bingoGenerator(bingoList, { seed: s }).slice(1);
    return customCard(bingoList, s, n);
  };
}

module.exports = { makeCardFor, customCard, SIZES, MAGIC };
