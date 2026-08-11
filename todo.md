# BlockBlitz — TODO / Roadmap

A fast, competitive **3D multiplayer arena shooter**.
Client: **Babylon.js** (WebGL). Server: **ASP.NET Core** authoritative WebSocket server (C#, .NET 10).
Testing **LAN/local first**; goes live later behind a **Cloudflare tunnel**.

**Golden rule (design for it from day 1):** the server is authoritative. Clients send
*inputs only* ("holding W", "firing at angle X"), never positions. Server simulates the
world on a fixed tick and broadcasts state. This is what makes prediction/interpolation a
bolt-on later instead of a rewrite.

---

## Phase 0 — Decisions & scaffold
- [x] Lock stack: Babylon.js client + ASP.NET Core raw-WebSocket server, JSON messages, authoritative
- [x] Create project structure (`/server`, `/client`)
- [x] Name the game: **BlockBlitz**
- [x] `git init` + initial commit (workflow: commit, never push — user pushes from Windows)
- [x] Pick server tick rate (60 Hz sim) and network send rate (30 Hz broadcast)

## Phase 1 — Walking skeleton (two tabs moving on LAN)  ✅ DONE
- [x] ASP.NET Core app: serve the static client from `/client`
- [x] WebSocket endpoint (`/ws`) with connect/disconnect handling
- [x] Babylon.js scene: grid arena floor, lighting, corner pillars, camera
- [x] Pointer Lock API + WASD/mouse-look input capture on client
- [x] Client sends input snapshots to server (60Hz)
- [x] Server fixed-timestep tick loop (60Hz); integrates movement from inputs
- [x] Server broadcasts world state (30Hz); client renders other players as boxes
- [x] Verify: two browser tabs move independently, cross-client propagation, clean join/leave
      (movement confirmed server-authoritative at 6 u/s; disconnect removes the box)

## Phase 2 — Combat
- [ ] Fire input + server-side **hitscan raycast** (shooter's view ray vs player capsules)
- [ ] Health, damage, death, respawn
- [ ] Crosshair + hitmarker + damage feedback on client
- [ ] HUD: health, ammo

## Phase 3 — Make it a game
- [ ] Arena with cover boxes + server-side AABB/capsule collision
- [ ] Spawn points
- [ ] Player names
- [ ] Scoreboard / kill tracking
- [ ] Weapon model with fire rate, reload, ammo count

## Phase 4 — Netcode quality (DO BEFORE going live over the tunnel)
> Not needed on LAN (~0 latency) for *responsiveness*. But note *smoothness* (high-refresh
> display vs low network rate) shows up even on LAN — see the strafe-judder issue.
> Interim mitigation applied: broadcast bumped to 60Hz. Real fix is prediction + interpolation below.
- [ ] Client-side prediction of own movement
- [ ] Server reconciliation (correct client when it mispredicts)
- [ ] Entity interpolation for other players (render slightly in the past, smooth)
- [ ] Lag compensation for hitscan (server rewinds targets to shooter's view time)
- [ ] Switch JSON -> binary serialization for bandwidth/perf
- [ ] Snapshot/delta compression (only send what changed)

## Phase 5 — Ship (Cloudflare tunnel)
- [ ] Dockerize server; server serves the built client static files
- [ ] Config via env: ports, tick rate, max players
- [ ] Cloudflare tunnel: ensure WebSocket upgrade passes; origin `http://web:PORT`
- [ ] Basic rate limiting / input validation / sanity checks (anti-cheat baseline)
- [ ] Test end-to-end over the tunnel from an external network

---

## Someday / nice-to-have
- [ ] Sound effects (Web Audio)
- [ ] Simple player/weapon models + animations (glTF)
- [ ] Multiple weapons
- [ ] Game modes (TDM, FFA, rounds)
- [ ] Simple lobby / room codes for private matches
- [ ] Spectator mode
