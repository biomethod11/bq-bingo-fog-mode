// BingoSync's Beta Quest card generator, for Node (the local server, the tests and the simulator).
//
// BingoSync's generator files state no licence, so this repository doesn't include them: `npm run fetch-generator`
// downloads them from BingoSync's repository at a pinned commit into vendor/bingosync/ (not committed) and checks
// their SHA-256. cloudflare/build.js bundles the same checked files into the Worker.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { makeCardFor } = require("./board");

const VENDOR = process.env.FOG_GENERATOR_DIR || path.join(__dirname, "vendor", "bingosync");
// BingoSync (https://github.com/kbuzsaki/bingosync) at the commit whose Beta Quest cards this game matches.
const BINGOSYNC_COMMIT = "245673501ad6563a7770d2df4393b0a30a3ef62f";
const FILES = {
  generator: {
    file: "ocarina_of_time_beta_quest_generator.js",
    source: "bingosync-app/generators/ocarina_of_time_beta_quest_generator.js",
    sha256: "2bf15564999899e961fb72e8f10187a3724b29aca86b6a1314f0b24ff91b318d",
  },
  base: {
    file: "generators/generator_bases/srl_generator_v5_blackout.js",
    source: "bingosync-app/generators/generator_bases/srl_generator_v5_blackout.js",
    sha256: "c9e6f238dcd5f16cd3de704acadace42294033a74665d26d24ec0b532d63824f",
  },
};
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// Download any missing file, check every file's hash. Returns the folder.
async function fetchGenerator(log = console.log) {
  for (const f of Object.values(FILES)) {
    const dest = path.join(VENDOR, f.file);
    if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === f.sha256) continue;
    const url = `https://raw.githubusercontent.com/kbuzsaki/bingosync/${BINGOSYNC_COMMIT}/${f.source}`;
    log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (sha256(data) !== f.sha256) throw new Error(`${f.file}: unexpected SHA-256 ${sha256(data)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return VENDOR;
}

// The two files' text, checked against their hashes.
function readGeneratorSources() {
  const out = {};
  for (const [key, f] of Object.entries(FILES)) {
    const p = path.join(VENDOR, f.file);
    if (!fs.existsSync(p)) throw new Error(`BingoSync's generator isn't downloaded yet (${p}). Run: npm run fetch-generator`);
    const text = fs.readFileSync(p, "utf8");
    if (sha256(text) !== f.sha256 && !process.env.FOG_GENERATOR_DIR) throw new Error(`${p} doesn't match its pinned SHA-256. Run: npm run fetch-generator`);
    out[key] = text;
  }
  return out;
}

// { bingoGenerator, bingoList }, run the way BingoSync runs them (as plain scripts).
function loadBingoSync() {
  readGeneratorSources(); // checks they're there and unchanged
  const context = { require: (p) => require(path.resolve(VENDOR, p)) };
  const file = path.join(VENDOR, FILES.generator.file);
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { bingoGenerator: context.bingoGenerator, bingoList: context.bingoList };
}

// cardFor(seed, size): the card for a card seed and board size (see board.js).
const loadGenerator = () => makeCardFor(loadBingoSync());

module.exports = { loadGenerator, loadBingoSync, fetchGenerator, readGeneratorSources, FILES, BINGOSYNC_COMMIT };
