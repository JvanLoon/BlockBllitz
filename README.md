# BlockBlitz

A fast, competitive **3D multiplayer arena shooter**.

- **Client:** Babylon.js (WebGL), served as static files. First-person, WASD + mouse-look,
  hitscan shooting, cover, name tags, scoreboard.
- **Server:** ASP.NET Core (.NET 10). `LobbyManager` runs many independent authoritative
  matches (`Lobby`) concurrently — each with its own players and 60 Hz tick loop — created
  on demand via the server browser and addressed by a short join code. Clients send
  *inputs only*.
- **Netcode:** client-side prediction + reconciliation, entity interpolation (~100 ms), and
  hitscan lag compensation. See [`todo.md`](todo.md) for the full roadmap and what's deferred.

On load: pick a name, then the server browser — create a lobby (name + max players) or join
one from the list / by its code. Controls once in a match: **WASD** move · **mouse** look ·
**click** attack · **1-5** weapon · **R** reload · **Tab** scoreboard · **Esc** release.

---

## Run locally (no Docker)

```bash
dotnet run --project server --no-launch-profile -- --urls http://0.0.0.0:8080
```

Open <http://localhost:8080> in a **real browser window** (pointer lock needs a top-level page).
Open a second window to have someone to shoot. Binds `0.0.0.0`, so other machines on your LAN can
reach it at `http://<your-ip>:8080`.

## Run with Docker

The image builds the server and bundles the client; the server serves both.

```bash
docker compose up -d --build
```

Then browse to <http://localhost:8080>. Stop with `docker compose down`.

## Configuration (env)

| Variable          | Default              | Meaning                                             |
|-------------------|----------------------|-----------------------------------------------------|
| `ASPNETCORE_URLS` | `http://0.0.0.0:8080`| Listen address/port.                                |
| `MaxPlayers`      | `16`                 | Per-lobby player cap ceiling — a creator's requested lobby size is clamped to this (sends `full` past it). |
| `CLIENT_PATH`     | `/client` (Docker)   | Where the static client lives. Dev falls back to `../client`. |

Tick rate (60 Hz) and broadcast rate (60 Hz) are compile-time constants in
[`server/Lobby.cs`](server/Lobby.cs).

## Deploy behind a Cloudflare tunnel

The client auto-selects `wss://` when served over HTTPS, and Cloudflare tunnels pass WebSocket
upgrades through by default — so no client change is needed to go live.

### Quick testing tunnel (no account/token needed)

`docker-compose.yml` currently runs a Cloudflare **quick tunnel** by default: `docker compose up
-d --build` also starts a `cloudflared` container that opens a random `https://<random-words>
.trycloudflare.com` URL pointing at the game. Grab the URL from its own log stream (not the game's):

```bash
docker compose logs cloudflared | grep trycloudflare
```

Open that URL from an external network (e.g. phone on mobile data) to playtest with real internet
latency. The URL changes every time the container restarts — fine for a quick remote check, not a
stable link, and not meant to stay up unattended. `GET /health` on that URL returns `ok`.

### Stable tunnel for going live

1. Bring the game up (its Docker service is named `blockblitz`, listening on `:8080`).
2. Point your Cloudflare **named tunnel** at it. In the CF dashboard, add a public hostname route
   with **origin `http://blockblitz:8080`** (the `cloudflared` container must share this compose's
   network so the service name resolves). Swap the quick-tunnel `cloudflared` service in
   [`docker-compose.yml`](docker-compose.yml) for the commented-out named-tunnel one below it, and
   set `TUNNEL_TOKEN`.
3. Verify end-to-end from an **external network** (not your LAN): open the public URL, confirm the
   page loads over HTTPS and the WebSocket connects (`wss://`), then play.

> Note: this is when the netcode earns its keep — real internet latency is where prediction,
> interpolation, and lag compensation make the difference.

## Hardening baseline

The server is authoritative for position, fire rate, ammo, and hits. It also validates inputs
(rejects NaN/Inf, clamps pitch), caps the per-connection input queue and message size, and limits
concurrent players. This is a baseline, not full anti-cheat.
