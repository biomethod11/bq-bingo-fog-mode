// npm run dev:cloudflare: the Cloudflare version on this machine, in Wrangler's local mode (no account needed).
// Builds, then runs the Worker on http://localhost:8788/. Rooms are kept in cloudflare/.wrangler/ between runs.
"use strict";

const { spawn, spawnSync } = require("child_process");
const path = require("path");

const WRANGLER = path.join(__dirname, "..", "node_modules", "wrangler", "bin", "wrangler.js");

const build = spawnSync(process.execPath, [path.join(__dirname, "build.js")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);

const child = spawn(process.execPath, [WRANGLER, "dev", "--port", "8788"], {
  cwd: __dirname, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGINT", () => child.kill());
