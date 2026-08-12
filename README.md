# BlockBlitz

A fast, competitive **3D multiplayer arena shooter**.

- **Client:** Babylon.js (WebGL), served as static files. First-person, WASD + mouse-look,
  hitscan shooting, cover, name tags, scoreboard.
- **Server:** ASP.NET Core (.NET 10), authoritative WebSocket game server. 60 Hz simulation,
  60 Hz broadcast. Clients send *inputs only*.
- **Netcode:** client-side prediction + reconciliation, entity interpolation (~100 ms), and
  hitscan lag compensation. See [`todo.md`](todo.md) for the full roadmap and what's deferred.

Controls: **WASD** move · **mouse** look · **click** shoot · **R** reload · **Tab** scoreboard · **Esc** release.

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
| `MaxPlayers`      | `16`                 | Reject new connections past this (sends `full`).    |
| `CLIENT_PATH`     | `/client` (Docker)   | Where the static client lives. Dev falls back to `../client`. |

Tick rate (60 Hz) and broadcast rate (60 Hz) are compile-time constants in
[`server/GameServer.cs`](server/GameServer.cs).

## Deploy behind a Cloudflare tunnel

The client auto-selects `wss://` when served over HTTPS, and Cloudflare tunnels pass WebSocket
upgrades through by default — so no client change is needed to go live.

1. Bring the game up (its Docker service is named `blockblitz`, listening on `:8080`).
2. Point your Cloudflare **named tunnel** at it. In the CF dashboard, add a public hostname route
   with **origin `http://blockblitz:8080`** (the `cloudflared` container must share this compose's
   network so the service name resolves). An optional `cloudflared` service is stubbed in
   [`docker-compose.yml`](docker-compose.yml) — uncomment it and set `TUNNEL_TOKEN`.
3. Verify end-to-end from an **external network** (not your LAN): open the public URL, confirm the
   page loads over HTTPS and the WebSocket connects (`wss://`), then play. `GET /health` returns `ok`.

> Note: this is when the netcode earns its keep — real internet latency is where prediction,
> interpolation, and lag compensation make the difference.

## Hardening baseline

The server is authoritative for position, fire rate, ammo, and hits. It also validates inputs
(rejects NaN/Inf, clamps pitch), caps the per-connection input queue and message size, and limits
concurrent players. This is a baseline, not full anti-cheat.
