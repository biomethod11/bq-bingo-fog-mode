// npm run check-public: run before every commit or push. Scans every file git would commit for anything personal:
// the terms in private_terms.txt (local-only, one per line; git never sees that file), email addresses and local file
// paths. The GitHub account name is allowed only in the files that need the repo's own address or licence line.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SELF = "scripts/check_public.js"; // holds the account name and the path pattern itself, so only its terms are checked
const ACCOUNT = "biomethod11";
const ACCOUNT_ALLOWED = new Set(["LICENSE", "fog.html", "README.md", "package.json"]);
const PATTERNS = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["a local file path", /(?<![A-Za-z])[A-Za-z]:[\\/]|\/Users\/|\/home\/|AppData/g],
];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);
const termsFile = path.join(ROOT, "private_terms.txt");
const terms = fs.existsSync(termsFile)
  ? fs.readFileSync(termsFile, "utf8").split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !t.startsWith("#"))
  : [];
if (!terms.length) console.warn("private_terms.txt is missing or empty, so only the general checks ran.");

const problems = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const lines = text.split("\n");
  const report = (what, i) => problems.push(`${file}:${i + 1}: ${what}`);
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const term of terms) if (lower.includes(term.toLowerCase())) report(`a private term ("${term.slice(0, 2)}…")`, i);
    if (file === SELF) return;
    for (const [what, re] of PATTERNS) if (line.match(re)) report(what, i);
    if (lower.includes(ACCOUNT) && !ACCOUNT_ALLOWED.has(file)) report("the account name, outside the files allowed to name it", i);
  });
}

if (problems.length) {
  console.error(`Not safe to publish (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-public: ${files.length} files, nothing personal found.`);
