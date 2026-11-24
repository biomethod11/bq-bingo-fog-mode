# Beta Quest Bingo Fog Mode

Bingo for the Ocarina of Time [Beta Quest](https://github.com/mzxrules/Beta-Quest) mod where **the card starts
hidden**: you only see the squares your color has revealed, and every claim reveals more. The card is the normal
[BingoSync](https://bingosync.com) Beta Quest card for a secret card seed, so lines stay balanced; the fog is the new
part. Players set their own win condition (a line, most squares, blackout...) and end the game themselves.

**Play it at https://fog-mode.bq-bingo.workers.dev.** Everyone opens the same room link, like BingoSync. The **? Help** button on every
page explains the settings and rules.

The server builds the card and sends each color only what it may see, so the fog can't be lifted with the browser's
developer tools.

## How a game goes

1. On the main page, enter a **nickname**, pick a **color**, choose the settings and **Create room**.
2. Share the room link (`/r/<code>`, or **Copy room link**). Everyone opens it, picks a nickname and color (people
   on the same color are a team and share fog), and joins, or clicks **Spectate**. Spectators see the whole card,
   with a colored edge showing which colors have revealed each square and the squares nobody has revealed faded;
   each player's button shows only what that player can see.
3. Everyone loads the Beta Quest filename shown at the top. The card stays hidden until **every color presses
   Ready**, and the clock starts then. Someone who leaves first doesn't hold everyone up: once their page has been
   closed for 30 seconds they stop counting, and if they aren't back when everyone else is ready the game starts
   without them (they can watch, or join late).
4. **One click claims** a revealed square. Until the **claim undo timer** runs out (5 seconds unless a lockout room
   changed it) only your color sees the claim, with a countdown; clicking it again or **Undo** takes it back. Then
   it takes effect: everyone sees it and its reveals land. After that, click your own square to ask for an undo,
   which another color allows or denies. In lockout, if two players claim the same square before their timers run
   out, the first click gets it and the log says "Snipe! Ann sniped Bo on …".
5. **Note symbols:** right-click puts a silver ★ on a square, Ctrl+click a ☐, Alt+click an ✕, Shift+click a ○. They
   never claim anything and work on fogged squares too. Each is private, shared with your color, or shared with
   everyone, as the room was set up.
6. When the players' own win condition is met, anyone presses **End the game**. Everyone then sees the whole card,
   both seeds and each color's square count.

Your place in a room is kept per browser tab: refreshing keeps you in, and a new tab gets the join form.

**Streaming.** Tick **Hide the room code** on the main page, or press **Hide code** in a room: the code shows as
`••••••`, the address bar shows `/play` instead of `/r/<code>`, and **Copy room link** still copies the real link.
The board never moves on the page during a game (messages appear in the side column), so a scene cropped to the
board stays lined up.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Board | 5x5 | **5x5** is the exact BingoSync card for the card seed. **4x4** and **6x6** are built from the same Beta Quest goals and difficulty tiers: laid out on a magic square so every row, column and long diagonal has about the same total difficulty (within 2), with no two goals sharing a "types" tag on a line, no repeats, and the same card every time for a given seed |
| Claim Mode | Reveal 4 | **Reveal 4** (up, down, left, right) or **Reveal 8** (diagonals too): the squares around the claim appear. **Choose 1/2/3**: you get that many adjacent reveals, each for a fogged square touching one of your color's squares (diagonals count); click such a square to spend one (eye cursor). **Free 1/2/3**: you get that many Free Reveals, each for any fogged square; press **Choose FREE reveal**, then click the square. On 5x5, 2 of either kind shows about as much as Reveal 4 and 3 about as much as Reveal 8 |
| Lockout | on | Off (BingoSync "non-lockout"): several colors can mark the same square, shown as split color bands |
| Claim undo timer | on, 5 s | Lockout only: 1–10 seconds, or off. Until the timer runs out only your color sees a new claim, you can take it back, and a same-square race goes to the first click. Off: claims take effect at once. Rooms without lockout always use 5 seconds |
| Shared fog | off | On: one view for everyone, so every reveal shows for every color |
| Starting Free Squares | off | 1–3 per color, claimed without doing the goal (press **Choose FREE square** first). A Free Square shows **striped, with a dashed border and a FREE tag**, even in the fog |
| Free Square Reveals | on | Off: a Free Square doesn't reveal anything or give any reveals |
| Starting Free Reveals | off | 1–3 Free Reveals per color at the start |
| Bonus Reveal Squares | off | 1–6 hidden squares, never on the center. Shown as ◆ once revealed; claiming one gives +1 Free Reveal |
| Room password | none | Optional, anything up to 64 characters ("1234" is fine). Everyone who joins or spectates must enter it (spectators see the whole card); players already in the room aren't asked again. The server keeps only a salted PBKDF2 hash and takes at most 10 wrong guesses a minute per room. The link alone still shows the join form (who's in the room and the filename), but nothing more |
| Note symbols | all private | Per symbol: **Private** (kept only in your browser), **Shared with my color** (underlined in it), or **Shared with everyone** (drawn in the placer's color). You can only remove your own color's symbols |

Every room is **Open**: players decide the win condition. (The rules still know Line, Sprint and Corners goals, and
the simulator plays them, so they can come back.)

**Combinations that aren't allowed.** Simulated games showed these don't work, so the create page greys them out and
the server refuses them (the page loads the server's own rules file, `/rules.js`, so the two always agree): shared fog
with Choose 3 or Free 3 (nearly the whole board ends up seen); 4x4 with Reveal 8, Choose 3 or Free 3; and 4x4 with
shared fog and anything other than Choose 1 or Free 1 (86-99% of the board ends up seen).

## Rules

- **Colors:** 10 presets, picked so every pair stays clearly different, including under the three common kinds of
  color blindness (CIEDE2000 at least 20 apart with normal vision, at least 10 in protan, deutan and tritan
  simulations), every color stands out from an empty square, and all text on a color meets WCAG 4.5:1 contrast
  (`palette_check.py` checks this). People on the same color are a team and share fog.
- **Start:** every color sees the center square plus one random edge or corner square, a different one for each
  color. 4x4 and 6x6 have no single center, so you get the central square nearest your edge square.
- **Player limits:** a lockout room takes 4 players, a non-lockout room 16 (spectators don't count). The join form
  and Help recommend a maximum for each board and setting, from simulated games (below).
- **Leaving before the start:** only colors with someone present have to press Ready. If the game starts while
  nobody on a color is there, that color is out: its players become spectators and can join again, late.
- **Waiting claims are secret:** while a claim's timer runs, other players and spectators get no mark, no log line,
  no change in the counts, and not even a pushed update, so the timing of a click doesn't leak either. In lockout the
  claimer's square flashes until it takes effect, because someone who clicked first can still snipe it.
- **Other colors:** their claims show as color only; you can't read a square you haven't revealed.
- **Boxed in:** if your color has nothing it can claim and no reveal to spend, you get a bonus Free Reveal.
- **Undo after the timer:** ask to undo your own claim; another color allows or denies it (solo: automatic).
  Revealed squares stay revealed.
- **End:** any player presses **End the game**. Claims still waiting take effect first (earliest click first).
- **Rooms** are deleted after a week without activity.
- **Honor system, like BingoSync:** anyone with the room link (and password) can join as any color or spectate.

## Running it yourself

Node 20 or newer. The runtime needs no npm packages; `npm install` only fetches Wrangler, Cloudflare's tool, for the
Cloudflare version.

BingoSync's generator files state no licence, so this repository doesn't include them. Download them once (from
BingoSync's repository at a pinned commit, checked against their SHA-256) before anything else:

```sh
npm install
npm run fetch-generator
```

**On your own machine or network** (the Node server, which keeps each room as a JSON file in `rooms/`):

```sh
npm start                      # http://localhost:8787/
node fog_server.js --host 0.0.0.0 --port 8787 --rooms ./rooms   # reachable from your network
```

To play with friends elsewhere, a Cloudflare quick tunnel needs no account: `cloudflared tunnel --url
http://localhost:8787` prints a public address to share.

**Tests:** `npm test` (the rules, and the Node server over HTTP, including "a player's JSON never contains a goal
they haven't revealed" and real-clock checks of the claim timer and of players leaving before the start).

**On Cloudflare** (how the public site runs: one Worker serving the page, each room a Durable Object; the Workers
Free plan is enough for casual use):

```sh
npm run dev:cloudflare         # the Cloudflare version locally, no account needed: http://localhost:8788/
npx wrangler login             # once
npm run deploy:cloudflare
```

## How it's built

| File | What |
|---|---|
| `fog_logic.js` | The rules: joining, start squares, player limits, fog, claims and the claim undo timer, reveals, Free Squares, Free Reveals, Bonus Reveal Squares, undo, and exactly what each player may see. Pure code, no I/O. Its top comment lists the names the code uses for each setting (`lens` = Free Reveals, `chests` = Bonus Reveal Squares, ...) |
| `room_host.js` | One live room, the same on both platforms: the room's API, live updates (Server-Sent Events) that only go to pages whose view changed, timers, passwords, room expiry |
| `fog.html` | The whole page: main page, join form, the room, and Help |
| `fog_server.js` | The Node server: rooms as JSON files, timers, HTTP |
| `cloudflare/` | The Cloudflare version: `worker.js` (the API and the room Durable Objects), `wrangler.toml`, `build.js` (builds the site's files and the generator module), `dev.js` |
| `board.js` | Builds the card: 5x5 with BingoSync's generator (the exact BingoSync card); 4x4 and 6x6 from the same goals, balanced on a magic square |
| `load_generator.js` | Downloads and loads BingoSync's generator (`npm run fetch-generator`) |
| `simulate.js` | Plays bot games through the real rules on real cards (`simulation_results.json`, `simulation_players.json`) |
| `palette_check.py` | Scores the player colors (color difference, color-blind simulations, text contrast) |
| `test_fog.js` | The tests |

## Simulated games

`node simulate.js` plays 400 1v1 bot games for each of 288 setting combinations (3 sizes × 3 goals × lockout on/off ×
shared fog on/off × 8 claim effects, including combinations the page blocks) through `fog_logic.js` on real cards. The
model: a goal of difficulty tier t takes about 3 + 0.55·t minutes (±35%); bots race for the first line as a stand-in
for Open, chase the cheapest finishable shape, block an opponent one square from winning, spend reveals at once on the
most useful squares, and drop a goal when someone else claims it. Treat the minutes as relative.

| Finding | Numbers | What was done |
|---|---|---|
| Nothing breaks | 0 hung games, 0 runaway games, nobody permanently stuck, in 115,200 games | — |
| No first-player advantage | first joiner wins about 50% | — |
| Game lengths | Line 51 min (4x4: 41, 6x6: 61), Sprint 36 | — |
| How much a claim reveals | Board seen by the end (5x5): Reveal 4 51%, Reveal 8 59%; Free 1 24%, 2 43%, 3 61%; Choose 1 24%, 2 41%, 3 53% | 1/2/3 offered (4 and 6 were too much or went unused) |
| Shared fog roughly doubles what everyone sees | Reveal 4: 51% → 77%; 3 reveals per claim: 83-98% | **Blocked**: shared fog with 3 reveals per claim |
| 4x4 is lightly fogged | 62% seen with Reveal 4; 86-99% with shared fog unless 1 reveal per claim | **Blocked**: 4x4 with Reveal 8 or 3 reveals; 4x4 shared fog unless 1 reveal |

### How many players

`node simulate.js --players` (600 games per row) plays 2 players up to the room limit on each board, with private and
shared fog. A player count **plays well** when under 10% of games end with no line left for anyone, under 10% of
players get boxed in, and players see at most 85% of the board by the end. The recommendation is the largest count
that plays well with every smaller count also playing well:

| Board | Lockout, private fog | Lockout, shared fog | Non-lockout, private fog | Non-lockout, shared fog |
|---|---|---|---|---|
| 4x4 | **3** (4: 24% of games with no line left, 16% boxed in) | **2** (3: 88% seen) | any (10 colors fine) | **2** (4: the whole board seen) |
| 5x5 | **3** (4: 14% no line left, 9% boxed in) | **2** (3: 90% seen, 16% no line left) | any | any (10 colors: 73% seen) |
| 6x6 | **4** (8% no line left, 8% boxed in) | **2** (3: 81% seen, 10% no line left) | any | any (10 colors: 67% seen) |

These numbers live in `RECOMMENDED` in `fog_logic.js`; the page reads them from there.

## Credits and licences

- This project: MIT licence (`LICENSE`).
- [BingoSync](https://github.com/kbuzsaki/bingosync): the Beta Quest card generator. Its files state no licence, so
  they aren't in this repository; `npm run fetch-generator` downloads them at a pinned commit, and the deployed
  Worker bundles that copy so the 5x5 card matches BingoSync's exactly.
- [Beta Quest](https://github.com/mzxrules/Beta-Quest): the mod this bingo is played on.
