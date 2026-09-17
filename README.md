# Carmine (Swarm): Two-Player Real-Time Strategy Game

*Why Carmine? Carmine dye is made from swarms of cochineal insects.*

Carmine was the prototype for [Merlot](https://veered.org/merlot/): the swarm battle it started as grew into Merlot's team strategy game.

**Play it now: [swarm.veered.org](https://swarm.veered.org)** · more games at [veered.org](https://veered.org)

![Swarm](docs/screenshot.jpg)

Swarm is a free two-player real-time strategy game that runs in the browser. Each
side starts with a base and a stream of minions. Drag-select your minions, send them
at the towers, and capture your opponent's base. Nothing to install, no account needed:
share the link and play.

## Please test before relying on it

This is shared as-is, with no warranty. It works on my own computers, but your system,
settings and software versions may differ, so please try it in a safe setting first.
If something doesn't work, you can ask Claude (or another AI coding assistant) to look
into it, and I'd appreciate hearing what you found and how you fixed it. You are also
welcome to just let me know at support@veered.org, and I'll look into it.

## Put your own copy on the internet

You do not have to be a programmer, and it costs nothing to start: the game is hosted by
Cloudflare, who will run something this small for free, and a domain name of your own is
about $10 a year if you want one.

1. **Get the game.** Download the source (the button at the top of this page) and unzip
   it. You now have a folder called `carmine-swarm`.
2. **Open a free Cloudflare account** at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). An email address
   and a password; no card needed.
3. **Install Node.js** from [nodejs.org](https://nodejs.org) — take the version it
   offers — and install it like any other program. This is what does the uploading.
4. **Open a terminal** in that folder (on Windows, right-click the folder and choose
   "Open in Terminal"; on a Mac, Terminal) and type these two lines, one at a time:

```bash
npm install
npx wrangler deploy
```

The first collects the pieces the game needs; the second signs you in to Cloudflare in a
browser window and then prints a web address ending in `workers.dev`. That is your copy —
send the link to whoever you want to play against.

To try it on your own computer first, type `npx wrangler dev` instead and open
`http://localhost:8787` in two tabs. If something goes wrong, paste the error into
Claude and ask what it means.

## Information for nerds

- **Server:** a Cloudflare Worker with Durable Objects (`src/`). One `Room` Durable
  Object holds the players' WebSockets and runs the 20 Hz simulation tick
  (`src/game.js`). The tick stops when the room empties so the object can be evicted.
- **Client:** a single self-contained page (`public/index.html`). Sound effects are
  synthesised with the Web Audio API, so there are no audio assets.
- **Stats:** a `Stats` Durable Object keeps one row per finished match, readable at
  `/api/stats?key=STATS_KEY&days=N`.

- **Requirements:** Node.js 22 or later.
- **Optional settings:** `cp .dev.vars.example .dev.vars` for local runs; `STATS_KEY` is
  set in production with `npx wrangler secret put STATS_KEY`.
- **Your own hostname:** uncomment the `[[routes]]` block in `wrangler.toml` and deploy
  again.

## Credits and licenses

- Code: MIT. See [LICENSE](LICENSE).
- No third-party art, fonts or sound files are included. Sounds are generated in the browser.
- The gameplay is inspired by classic Flash-era browser strategy games. Swarm is not
  affiliated with or endorsed by any of their publishers.
- Swarm was written with AI assistance (Claude).
