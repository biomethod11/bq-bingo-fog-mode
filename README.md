# Beta Quest Bingo Fog Mode

**Bingo where you can't see the card.**

In regular bingo all 25 goals are on screen from the first second, so the route is planned before anyone moves. In
Fog Mode the [Beta Quest](https://github.com/mzxrules/Beta-Quest) card starts hidden. You see two squares, and every
goal you claim reveals more. You're scouting and racing at the same time, and your opponent is looking at a
different board from you.

**Play it free at https://fog-mode.bq-bingo.workers.dev.** No account needed: make a room and share the link, like
BingoSync.

## What makes it different

- **The card is hidden.** Each color starts with the center square and one random edge square, or with Easy start,
  on its easiest goals, so nobody opens on a goal that takes hours. Claiming a goal reveals the squares around it, so
  every claim is also a scouting move.
- **Everyone has their own fog.** You only see what your color has uncovered. Other players' claims show only as
  their color until you uncover the square yourself. Teammates on the same color share their view.
- **You choose how the fog lifts.** Reveal the 4 or 8 squares around each claim, aim reveals at squares next to
  yours, or earn Free Reveals to use anywhere. Optional Bonus Reveal Squares are hidden in the fog.
- **Draft mode.** Before the card appears, the players take turns drafting its goals from an alphabetical list. You
  know which goals are yours, but not where they are. With Reverse Draft you pick your opponent's goals instead.
- **Claims stay secret for 5 seconds.** Only your color sees a new claim until its timer runs out, so a misclick can
  be taken back. If two players claim the same square in that window, the first click wins: *Snipe!*
- **No peeking.** The server sends each player only what they're allowed to see, so the browser's developer tools
  can't lift the fog.
- **The same fair card.** 5x5 is the exact BingoSync Beta Quest card for a secret seed. 4x4 and 6x6 cards use the
  same goals, laid out so every line is about as hard as the others.

## How a game goes

1. Create a room: pick a nickname, a color and the settings, then share the link. Players on the same color are a
   team.
2. Everyone loads the Beta Quest filename shown in the room. The card appears, and the clock starts, once every
   color presses **Ready**. In a Draft room, the draft comes first.
3. Click a revealed square to claim it. Its reveals land when the undo timer runs out.
4. You set the win condition: a line, most squares, blackout. When it's met, anyone presses **End the game** and
   the whole card is revealed.

Spectators can watch the whole card, or exactly what any one player sees. There's also a streamer mode that hides
the room code, and note symbols you can put on squares (right-click, Ctrl, Alt or Shift+click).

## Settings

| Setting | Options |
|---|---|
| Board | 4x4, 5x5 (the BingoSync card), 6x6 |
| Claim Mode | Reveal 4 or 8 around the claim; Choose 1–3 squares next to yours; Free 1–3 reveals anywhere |
| Lockout | On (one color per square) or off |
| Claim undo timer | 5 seconds by default; 1–10 or off in lockout rooms |
| Shared fog | Everyone sees every reveal |
| Easy start | Start on your 1–4 easiest goals instead of the center and an edge square |
| Draft | Draft the goals first, or pick your opponent's (Reverse Draft) |
| Extras | Starting Free Squares, Starting Free Reveals, Bonus Reveal Squares, room password, shared note symbols |

The **? Help** button in the app explains every setting. Combinations that played badly in simulated games are
greyed out.

## Run it yourself

You need Node 20 or newer. BingoSync's card generator has no licence, so it isn't in this repository: download it
once with `npm run fetch-generator`.

```sh
npm install
npm run fetch-generator
npm start                 # http://localhost:8787/
npm test
```

The public site runs on Cloudflare Workers, with each room as a Durable Object. The Workers Free plan is enough for
casual use. `npm run dev:cloudflare` runs that version locally, and `npm run deploy:cloudflare` deploys it (run
`npx wrangler login` once first).

## Under the hood

| File | What it does |
|---|---|
| `fog_logic.js` | The rules, including exactly what each player is allowed to see |
| `room_host.js` | A live room: its API, live updates, timers and passwords |
| `fog.html` | The whole page |
| `fog_server.js`, `cloudflare/` | The Node server and the Cloudflare Worker, which run the same room code |
| `board.js` | Builds the 4x4, 5x5 and 6x6 cards |
| `simulate.js` | Over 100,000 bot games through the real rules, used to tune the settings and the recommended player counts |
| `test_fog.js` | The tests |

## Credits

- [BingoSync](https://github.com/kbuzsaki/bingosync) for the Beta Quest card generator
- [Beta Quest](https://github.com/mzxrules/Beta-Quest), the mod this is played on
- MIT licence (`LICENSE`)
