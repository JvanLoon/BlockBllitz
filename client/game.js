"use strict";

// This file does nothing at load time — no scene, no canvas draw, nothing in the
// background. lobby.js owns name entry + the server browser, and calls
// window.BlockBlitzGame.start(code, name) once a lobby has actually been chosen; only then
// does the map/scene/HUD get built and the game WebSocket open. Leaving a lobby is a full
// page reload, which naturally returns to that same untouched (black) pre-game state.

function startGame(code, name) {
  // ---- Constants (defaults; overwritten by the server's welcome message) ----

  let EYE_HEIGHT = 1.6;     // camera height above the player's feet
  let PLAYER_HEIGHT = 1.6;  // third-person model / hitbox height

  // ---- Babylon setup --------------------------------------------------------

  const canvas = document.getElementById("renderCanvas");
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.05, 0.09, 1);

  // First-person camera. We drive position/rotation ourselves (server is authoritative for
  // position; look is local for instant feel), so we do NOT attach Babylon's built-in controls.
  const camera = new BABYLON.UniversalCamera("cam", new BABYLON.Vector3(0, EYE_HEIGHT, 0), scene);
  camera.minZ = 0.05;
  camera.fov = 1.15;
  scene.activeCamera = camera;

  const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.85;
  hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.15);
  const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, -0.4), scene);
  sun.intensity = 0.55;

  // ---- Ground + corner pillars (sized to the map's arenaHalf once known) ----

  let groundMesh = null;
  function buildGround(half) {
    if (groundMesh) groundMesh.dispose();
    const size = half * 2;
    groundMesh = BABYLON.MeshBuilder.CreateGround("ground", { width: size, height: size }, scene);
    const grid = new BABYLON.GridMaterial("grid", scene);
    grid.majorUnitFrequency = 5;
    grid.minorUnitVisibility = 0.35;
    grid.gridRatio = 1;
    grid.mainColor = new BABYLON.Color3(0.09, 0.11, 0.18);
    grid.lineColor = new BABYLON.Color3(0.25, 0.45, 0.7);
    grid.opacity = 0.99;
    groundMesh.material = grid;
  }

  const pillarMeshes = [];
  function buildPillars(half) {
    for (const p of pillarMeshes) p.dispose();
    pillarMeshes.length = 0;
    const inset = half - 1;
    const pillarColors = [[0.9, 0.3, 0.3], [0.3, 0.9, 0.4], [0.3, 0.5, 0.95], [0.95, 0.85, 0.3]];
    [[-inset, -inset], [inset, -inset], [-inset, inset], [inset, inset]].forEach((c, i) => {
      const p = BABYLON.MeshBuilder.CreateBox("pillar" + i, { width: 1.5, depth: 1.5, height: 6 }, scene);
      p.position.set(c[0], 3, c[1]);
      const m = new BABYLON.StandardMaterial("pm" + i, scene);
      m.diffuseColor = new BABYLON.Color3(...pillarColors[i]);
      m.emissiveColor = new BABYLON.Color3(pillarColors[i][0] * 0.25, pillarColors[i][1] * 0.25, pillarColors[i][2] * 0.25);
      p.material = m;
      pillarMeshes.push(p);
    });
  }

  // ---- Weapon models ----------------------------------------------------------
  //
  // Every weapon is a handful of Babylon primitives (boxes + a cylinder barrel) — same
  // low-poly aesthetic as the arena cover and player boxes, no external model files. One
  // builder function is shared by the first-person viewmodel (parented to the camera) and
  // the guns other players are shown holding (parented to their player mesh), so a weapon
  // only needs to be described once.

  const WEAPON_KINDS = ["knife", "pistol", "smg", "rifle", "shotgun"];

  const gunMat = new BABYLON.StandardMaterial("gunMat", scene);
  gunMat.diffuseColor = new BABYLON.Color3(0.12, 0.13, 0.16);
  gunMat.emissiveColor = new BABYLON.Color3(0.04, 0.04, 0.05);

  const stockMat = new BABYLON.StandardMaterial("stockMat", scene);
  stockMat.diffuseColor = new BABYLON.Color3(0.32, 0.2, 0.11);
  stockMat.emissiveColor = new BABYLON.Color3(0.08, 0.05, 0.03);

  const bladeMat = new BABYLON.StandardMaterial("bladeMat", scene);
  bladeMat.diffuseColor = new BABYLON.Color3(0.75, 0.78, 0.82);
  bladeMat.emissiveColor = new BABYLON.Color3(0.15, 0.16, 0.18);

  // A small accent color per weapon (on the mag/tip) so opponents' loadouts read at a glance.
  const WEAPON_ACCENTS = [
    new BABYLON.Color3(0.85, 0.85, 0.9), // knife - steel
    new BABYLON.Color3(0.4, 0.9, 1.0),   // pistol - cyan
    new BABYLON.Color3(1.0, 0.85, 0.3),  // smg - yellow
    new BABYLON.Color3(1.0, 0.55, 0.2),  // rifle - orange
    new BABYLON.Color3(1.0, 0.3, 0.3),   // shotgun - red
  ];
  const accentMats = WEAPON_ACCENTS.map((c, i) => {
    const m = new BABYLON.StandardMaterial("accent" + i, scene);
    m.diffuseColor = c.scale(0.6);
    m.emissiveColor = c.scale(0.5);
    return m;
  });

  function wbox(root, name, w, h, d, x, y, z, mat) {
    const b = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    b.parent = root;
    b.position.set(x, y, z);
    b.material = mat;
    b.isPickable = false;
    return b;
  }
  function wcyl(root, name, radius, len, x, y, z, mat) {
    const c = BABYLON.MeshBuilder.CreateCylinder(name, { diameter: radius * 2, height: len, tessellation: 8 }, scene);
    c.parent = root;
    c.position.set(x, y, z);
    c.rotation.x = Math.PI / 2; // barrel points along local +Z (forward)
    c.material = mat;
    c.isPickable = false;
    return c;
  }

  /** Builds one weapon's geometry as children of `root`. Local +Z = forward, grip ~at origin. */
  function buildWeaponMesh(root, kind, weaponIdx) {
    const accent = accentMats[weaponIdx] || accentMats[0];
    switch (kind) {
      case "knife":
        wbox(root, "blade", 0.025, 0.03, 0.22, 0, 0.03, 0.15, bladeMat);
        wbox(root, "guard", 0.07, 0.02, 0.03, 0, 0.03, 0.03, gunMat);
        wbox(root, "handle", 0.03, 0.05, 0.12, 0, -0.01, -0.05, stockMat);
        break;
      case "pistol":
        wbox(root, "body", 0.09, 0.11, 0.24, 0, 0, 0.1, gunMat);
        wbox(root, "grip", 0.08, 0.16, 0.08, 0, -0.13, -0.02, gunMat);
        wbox(root, "tip", 0.09, 0.03, 0.03, 0, 0.045, 0.24, accent);
        break;
      case "smg":
        wbox(root, "body", 0.09, 0.12, 0.32, 0, 0, 0.05, gunMat);
        wcyl(root, "barrel", 0.018, 0.16, 0, 0.01, 0.28, gunMat);
        wbox(root, "mag", 0.05, 0.18, 0.06, 0, -0.14, 0.08, accent);
        wbox(root, "stock", 0.06, 0.08, 0.12, 0, 0, -0.18, gunMat);
        break;
      case "rifle":
        wbox(root, "body", 0.1, 0.12, 0.42, 0, 0, 0.08, gunMat);
        wcyl(root, "barrel", 0.022, 0.26, 0, 0.01, 0.36, gunMat);
        wbox(root, "mag", 0.06, 0.22, 0.07, 0, -0.16, 0.1, accent);
        wbox(root, "stock", 0.07, 0.1, 0.18, 0, 0, -0.24, gunMat);
        break;
      case "shotgun":
        wbox(root, "body", 0.11, 0.13, 0.3, 0, 0, 0.02, gunMat);
        wcyl(root, "barrel", 0.032, 0.32, 0, 0.02, 0.32, gunMat);
        wbox(root, "pump", 0.1, 0.09, 0.14, 0, -0.03, 0.22, accent);
        wbox(root, "stock", 0.09, 0.11, 0.24, 0, 0, -0.24, stockMat);
        break;
    }
  }

  // ---- First-person viewmodel: one root per weapon, swapped on switch -------

  const WEAPON_VIEW_BASE = [
    new BABYLON.Vector3(0.16, -0.16, 0.32), // knife - held close & central
    new BABYLON.Vector3(0.22, -0.18, 0.42), // pistol - compact, held close
    new BABYLON.Vector3(0.22, -0.2, 0.5),
    new BABYLON.Vector3(0.24, -0.2, 0.58),
    new BABYLON.Vector3(0.24, -0.22, 0.5),  // shotgun
  ];
  const WEAPON_RECOIL_SCALE = [0.5, 0.7, 0.9, 1.0, 1.6]; // shotgun kicks hardest, knife jabs lightly

  const gunRoots = WEAPON_KINDS.map((kind, i) => {
    const root = new BABYLON.TransformNode("gunRoot" + i, scene);
    root.parent = camera;
    root.position.copyFrom(WEAPON_VIEW_BASE[i]);
    buildWeaponMesh(root, kind, i);
    for (const m of root.getChildMeshes()) m.renderingGroupId = 1; // draw over the world, never clips into cover
    root.setEnabled(i === 0);
    return root;
  });
  let recoil = 0; // 0..1, decays each frame

  // ---- Arena cover (sent by the server) -------------------------------------

  const obstacleMeshes = [];
  function buildObstacles(list) {
    for (const m of obstacleMeshes) m.dispose();
    obstacleMeshes.length = 0;
    const mat = new BABYLON.StandardMaterial("coverMat", scene);
    mat.diffuseColor = new BABYLON.Color3(0.22, 0.25, 0.32);
    mat.emissiveColor = new BABYLON.Color3(0.05, 0.06, 0.08);
    // Climbable obstacles (e.g. the house) get a warm tint — a visual cue that you can jump
    // up onto them, distinct from plain solid cover.
    const climbMat = new BABYLON.StandardMaterial("climbMat", scene);
    climbMat.diffuseColor = new BABYLON.Color3(0.55, 0.4, 0.22);
    climbMat.emissiveColor = new BABYLON.Color3(0.14, 0.1, 0.05);
    for (const o of list) {
      const box = BABYLON.MeshBuilder.CreateBox("cover", { width: o.hx * 2, depth: o.hz * 2, height: o.h }, scene);
      box.position.set(o.x, o.h / 2, o.z);
      box.material = o.climbable ? climbMat : mat;
      box.isPickable = false;
      obstacleMeshes.push(box);
    }
  }

  // ---- Weapon pickups (sent by the server) -----------------------------------
  //
  // Each pad is a small glowing disc on the ground plus a slowly-spinning copy of the
  // weapon it grants (reusing buildWeaponMesh — the pad literally shows what you'll get).
  // Availability (shown/hidden) is driven by the server's `pickups` array each state tick.

  /** @type {{disc: BABYLON.Mesh, icon: BABYLON.TransformNode}[]} */
  let pickupVisuals = [];

  function buildPickups(list) {
    for (const pv of pickupVisuals) { pv.disc.dispose(); pv.icon.dispose(); }
    pickupVisuals = list.map((pu, i) => {
      const accent = WEAPON_ACCENTS[pu.weapon] || WEAPON_ACCENTS[0];
      const disc = BABYLON.MeshBuilder.CreateCylinder("pad" + i, { diameter: 1.3, height: 0.04, tessellation: 24 }, scene);
      disc.position.set(pu.x, 0.03, pu.z);
      const discMat = new BABYLON.StandardMaterial("padmat" + i, scene);
      discMat.diffuseColor = accent.scale(0.5);
      discMat.emissiveColor = accent.scale(0.6);
      discMat.alpha = 0.85;
      disc.material = discMat;
      disc.isPickable = false;

      const icon = new BABYLON.TransformNode("padicon" + i, scene);
      icon.position.set(pu.x, 0.55, pu.z);
      buildWeaponMesh(icon, WEAPON_KINDS[pu.weapon], pu.weapon);
      for (const m of icon.getChildMeshes()) m.isPickable = false;

      return { disc, icon };
    });
  }

  // ---- Player meshes --------------------------------------------------------

  /** @type {Map<string, BABYLON.TransformNode>} id -> root node for other players */
  const others = new Map();
  /** @type {Map<string, HTMLElement>} id -> floating name tag */
  const tags = new Map();
  /** @type {Map<string, object>} id -> last-known full player record, merged from the binary
   * delta stream (see decodeStateBinary) so the rest of the client still works with a
   * complete per-tick roster, same as before delta compression. */
  const playerStates = new Map();
  /** @type {Map<string, string>} id -> name, from the low-frequency "roster" message. */
  const rosterNames = new Map();

  // Simple humanoid silhouette (torso + head + arms), proportioned from PLAYER_HEIGHT so it
  // stays exactly as tall as the server's hitbox (and — per design — the eye/viewmodel
  // height), with the root at the player's feet (matches the server's Y convention).
  function makePlayerBox(id) {
    const root = new BABYLON.TransformNode("p_" + id, scene);

    // Deterministic-ish color from the id so each player looks distinct.
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
    const col = BABYLON.Color3.FromHSV((h % 360), 0.6, 0.95);
    const mat = new BABYLON.StandardMaterial("pmat_" + id, scene);
    mat.diffuseColor = col;
    mat.emissiveColor = col.scale(0.35);
    const faceMat = new BABYLON.StandardMaterial("pface_" + id, scene);
    faceMat.diffuseColor = BABYLON.Color3.White();
    faceMat.emissiveColor = col.scale(0.7);

    const headH = PLAYER_HEIGHT * 0.22;
    const torsoH = PLAYER_HEIGHT - headH;
    const torsoY = torsoH / 2;
    const headY = torsoH + headH / 2;

    wbox(root, "torso_" + id, 0.6, torsoH, 0.5, 0, torsoY, 0, mat);
    wbox(root, "head_" + id, 0.4, headH, 0.4, 0, headY, 0, mat);
    // Bright marker on the front of the head so facing direction reads at a glance.
    wbox(root, "visor_" + id, 0.24, headH * 0.35, 0.04, 0, headY, 0.21, faceMat);
    wbox(root, "armL_" + id, 0.15, torsoH * 0.8, 0.18, -0.38, torsoY, 0, mat);
    wbox(root, "armR_" + id, 0.15, torsoH * 0.8, 0.18, 0.38, torsoY, 0, mat);

    // Held weapon: rebuilt in applyState() whenever this player's reported weapon changes.
    const heldGunRoot = new BABYLON.TransformNode("held_" + id, scene);
    heldGunRoot.parent = root;
    heldGunRoot.position.set(0.32, torsoH * 0.65, 0.32);
    root.heldWeapon = -1;
    root.heldGunRoot = heldGunRoot;

    return root;
  }

  // ---- Input & look ---------------------------------------------------------

  let yaw = 0;    // radians, around Y
  let pitch = 0;  // radians, around X
  const LOOK_SENS = 0.0022;
  const keys = Object.create(null);

  window.addEventListener("keydown", (e) => { keys[e.code] = true; });
  window.addEventListener("keyup", (e) => { keys[e.code] = false; });

  const overlay = document.getElementById("overlay");
  const overlayLobbyInfo = document.getElementById("overlayLobbyInfo");
  const leaveLobbyLink = document.getElementById("leaveLobbyLink");
  const lobbyBadge = document.getElementById("lobbyBadge");
  const crosshair = document.getElementById("crosshair");
  const hitmarker = document.getElementById("hitmarker");
  const healthEl = document.getElementById("health");
  const hpSpan = healthEl.querySelector(".hp");
  const damageEl = document.getElementById("damage");
  const deathEl = document.getElementById("death");
  const ammoEl = document.getElementById("ammo");
  const ammoCur = ammoEl.querySelector(".cur");
  const ammoMag = ammoEl.querySelector(".mag");
  const weaponNameEl = document.getElementById("weaponName");
  const scoreboard = document.getElementById("scoreboard");
  const scoreboardBody = scoreboard.querySelector("tbody");
  const connIcon = document.getElementById("connIcon");
  const disconnectScreen = document.getElementById("disconnectScreen");
  const disconnectLobbyBtn = document.getElementById("disconnectLobbyBtn");
  const disconnectHint = document.getElementById("disconnectHint");

  let pointerLocked = false;
  let firing = false;      // left mouse held
  let prevFiring = false;  // firing state as of the last input tick (for semi-auto edge detection)
  let myHp = 100;
  let myAlive = true;
  let myReloading = false;
  let myAmmo = 30;
  let myWeapon = 0;        // selected weapon slot, 0-4 (0 = knife, always owned)
  let myOwned = [true, false, false, false, false]; // which weapon slots we've picked up
  let weaponDefs = [];     // [{name, mag, fireMs, reloadMs, semiAuto, infiniteAmmo}] from welcome
  let latestPlayers = [];  // last state snapshot, for the scoreboard
  let lastShotAt = 0;      // cosmetic tracer cadence (ms)
  const FIRE_MS = 120;     // fallback cadence before weaponDefs arrives

  // ---- Prediction / interpolation state -------------------------------------

  const DT = 1 / 60;             // must match the server tick step
  let MOVE_SPEED = 6;            // from welcome (server authority)
  let SPRINT_MULT = 1.6;         // from welcome
  let GRAVITY = 24;              // from welcome
  let JUMP_SPEED = 10;           // from welcome
  let PLAYER_RADIUS = 0.4;       // from welcome
  let ARENA_HALF = 19;           // from welcome
  let clientObstacles = [];      // [{x, z, hx, hz, h, climbable}] for local collision (mirrors the server)

  const ROOF_EPSILON = 0.05;     // must match the server's Lobby.RoofEpsilon
  const LANDING_MARGIN = 0.6;    // must match the server's Lobby.LandingMargin

  let predX = 0, predZ = 0, predY = 0, predVelY = 0; // our locally-predicted position
  let predInit = false;
  let inputSeq = 0;
  const pendingInputs = [];      // {seq, input} not yet acknowledged by the server

  const INTERP_DELAY = 100;      // ms: render other players this far in the past
  const snapshots = [];          // {t, tick, players} buffer for interpolation
  let currentRenderTick = 0;     // fractional server tick we're showing others at (for lag comp)

  function startPlaying() {
    SFX.unlock(); // must run from this user-gesture handler or the browser blocks audio
    canvas.requestPointerLock();
  }

  // Clicking the overlay anywhere except "Leave lobby" starts/resumes play.
  overlay.addEventListener("click", (e) => {
    if (e.target === leaveLobbyLink) return;
    startPlaying();
  });

  document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === canvas;
    overlay.classList.toggle("hidden", pointerLocked);
    crosshair.classList.toggle("hidden", !pointerLocked);
    healthEl.classList.toggle("hidden", !pointerLocked);
    ammoEl.classList.toggle("hidden", !pointerLocked);
    weaponNameEl.classList.toggle("hidden", !pointerLocked);
    if (!pointerLocked) firing = false;
  });

  // ---- Scoreboard (hold Tab) ------------------------------------------------

  let scoreboardVisible = false;
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Tab") return;
    e.preventDefault();
    if (!scoreboardVisible) { scoreboardVisible = true; scoreboard.classList.remove("hidden"); renderScoreboard(); }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Tab") return;
    e.preventDefault();
    scoreboardVisible = false;
    scoreboard.classList.add("hidden");
  });

  function renderScoreboard() {
    const rows = [...latestPlayers].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    scoreboardBody.innerHTML = "";
    for (const p of rows) {
      const tr = document.createElement("tr");
      if (p.id === myId) tr.className = "me";
      const name = document.createElement("td"); name.textContent = p.name || p.id;
      const k = document.createElement("td"); k.className = "c k"; k.textContent = p.kills;
      const d = document.createElement("td"); d.className = "c d"; d.textContent = p.deaths;
      tr.append(name, k, d);
      scoreboardBody.appendChild(tr);
    }
  }

  // Fire while the left button is held (only when locked & alive).
  document.addEventListener("mousedown", (e) => { if (e.button === 0 && pointerLocked) firing = true; });
  document.addEventListener("mouseup",   (e) => { if (e.button === 0) firing = false; });
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    yaw += e.movementX * LOOK_SENS;
    pitch += e.movementY * LOOK_SENS;
    const limit = Math.PI / 2 - 0.05;
    pitch = Math.max(-limit, Math.min(limit, pitch));
  });

  // ---- Weapon switching (1-5) ------------------------------------------------

  const WEAPON_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 };
  window.addEventListener("keydown", (e) => {
    if (!pointerLocked || !myAlive) return;
    const idx = WEAPON_KEYS[e.code];
    if (idx === undefined || idx === myWeapon || !weaponDefs[idx] || !myOwned[idx]) return;
    myWeapon = idx;
    for (let i = 0; i < gunRoots.length; i++) gunRoots[i].setEnabled(i === idx);
    SFX.switchWeapon();
  });

  // ---- Shared movement simulation (must match the server exactly) -----------
  //
  // Mirrors Lobby.cs's UpdateVertical + MovePlayer + BlockedAt + SurfaceHeightAt: gravity and
  // jump first (using this tick's surface height), then horizontal movement using the
  // freshly-updated Y so climbable obstacles (the house) block like a wall below their roof
  // and are open above it.

  function blockedAt(x, z, y) {
    for (const o of clientObstacles) {
      if (Math.abs(x - o.x) < o.hx + PLAYER_RADIUS && Math.abs(z - o.z) < o.hz + PLAYER_RADIUS) {
        if (o.climbable && y >= o.h - ROOF_EPSILON) continue;
        return true;
      }
    }
    return false;
  }

  function surfaceHeightAt(x, z) {
    let surface = 0;
    const pad = PLAYER_RADIUS + LANDING_MARGIN;
    for (const o of clientObstacles) {
      if (!o.climbable) continue;
      if (Math.abs(x - o.x) < o.hx + pad && Math.abs(z - o.z) < o.hz + pad) surface = Math.max(surface, o.h);
    }
    return surface;
  }

  /** state: {x, z, y, velY}. Returns the next state after one input tick. */
  function simulateMovement(state, inp) {
    let { x, z, y, velY } = state;

    const surface = surfaceHeightAt(x, z);
    velY -= GRAVITY * DT;
    y += velY * DT;
    let grounded;
    if (y <= surface) { y = surface; velY = 0; grounded = true; }
    else grounded = false;
    if (inp.jump && grounded) { velY = JUMP_SPEED; grounded = false; }

    const mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const mz = (inp.fwd ? 1 : 0) - (inp.back ? 1 : 0);
    if (mx !== 0 || mz !== 0) {
      const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
      let dx = sin * mz + cos * mx;
      let dz = cos * mz - sin * mx;
      const len = Math.hypot(dx, dz);
      dx /= len; dz /= len;

      const speed = inp.sprint ? MOVE_SPEED * SPRINT_MULT : MOVE_SPEED;
      const clamp = (v) => Math.max(-ARENA_HALF, Math.min(ARENA_HALF, v));
      const nx = clamp(x + dx * speed * DT);
      if (!blockedAt(nx, z, y)) x = nx;
      const nz = clamp(z + dz * speed * DT);
      if (!blockedAt(x, nz, y)) z = nz;
    }

    return { x, z, y, velY };
  }

  // ---- Line-of-sight (for name tags — don't show through walls) -------------

  function segmentHitsBox2D(x0, z0, x1, z1, o) {
    const dx = x1 - x0, dz = z1 - z0;
    let tmin = 0, tmax = 1;
    if (Math.abs(dx) < 1e-8) {
      if (x0 < o.x - o.hx || x0 > o.x + o.hx) return false;
    } else {
      let t1 = (o.x - o.hx - x0) / dx, t2 = (o.x + o.hx - x0) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    if (Math.abs(dz) < 1e-8) {
      if (z0 < o.z - o.hz || z0 > o.z + o.hz) return false;
    } else {
      let t1 = (o.z - o.hz - z0) / dz, t2 = (o.z + o.hz - z0) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    return true;
  }

  /** 2D (XZ) check — good enough approximation of "is there a wall between these two points". */
  function lineOfSightBlocked(x0, z0, x1, z1) {
    for (const o of clientObstacles) if (segmentHitsBox2D(x0, z0, x1, z1, o)) return true;
    return false;
  }

  // ---- Networking -------------------------------------------------------------

  let myId = null;
  let tickRate = 60, sendRate = 30;
  let connected = false;
  let joined = false;          // true once we've actually entered the match (past "welcome")
  let intentionalClose = false; // set before we close the socket ourselves (Leave lobby)
  let disconnectedUnexpectedly = false;
  let lastPongAt = 0; // set once joined, so the staleness clock starts from actual join time
  let lastRtt = 0;

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${wsProto}://${location.host}/ws?code=${encodeURIComponent(code)}`);
  ws.binaryType = "arraybuffer"; // state messages arrive binary; everything else is JSON text

  ws.addEventListener("open", () => { connected = true; });
  ws.addEventListener("close", () => {
    connected = false;
    // A close after "error"/"full" (never actually joined) is lobby.js's problem, not ours —
    // only treat this as "kicked out mid-game" if we'd actually gotten in and didn't leave
    // on purpose.
    if (joined && !intentionalClose) handleUnexpectedDisconnect();
  });
  ws.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) { decodeStateBinary(ev.data); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "welcome") {
      myId = msg.id;
      tickRate = msg.tickRate;
      sendRate = msg.sendRate;
      weaponDefs = msg.weapons || [];
      if (weaponDefs[myWeapon]) {
        ammoMag.textContent = weaponDefs[myWeapon].mag;
        weaponNameEl.textContent = weaponDefs[myWeapon].name.toUpperCase();
      }
      if (msg.moveSpeed) MOVE_SPEED = msg.moveSpeed;
      if (msg.sprintMult) SPRINT_MULT = msg.sprintMult;
      if (msg.gravity) GRAVITY = msg.gravity;
      if (msg.jumpSpeed) JUMP_SPEED = msg.jumpSpeed;
      if (msg.playerRadius) PLAYER_RADIUS = msg.playerRadius;
      if (msg.eyeHeight) EYE_HEIGHT = msg.eyeHeight;
      if (msg.playerHeight) PLAYER_HEIGHT = msg.playerHeight;
      if (msg.arenaHalf) ARENA_HALF = msg.arenaHalf;

      buildGround(ARENA_HALF);
      buildPillars(ARENA_HALF);

      const obs = msg.obstacles || [];
      clientObstacles = obs.map((o) => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, h: o.h, climbable: !!o.climbable }));
      buildObstacles(obs);
      buildPickups(msg.weaponPickups || []);

      // Now that we're actually in a match, reveal the play prompt + shareable lobby badge.
      const lobbyLabel = `${msg.lobbyName || "Lobby"} · ${msg.lobbyCode || code}${msg.mapName ? " · " + msg.mapName : ""}`;
      overlayLobbyInfo.textContent = lobbyLabel;
      lobbyBadge.innerHTML = `${msg.lobbyName || "Lobby"} · <b>${msg.lobbyCode || code}</b>`;
      lobbyBadge.classList.remove("hidden");
      overlay.classList.remove("hidden");

      joined = true;
      lastPongAt = performance.now(); // staleness clock starts now, not from before we connected
      ws.send(JSON.stringify({ type: "join", name }));
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
      }, 1500);
    } else if (msg.type === "roster") {
      applyRoster(msg);
    } else if (msg.type === "hit") {
      showHitmarker();
    } else if (msg.type === "pong") {
      lastRtt = performance.now() - msg.t;
      lastPongAt = performance.now();
    } else if (msg.type === "error" || msg.type === "full") {
      window.BlockBlitzLobby?.onJoinError(msg.type === "full" ? "full" : (msg.reason || "error"));
    }
  });

  /** Disconnects and goes back to the server browser. A full reload is the simplest way to
   * reset every piece of match state (scene, meshes, prediction, HUD) cleanly. */
  function leaveLobby() {
    intentionalClose = true;
    try { ws.close(); } catch { /* already closing */ }
    location.reload();
  }

  leaveLobbyLink.addEventListener("click", (e) => {
    e.stopPropagation();
    leaveLobby();
  });

  // ---- Connection health: status icon + unexpected-disconnect takeover ------

  const RTT_LAG_MS = 200;      // server-side lag: ping this high or worse
  const PONG_STALE_MS = 4000;  // server-side lag: no pong at all in this long
  const FPS_LAG = 30;          // client-side lag: sustained render fps below this
  let fpsLagging = false;
  let fpsCheckAt = 0;
  let lowFpsStreak = 0;

  /** Called every frame from the render loop — cheap, just a threshold check + occasional
   * sampling, no allocation. */
  function updateConnStatus() {
    const now = performance.now();
    if (now - fpsCheckAt > 500) {
      fpsCheckAt = now;
      const fps = engine.getFps();
      if (fps < FPS_LAG) lowFpsStreak++; else lowFpsStreak = 0;
      fpsLagging = lowFpsStreak >= 2; // ~1s sustained, so a single frame hitch doesn't flicker it
    }

    let state = null;
    if (disconnectedUnexpectedly) {
      state = "red";
    } else if (joined && connected) {
      if (now - lastPongAt > PONG_STALE_MS || lastRtt > RTT_LAG_MS) state = "orange";
      else if (fpsLagging) state = "yellow";
    }

    connIcon.classList.toggle("hidden", !state);
    connIcon.classList.remove("yellow", "orange", "red");
    if (state) connIcon.classList.add(state);
  }

  /** The server dropped us mid-game (not from clicking "Leave lobby") — e.g. the host
   * stopped it. Freeze the game behind a takeover screen instead of leaving a dead, silently
   * unresponsive view. */
  function handleUnexpectedDisconnect() {
    disconnectedUnexpectedly = true;
    clearInterval(inputLoopHandle);
    firing = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    overlay.classList.add("hidden");
    disconnectScreen.classList.remove("hidden");
    pollServerHealth();
  }

  let healthPollTimer = 0;
  async function checkServerHealth() {
    try {
      const res = await fetch("/health", { cache: "no-store", signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        disconnectLobbyBtn.disabled = false;
        disconnectHint.classList.add("hidden");
        return;
      }
    } catch { /* treated as down below */ }
    disconnectLobbyBtn.disabled = true;
    disconnectHint.classList.remove("hidden");
  }

  /** Keeps checking while the takeover screen is up, so the button recovers on its own if
   * the host brings the server back. */
  function pollServerHealth() {
    checkServerHealth();
    clearInterval(healthPollTimer);
    healthPollTimer = setInterval(checkServerHealth, 3000);
  }

  disconnectLobbyBtn.addEventListener("click", () => {
    if (disconnectLobbyBtn.disabled) return;
    leaveLobby();
  });

  // ---- Binary state decoding --------------------------------------------------
  //
  // Mirrors Lobby.cs's BuildStateBinary/WritePlayerRecord exactly: a 7-byte header (tick,
  // pickup bitmask, player count) followed by one 49-byte fixed record per player who
  // changed since the server's last broadcast. Only-the-changed-players is why this can't be
  // treated as "the current roster" directly — playerStates accumulates each decoded record
  // so the rest of the client (applyState/interpolation) still sees a complete picture, same
  // as when the server sent full JSON snapshots.
  const textDecoder = new TextDecoder();

  function decodeStateBinary(buf) {
    const dv = new DataView(buf);
    let off = 0;
    const tick = dv.getUint32(off, true); off += 4;
    const pickupByte = dv.getUint8(off); off += 1;
    const count = dv.getUint16(off, true); off += 2;

    for (let i = 0; i < count; i++) {
      const id = textDecoder.decode(new Uint8Array(buf, off, 8)); off += 8;
      const flags = dv.getUint8(off); off += 1;
      const x = dv.getFloat32(off, true); off += 4;
      const y = dv.getFloat32(off, true); off += 4;
      const z = dv.getFloat32(off, true); off += 4;
      const vy = dv.getFloat32(off, true); off += 4;
      const yaw = dv.getFloat32(off, true); off += 4;
      const pitch = dv.getFloat32(off, true); off += 4;
      const hp = dv.getFloat32(off, true); off += 4;
      const ammo = dv.getUint16(off, true); off += 2;
      const weapon = dv.getUint8(off); off += 1;
      const ownedBits = dv.getUint8(off); off += 1;
      const kills = dv.getUint16(off, true); off += 2;
      const deaths = dv.getUint16(off, true); off += 2;
      const seq = dv.getUint32(off, true); off += 4;

      const owned = [];
      for (let b = 0; b < 5; b++) owned.push(!!(ownedBits & (1 << b)));

      // A fresh object each time (never mutate an existing one) so older interpolation
      // snapshots that still reference a previous record stay frozen/correct.
      playerStates.set(id, {
        id, x, y, z, vy, yaw, pitch, hp,
        alive: !!(flags & 1), reloading: !!(flags & 2),
        ammo, weapon, owned, kills, deaths, seq,
        name: rosterNames.get(id) || "",
      });
    }

    const pickups = [];
    for (let i = 0; i < pickupVisuals.length; i++) pickups.push(!!(pickupByte & (1 << i)));

    applyState({ tick, pickups, players: [...playerStates.values()] });
  }

  /// Low-frequency id->name (+ membership) companion to the binary state stream. Since state
  /// only ever carries deltas, this is also the sole signal for "who's still here" — a
  /// departed id is dropped from playerStates/meshes/tags here, not inferred from absence in
  /// a state message (their absence there just means they haven't changed, not that they left).
  function applyRoster(msg) {
    const entries = Object.entries(msg.players || {});
    const newIds = new Set(entries.map(([id]) => id));
    const oldIds = new Set(rosterNames.keys());
    for (const [id, nm] of entries) rosterNames.set(id, nm);

    for (const id of oldIds) {
      if (newIds.has(id)) continue;
      rosterNames.delete(id);
      playerStates.delete(id);
      if (id === myId) continue;
      others.get(id)?.dispose();
      others.delete(id);
      tags.get(id)?.remove();
      tags.delete(id);
    }
  }

  let hitmarkerTimer = 0;
  function showHitmarker() {
    hitmarker.classList.add("show");
    clearTimeout(hitmarkerTimer);
    hitmarkerTimer = setTimeout(() => hitmarker.classList.remove("show"), 90);
    SFX.hitmarker();
  }

  function applyState(msg) {
    latestPlayers = msg.players;

    // Buffer this snapshot for entity interpolation (positions are applied in the render loop).
    snapshots.push({ t: performance.now(), tick: msg.tick, players: msg.players });
    while (snapshots.length > 2 && snapshots[0].t < performance.now() - 1000) snapshots.shift();

    if (msg.pickups) {
      for (let i = 0; i < pickupVisuals.length; i++) {
        const available = !!msg.pickups[i];
        pickupVisuals[i].disc.setEnabled(available);
        pickupVisuals[i].icon.setEnabled(available);
      }
    }

    const seen = new Set();
    for (const p of msg.players) {
      seen.add(p.id);
      if (p.id === myId) {
        reconcile(p);   // prediction correction (camera position set from predX/predZ each frame)
        updateSelf(p);
        continue;
      }
      // Ensure a mesh + name tag exist; positioning happens during interpolation.
      if (!others.has(p.id)) others.set(p.id, makePlayerBox(p.id));
      const mesh = others.get(p.id);
      if (mesh.heldWeapon !== p.weapon && WEAPON_KINDS[p.weapon]) {
        mesh.heldWeapon = p.weapon;
        for (const c of mesh.heldGunRoot.getChildMeshes()) c.dispose();
        buildWeaponMesh(mesh.heldGunRoot, WEAPON_KINDS[p.weapon], p.weapon);
      }
      let tag = tags.get(p.id);
      if (!tag) {
        tag = document.createElement("div");
        tag.className = "nametag";
        document.body.appendChild(tag);
        tags.set(p.id, tag);
      }
      tag.textContent = p.name || "";
      tag.style.display = p.alive ? "block" : "none";
    }
    // Remove players that left.
    for (const [id, mesh] of others) {
      if (!seen.has(id)) {
        mesh.dispose();
        others.delete(id);
        tags.get(id)?.remove();
        tags.delete(id);
      }
    }

    if (scoreboardVisible) renderScoreboard();
  }

  // Reconciliation: snap to the authoritative position, then re-apply inputs the server hasn't
  // acknowledged yet. On LAN the correction is ~0, so this is invisible; over WAN it self-corrects.
  function reconcile(me) {
    if (!predInit) { predX = me.x; predZ = me.z; predY = me.y; predVelY = me.vy || 0; predInit = true; }
    while (pendingInputs.length && pendingInputs[0].seq <= me.seq) pendingInputs.shift();
    let state = { x: me.x, z: me.z, y: me.y, velY: me.vy || 0 };
    for (const pi of pendingInputs) state = simulateMovement(state, pi.input);
    predX = state.x; predZ = state.z; predY = state.y; predVelY = state.velY;
  }

  function updateSelf(p) {
    // Damage flash + thud when our health drops.
    if (p.hp < myHp - 0.01) {
      damageEl.classList.add("flash");
      requestAnimationFrame(() => damageEl.classList.remove("flash"));
      SFX.damage();
    }
    // Edge-detect death and reload start/end for one-shot sounds.
    if (myAlive && !p.alive) SFX.death();
    if (!myReloading && p.reloading) SFX.reloadStart();
    if (myReloading && !p.reloading) SFX.reloadEnd();
    // Newly-picked-up weapon(s): p.owned only ever gains entries, never loses them.
    if (p.owned) {
      for (let i = 0; i < p.owned.length; i++) {
        if (p.owned[i] && !myOwned[i]) SFX.pickup();
      }
      myOwned = p.owned;
    }

    myHp = p.hp;
    myAlive = p.alive;
    myReloading = p.reloading;
    myAmmo = p.ammo;

    hpSpan.textContent = Math.max(0, Math.round(p.hp));
    healthEl.classList.toggle("low", p.hp <= 30);

    // Weapon HUD reflects the server's authoritative slot (it applies switches immediately,
    // so this only lags our own keypress by one round trip). Infinite-ammo weapons (knife)
    // show an infinity symbol instead of a mag count.
    const wDef = weaponDefs[p.weapon];
    if (wDef && wDef.infiniteAmmo) {
      ammoCur.textContent = "∞";
      ammoMag.textContent = "∞";
      ammoEl.classList.remove("empty", "reloading");
    } else {
      ammoCur.textContent = p.ammo;
      ammoEl.classList.toggle("empty", p.ammo === 0);
      ammoEl.classList.toggle("reloading", p.reloading);
    }
    if (wDef) {
      if (!wDef.infiniteAmmo) ammoMag.textContent = wDef.mag;
      weaponNameEl.textContent = wDef.name.toUpperCase();
    }

    deathEl.classList.toggle("hidden", p.alive);
    crosshair.classList.toggle("hidden", !p.alive || !pointerLocked);
  }

  // One input tick: build the input, predict our own movement locally, buffer it for
  // reconciliation, and send it. Runs at the server tick rate so prediction stays in step.
  // Handle kept so an unexpected disconnect can stop the game from doing anything further.
  const inputLoopHandle = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const active = pointerLocked && myAlive;             // only move while locked & alive
    const shooting = firing && pointerLocked && myAlive;

    const input = {
      fwd: active && !!keys["KeyW"],
      back: active && !!keys["KeyS"],
      left: active && !!keys["KeyA"],
      right: active && !!keys["KeyD"],
      fire: shooting,
      reload: active && !!keys["KeyR"],
      sprint: active && (!!keys["ShiftLeft"] || !!keys["ShiftRight"]),
      jump: active && !!keys["Space"],
      yaw,
      pitch,
      seq: ++inputSeq,
      renderTick: currentRenderTick,
      weapon: myWeapon,
    };

    // Predict immediately for instant, smooth local movement.
    if (predInit) ({ x: predX, z: predZ, y: predY, velY: predVelY } = simulateMovement({ x: predX, z: predZ, y: predY, velY: predVelY }, input));
    pendingInputs.push({ seq: input.seq, input });
    // Now that idle players stop getting fresh acks (delta compression skips unchanged
    // state), pendingInputs would otherwise grow unbounded while genuinely idle — cap it,
    // same "bound a flood" spirit as the server's own input queue cap.
    if (pendingInputs.length > 600) pendingInputs.shift();

    ws.send(JSON.stringify({ type: "input", ...input }));

    // Cosmetic only: spawn a tracer + recoil at roughly the server fire rate (the server is
    // authoritative for actual hits/ammo). Predicting the cadence locally keeps the feedback
    // instant. Semi-auto weapons only "fire" on the rising edge of the mouse button, matching
    // the server's one-shot-per-click behavior instead of a hold-to-spam timer.
    const wDef = weaponDefs[myWeapon];
    const fireMs = (wDef && wDef.fireMs) || FIRE_MS;
    const canShoot = shooting && (!wDef || !wDef.semiAuto || !prevFiring);
    if (canShoot && !myReloading && performance.now() - lastShotAt >= fireMs) {
      lastShotAt = performance.now();
      const isKnife = !!(wDef && wDef.infiniteAmmo);
      if (isKnife) {
        recoil = 1;
        SFX.swing();
      } else if (myAmmo > 0) {
        spawnTracer();
        recoil = 1;
        SFX.shoot(((wDef && wDef.name) || "rifle").toLowerCase());
      } else {
        SFX.dryFire();
      }
    }
    prevFiring = shooting;

    // Footsteps while actually moving, locked in, and alive.
    if (active && (input.fwd || input.back || input.left || input.right)) {
      SFX.footstepThrottled(320);
    }
  }, 1000 / 60);

  // ---- Tracer effect --------------------------------------------------------

  function spawnTracer() {
    const dir = camera.getDirection(BABYLON.Axis.Z);
    // Start slightly below/right of the eye so it reads like a barrel, not a laser from your nose.
    const start = camera.position
      .add(dir.scale(0.6))
      .add(camera.getDirection(BABYLON.Axis.X).scale(0.18))
      .add(new BABYLON.Vector3(0, -0.12, 0));
    const end = camera.position.add(dir.scale(60));

    const line = BABYLON.MeshBuilder.CreateLines("tracer", { points: [start, end] }, scene);
    line.color = new BABYLON.Color3(1, 0.85, 0.4);
    line.isPickable = false;
    setTimeout(() => line.dispose(), 55);
  }

  // ---- Render loop ----------------------------------------------------------

  const hud = document.getElementById("hud");

  engine.runRenderLoop(() => {
    // Looking is local & instant. Babylon UniversalCamera uses Euler (pitch, yaw, roll).
    camera.rotation.set(pitch, yaw, 0);
    // Our own position comes from client-side prediction (smooth at full framerate).
    if (predInit) camera.position.set(predX, predY + EYE_HEIGHT, predZ);

    interpolateOthers();

    // Weapon viewmodel: recoil kick decays back to rest; dip while reloading.
    recoil += (0 - recoil) * 0.25;
    const dip = myReloading ? 0.18 : 0;
    const base = WEAPON_VIEW_BASE[myWeapon];
    const kick = WEAPON_RECOIL_SCALE[myWeapon];
    const activeGun = gunRoots[myWeapon];
    activeGun.position.set(base.x, base.y - dip, base.z - recoil * 0.12 * kick);
    activeGun.rotation.set(-recoil * 0.5 * kick + dip * 1.2, 0, 0);

    // Slowly spin each available pickup's floating weapon icon so it reads as "grab me".
    for (const pv of pickupVisuals) {
      if (pv.icon.isEnabled()) pv.icon.rotation.y += 0.02;
    }

    scene.render();
    updateNametags();
    updateConnStatus();

    hud.textContent =
      `${connected ? "online" : "offline"} · ${others.size + (myId ? 1 : 0)} players · ${engine.getFps().toFixed(0)} fps`;
  });

  // Render other players ~INTERP_DELAY in the past, sliding between the two snapshots that
  // straddle that moment. Also computes the render tick we send for lag compensation.
  function interpolateOthers() {
    if (snapshots.length === 0) return;
    const renderTime = performance.now() - INTERP_DELAY;

    let a = snapshots[0], b = snapshots[0];
    if (renderTime >= snapshots[snapshots.length - 1].t) {
      a = b = snapshots[snapshots.length - 1];
    } else {
      for (let i = 0; i < snapshots.length - 1; i++) {
        if (snapshots[i].t <= renderTime && renderTime <= snapshots[i + 1].t) { a = snapshots[i]; b = snapshots[i + 1]; break; }
      }
    }
    const span = b.t - a.t;
    const f = span > 0 ? (renderTime - a.t) / span : 0;
    currentRenderTick = a.tick + (b.tick - a.tick) * f;

    for (const [id, mesh] of others) {
      const pa = a.players.find((p) => p.id === id);
      const pb = b.players.find((p) => p.id === id);
      const st = pb || pa;
      if (!st) { mesh.setEnabled(false); continue; }
      mesh.setEnabled(st.alive);
      if (!st.alive) continue;
      if (pa && pb) {
        mesh.position.set(pa.x + (pb.x - pa.x) * f, pa.y + (pb.y - pa.y) * f, pa.z + (pb.z - pa.z) * f);
        mesh.rotation.y = lerpAngle(pa.yaw, pb.yaw, f);
      } else {
        mesh.position.set(st.x, st.y, st.z);
        mesh.rotation.y = st.yaw;
      }
    }
  }

  function lerpAngle(a, b, f) {
    let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * f;
  }

  // Project each visible, unobstructed player's head position to screen space and place its
  // name tag there.
  function updateNametags() {
    const rect = canvas.getBoundingClientRect();
    const viewport = new BABYLON.Viewport(0, 0, rect.width, rect.height);
    const transform = scene.getTransformMatrix();
    const forward = camera.getDirection(BABYLON.Axis.Z);
    for (const [id, mesh] of others) {
      const tag = tags.get(id);
      if (!tag || tag.style.display === "none") continue;

      if (lineOfSightBlocked(camera.position.x, camera.position.z, mesh.position.x, mesh.position.z)) {
        tag.style.visibility = "hidden";
        continue;
      }

      const head = new BABYLON.Vector3(mesh.position.x, mesh.position.y + PLAYER_HEIGHT + 0.15, mesh.position.z);
      // Hide when behind the camera.
      if (BABYLON.Vector3.Dot(head.subtract(camera.position), forward) <= 0) {
        tag.style.visibility = "hidden";
        continue;
      }
      const c = BABYLON.Vector3.Project(head, BABYLON.Matrix.Identity(), transform, viewport);
      tag.style.visibility = "visible";
      tag.style.left = (rect.left + c.x) + "px";
      tag.style.top = (rect.top + c.y) + "px";
    }
  }

  window.addEventListener("resize", () => engine.resize());
}

window.BlockBlitzGame = { start: startGame };
