// The Cloudflare deployment: one Worker. Cloudflare serves the page's files (site/, see wrangler.toml); this Worker
// answers /api/..., where each room is a Durable Object.
//   RoomDO         one per room code. Keeps the room in its storage and a RoomHost (room_host.js, the same code the
//                  Node server runs) in memory; answers the room's API, streams live updates, and uses its alarm
//                  for timers: claim undo timers, players away before the start, and deleting the room after a
//                  week without activity.
//   CreateLimiter  a single object counting room creations per address (in memory, so it forgets when idle).
//
// The API (room_host.js has the details):
//   POST /api/rooms                  create a room under a fresh random code (a limited number per address an hour)
//   GET  /api/rooms/<code>/info      what the join form needs
//   POST /api/rooms/<code>/join      join (or rejoin) with a nickname and color, or as a spectator
//   GET  /api/rooms/<code>/state     the room as this player may see it (?t=<token>)
//   GET  /api/rooms/<code>/events    live updates (Server-Sent Events, ?t=<token>)
//   POST /api/rooms/<code>/action    claim, reveal, undo, ready, note, end... (?t=<token>)
import { DurableObject } from "cloudflare:workers";
import roomHostLib from "../room_host.js";
import board from "../board.js";
import { bingoGenerator, bingoList } from "./generated/bingosync.mjs";

const { RoomHost, RateLimit, newRoom, newRoomId, parseBody, CREATE_LIMIT, ROOM_ID_RE } = roomHostLib;
const cardFor = board.makeCardFor({ bingoGenerator, bingoList });
const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const VERBS = { info: "GET", join: "POST", state: "GET", events: "GET", action: "POST" }; // the public ones
const PING_MS = 15_000; // keeps streams alive; a failed ping is how a closed page is noticed

export default {
  async fetch(request, env) {
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "rooms") return json(404, { error: "Not found." });
    if (parts.length === 2 && request.method === "POST") return createRoom(request, env);
    const [, , id, verb] = parts;
    if (parts.length !== 4 || !ROOM_ID_RE.test(id) || VERBS[verb] !== request.method) return json(404, { error: "Not found." });
    return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(request);
  },
};

async function createRoom(request, env) {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const limiter = env.LIMITS.get(env.LIMITS.idFromName("room-creation"));
  const verdict = await (await limiter.fetch("https://limits/allow", { method: "POST", body: JSON.stringify({ key: address }) })).json();
  if (!verdict.ok) return json(429, { error: "That's a lot of new rooms from here in the last hour. Try again later." });
  const body = await request.text();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newRoomId();
    const res = await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(`https://rooms/api/rooms/${id}/create`, { method: "POST", body });
    if (res.status !== 409) return res; // 409: that code is already a room
  }
  return json(503, { error: "Couldn't find a free room code. Try again." });
}

export class RoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.host = null; // null until the room exists (or after it's deleted)
    this.alarmAt = null;
    ctx.blockConcurrencyWhile(async () => {
      const room = await ctx.storage.get("room");
      if (room) this.host = this.makeHost(room);
    });
  }

  makeHost(room) {
    return new RoomHost(room, {
      save: (r) => { this.ctx.storage.put("room", r); }, // Durable Objects hold responses until writes are stored
      schedule: (at) => {
        if (at === this.alarmAt) return;
        this.alarmAt = at;
        this.ctx.storage.setAlarm(at);
      },
    });
  }

  // /api/rooms/<code>/<verb>: create (only from createRoom above), info, join, state, events, action.
  async fetch(request) {
    const url = new URL(request.url);
    const [, , id, verb] = url.pathname.split("/").filter(Boolean);
    try {
      if (verb === "create") return await this.create(id, request);
      if (!this.host) return json(404, { error: "There's no room with that code." });
      if (this.host.wake() === "expired") { await this.deleteRoom(); return json(404, { error: "There's no room with that code." }); }
      const token = url.searchParams.get("t") || "";
      if (request.method === "GET" && verb === "events") return this.events(token);
      const body = request.method === "POST" ? parseBody(await request.text()) : {};
      const r = await this.host.handle(request.method, verb, token, body);
      return json(r.status, r.body);
    } catch (e) {
      if (e.status === 400) return json(400, { error: e.message });
      console.error(e.stack || String(e));
      return json(500, { error: "Something went wrong on the server." });
    }
  }

  async create(id, request) {
    if (this.host) return json(409, { error: "That room code is taken." });
    const input = parseBody(await request.text());
    try {
      const { room, token } = await newRoom(id, input, { cardFor, now: Date.now() });
      this.host = this.makeHost(room);
      this.host.changed(); // stores it and sets the alarm
      return json(200, { id, token });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  // The live update stream (Server-Sent Events) for one open page.
  events(token) {
    if (!this.host.playerOf(token)) return json(403, { error: "Join the room first." });
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let close = () => {};
    let ping = null;
    const stop = () => { clearInterval(ping); close(); close = () => {}; writer.close().catch(() => {}); };
    const send = (text) => { writer.write(encoder.encode(text)).catch(stop); };
    close = this.host.openStream(token, send);
    ping = setInterval(() => send(": ping\n\n"), PING_MS);
    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  }

  async alarm() {
    this.alarmAt = null;
    if (this.host && this.host.wake() === "expired") await this.deleteRoom();
  }

  // A week without activity: forget the room entirely (its code can be used again).
  async deleteRoom() {
    this.host = null;
    this.alarmAt = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export class CreateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limit = new RateLimit(CREATE_LIMIT.max, CREATE_LIMIT.windowMs);
  }

  // POST { key }: may this address create another room? Answers { ok }.
  async fetch(request) {
    const { key } = await request.json();
    return Response.json({ ok: this.limit.allow(String(key), Date.now()) });
  }
}
