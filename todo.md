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

## Phase 2 — Combat  ✅ DONE
- [x] Fire input + server-side **hitscan raycast** (ray-vs-AABB; server owns fire-rate cooldown)
      25 dmg/shot, ~0.12s fire interval, 100u range; skips dead/self
- [x] Health, damage, death, respawn (100 HP, death at 0, 2s respawn to a fresh spawn)
- [x] Crosshair + hitmarker + damage feedback (red flash) + cosmetic tracer on client
- [x] HUD: health  (ammo deferred to Phase 3 — it belongs with the weapon/reload model)
- [x] Verify: 4 hits down a target, victim sees ELIMINATED overlay, respawns to full (cross-tab)

## Phase 3 — Make it a game  ✅ DONE
- [x] Arena with cover boxes + server-side collision (7 obstacles, axis-separated slide;
      single source of truth in Arena.cs, sent to clients in welcome). Hitscan blocked by walls.
- [x] Spawn points (8 points; pick farthest from live enemies, random tie-break)
- [x] Player names (join message; default Blitzer-xxxx; floating name tags + persisted locally)
- [x] Scoreboard / kill tracking (hold Tab; kills/deaths, sorted; live)
- [x] Weapon model: gun viewmodel w/ recoil, 30-round mag, ~0.12s fire, 1.6s reload (R or auto), ammo HUD
- [x] Verify (cross-tab): never penetrates cover; shots blocked by wall (0 hits) but land with clear LOS;
      ammo 30→0→reload→30; kills/deaths increment; names + tags propagate

## Phase 4 — Netcode quality (DO BEFORE going live over the tunnel)  ✅ CORE DONE
> Smoothness (high-refresh display vs low network rate) was the strafe judder — now fixed by
> prediction + interpolation. Server processes a per-player input queue with seq/ack.
- [x] Client-side prediction of own movement (identical sim math client+server; camera from predicted pos)
- [x] Server reconciliation (per-player input queue, seq/ack; client replays unacked inputs)
      Verified: error 0.1u while moving, 0 at rest, pending inputs bounded — no drift/snap.
- [x] Entity interpolation for other players (render ~100ms in the past; verified 96ms, fractional renderTick)
- [x] Lag compensation for hitscan (server keeps 64-tick position history, rewinds targets to the
      shooter's renderTick). Hit-reg verified; full moving-target benefit needs real WAN latency to see.
- [ ] Switch JSON -> binary serialization for bandwidth/perf  (DEFERRED: pure optimization, no feel
      impact; adds protocol fragility. Revisit only if bandwidth becomes a real constraint.)
- [ ] Snapshot/delta compression (only send what changed)     (DEFERRED: same rationale.)

## Phase 5 — Ship (Cloudflare tunnel)  ✅ DONE (except live external test)
- [x] Dockerize server; server serves the client (multi-stage .NET 10; CLIENT_PATH).
      Verified: image builds, container serves index.html/game.js, /health=ok, WS connects, 60Hz loop.
- [x] Config via env: ASPNETCORE_URLS (port), MaxPlayers, CLIENT_PATH.
      (Tick/broadcast rate left as compile-time consts — sim fundamentals, not deploy knobs.)
- [x] Cloudflare tunnel wiring: client auto-picks wss:// over HTTPS; docker-compose service
      `blockblitz:8080` as the origin; optional cloudflared service stubbed; documented in README.
- [x] Hardening baseline: authoritative server + input validation (NaN/Inf, pitch clamp),
      input-queue & message-size caps, MaxPlayers connection limit.
- [ ] Test end-to-end over the tunnel from an external network  (USER ACTION: needs your CF
      dashboard route + an off-LAN device — see README "Deploy behind a Cloudflare tunnel")

---

## Someday / nice-to-have
- [x] Sound effects (Web Audio) — procedural synthesis (no asset files): shoot/reload/
      dry-fire/hitmarker/damage/death/footstep/switch, see `client/audio.js`
- [x] Multiple weapons — Pistol/SMG/Rifle/Shotgun, server-authoritative (`server/Weapons.cs`),
      switch with 1-4, shotgun does multi-pellet spread, pistol is semi-auto (edge-triggered)
- [x] Simple player/weapon models — no asset pipeline, so both are built from Babylon
      primitives (boxes + a cylinder barrel), matching the game's existing low-poly look:
      4 distinct weapon shapes shared between the first-person viewmodel and what other
      players are shown holding (`buildWeaponMesh` in `client/game.js`), and a torso/head/
      arm player silhouette sized to match the server hitbox exactly.
- [x] Weapon pickups — players now start with only a knife (melee, infinite ammo, always
      owned, weapon slot 0). Pistol/SMG/Rifle/Shotgun are gained by walking within ~1.1u of
      a fixed map location (`Arena.WeaponPickups`), shown as a glowing disc with a
      slow-spinning copy of the weapon floating above it (reuses `buildWeaponMesh`) so it's
      obvious what's on offer. Picking one up marks it unavailable for 25s (`server/
      GameServer.cs`); ownership persists across respawns; the server rejects switching to
      an unowned weapon. Keys are now 1-5 (knife first).
- [ ] Game modes (TDM, FFA, rounds)
- [ ] Simple lobby / room codes for private matches
- [ ] Spectator mode
