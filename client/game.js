"use strict";

// ---- Constants ------------------------------------------------------------

const EYE_HEIGHT = 1.6; // camera height above the floor (units)

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

// Ground with a grid so movement is easy to read.
const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 40, height: 40 }, scene);
const grid = new BABYLON.GridMaterial("grid", scene);
grid.majorUnitFrequency = 5;
grid.minorUnitVisibility = 0.35;
grid.gridRatio = 1;
grid.mainColor = new BABYLON.Color3(0.09, 0.11, 0.18);
grid.lineColor = new BABYLON.Color3(0.25, 0.45, 0.7);
grid.opacity = 0.99;
ground.material = grid;

// Corner pillars for orientation.
const pillarColors = [
  [0.9, 0.3, 0.3], [0.3, 0.9, 0.4], [0.3, 0.5, 0.95], [0.95, 0.85, 0.3],
];
[[-18, -18], [18, -18], [-18, 18], [18, 18]].forEach((c, i) => {
  const p = BABYLON.MeshBuilder.CreateBox("pillar" + i, { width: 1.5, depth: 1.5, height: 6 }, scene);
  p.position.set(c[0], 3, c[1]);
  const m = new BABYLON.StandardMaterial("pm" + i, scene);
  m.diffuseColor = new BABYLON.Color3(...pillarColors[i]);
  m.emissiveColor = new BABYLON.Color3(pillarColors[i][0] * 0.25, pillarColors[i][1] * 0.25, pillarColors[i][2] * 0.25);
  p.material = m;
});

// ---- Weapon viewmodel -----------------------------------------------------

const gun = BABYLON.MeshBuilder.CreateBox("gun", { width: 0.12, height: 0.14, depth: 0.5 }, scene);
gun.parent = camera;
const GUN_BASE = new BABYLON.Vector3(0.22, -0.2, 0.6);
gun.position.copyFrom(GUN_BASE);
const gunMat = new BABYLON.StandardMaterial("gunMat", scene);
gunMat.diffuseColor = new BABYLON.Color3(0.12, 0.13, 0.16);
gunMat.emissiveColor = new BABYLON.Color3(0.04, 0.04, 0.05);
gun.material = gunMat;
gun.isPickable = false;
gun.renderingGroupId = 1; // draw over the world so it never clips into cover
let recoil = 0;           // 0..1, decays each frame

// ---- Arena cover (sent by the server) -------------------------------------

const obstacleMeshes = [];
function buildObstacles(list) {
  for (const m of obstacleMeshes) m.dispose();
  obstacleMeshes.length = 0;
  const mat = new BABYLON.StandardMaterial("coverMat", scene);
  mat.diffuseColor = new BABYLON.Color3(0.22, 0.25, 0.32);
  mat.emissiveColor = new BABYLON.Color3(0.05, 0.06, 0.08);
  for (const o of list) {
    const box = BABYLON.MeshBuilder.CreateBox("cover", { width: o.hx * 2, depth: o.hz * 2, height: o.h }, scene);
    box.position.set(o.x, o.h / 2, o.z);
    box.material = mat;
    box.isPickable = false;
    obstacleMeshes.push(box);
  }
}

// ---- Player meshes --------------------------------------------------------

/** @type {Map<string, BABYLON.Mesh>} id -> box mesh for other players */
const others = new Map();
/** @type {Map<string, HTMLElement>} id -> floating name tag */
const tags = new Map();

function makePlayerBox(id) {
  const box = BABYLON.MeshBuilder.CreateBox("p_" + id, { width: 0.8, depth: 0.8, height: 1.0 }, scene);
  const mat = new BABYLON.StandardMaterial("pmat_" + id, scene);
  // Deterministic-ish color from the id so each player looks distinct.
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  const col = BABYLON.Color3.FromHSV((h % 360), 0.6, 0.95);
  mat.diffuseColor = col;
  mat.emissiveColor = col.scale(0.35);
  box.material = mat;

  // A small "nose" so facing direction is visible.
  const nose = BABYLON.MeshBuilder.CreateBox("nose_" + id, { width: 0.2, depth: 0.4, height: 0.2 }, scene);
  nose.parent = box;
  nose.position.set(0, 0.3, 0.5);
  nose.material = mat;
  return box;
}

// ---- Input & look ---------------------------------------------------------

let yaw = 0;    // radians, around Y
let pitch = 0;  // radians, around X
const LOOK_SENS = 0.0022;
const keys = Object.create(null);

window.addEventListener("keydown", (e) => { keys[e.code] = true; });
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

const overlay = document.getElementById("overlay");
const crosshair = document.getElementById("crosshair");
const hitmarker = document.getElementById("hitmarker");
const healthEl = document.getElementById("health");
const hpSpan = healthEl.querySelector(".hp");
const damageEl = document.getElementById("damage");
const deathEl = document.getElementById("death");
const nameInput = document.getElementById("nameInput");
const ammoEl = document.getElementById("ammo");
const ammoCur = ammoEl.querySelector(".cur");
const ammoMag = ammoEl.querySelector(".mag");
const scoreboard = document.getElementById("scoreboard");
const scoreboardBody = scoreboard.querySelector("tbody");

let pointerLocked = false;
let firing = false;      // left mouse held
let myHp = 100;
let myAlive = true;
let myReloading = false;
let magSize = 30;
let latestPlayers = [];  // last state snapshot, for the scoreboard
let lastShotAt = 0;      // cosmetic tracer cadence (ms)
const FIRE_MS = 120;     // matches the server's fire interval

// Restore last-used name.
nameInput.value = localStorage.getItem("blockblitz-name") || "";
nameInput.focus();

function startPlaying() {
  const name = nameInput.value.trim();
  if (name) localStorage.setItem("blockblitz-name", name);
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "join", name }));
  canvas.requestPointerLock();
}

// Clicking the overlay anywhere except the name field (incl. the PLAY button) starts/resumes.
overlay.addEventListener("click", (e) => {
  if (e.target === nameInput) return; // let them focus/type
  startPlaying();
});
nameInput.addEventListener("keydown", (e) => {
  e.stopPropagation();               // don't leak typing into movement keys
  if (e.key === "Enter") startPlaying();
});

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
  overlay.classList.toggle("hidden", pointerLocked);
  crosshair.classList.toggle("hidden", !pointerLocked);
  healthEl.classList.toggle("hidden", !pointerLocked);
  ammoEl.classList.toggle("hidden", !pointerLocked);
  if (!pointerLocked) { firing = false; nameInput.focus(); }
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

// ---- Networking -----------------------------------------------------------

let myId = null;
let tickRate = 60, sendRate = 30;
let connected = false;

const wsProto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProto}://${location.host}/ws`);

ws.addEventListener("open", () => { connected = true; });
ws.addEventListener("close", () => { connected = false; });
ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === "welcome") {
    myId = msg.id;
    tickRate = msg.tickRate;
    sendRate = msg.sendRate;
    magSize = msg.magSize || magSize;
    ammoMag.textContent = magSize;
    buildObstacles(msg.obstacles || []);
  } else if (msg.type === "state") {
    applyState(msg);
  } else if (msg.type === "hit") {
    showHitmarker();
  }
});

let hitmarkerTimer = 0;
function showHitmarker() {
  hitmarker.classList.add("show");
  clearTimeout(hitmarkerTimer);
  hitmarkerTimer = setTimeout(() => hitmarker.classList.remove("show"), 90);
}

function applyState(msg) {
  latestPlayers = msg.players;
  const seen = new Set();
  for (const p of msg.players) {
    seen.add(p.id);
    if (p.id === myId) {
      // Authoritative position for our own camera; height stays fixed for now.
      camera.position.set(p.x, EYE_HEIGHT, p.z);
      updateSelf(p);
      continue;
    }
    let mesh = others.get(p.id);
    if (!mesh) { mesh = makePlayerBox(p.id); others.set(p.id, mesh); }
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.yaw;
    mesh.setEnabled(p.alive); // dead players vanish until they respawn

    // Name tag (positioned each frame in the render loop).
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

function updateSelf(p) {
  // Damage flash when our health drops.
  if (p.hp < myHp - 0.01) {
    damageEl.classList.add("flash");
    requestAnimationFrame(() => damageEl.classList.remove("flash"));
  }
  myHp = p.hp;
  myAlive = p.alive;
  myReloading = p.reloading;

  hpSpan.textContent = Math.max(0, Math.round(p.hp));
  healthEl.classList.toggle("low", p.hp <= 30);

  ammoCur.textContent = p.ammo;
  ammoEl.classList.toggle("empty", p.ammo === 0);
  ammoEl.classList.toggle("reloading", p.reloading);

  deathEl.classList.toggle("hidden", p.alive);
  crosshair.classList.toggle("hidden", !p.alive || !pointerLocked);
}

// Send our input at the server's send rate (enough to be responsive without spamming).
setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const active = pointerLocked;                       // only control the player while locked
  const shooting = firing && pointerLocked && myAlive;
  ws.send(JSON.stringify({
    type: "input",
    fwd: active && !!keys["KeyW"],
    back: active && !!keys["KeyS"],
    left: active && !!keys["KeyA"],
    right: active && !!keys["KeyD"],
    fire: shooting,
    reload: active && !!keys["KeyR"],
    yaw,
    pitch,
  }));

  // Cosmetic only: spawn a tracer + recoil at roughly the server fire rate (the server is
  // authoritative for actual hits). Predicting the cadence locally keeps the feedback instant.
  if (shooting && !myReloading && performance.now() - lastShotAt >= FIRE_MS) {
    lastShotAt = performance.now();
    spawnTracer();
    recoil = 1;
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

  // Weapon viewmodel: recoil kick decays back to rest; dip while reloading.
  recoil += (0 - recoil) * 0.25;
  const dip = myReloading ? 0.18 : 0;
  gun.position.set(GUN_BASE.x, GUN_BASE.y - dip, GUN_BASE.z - recoil * 0.12);
  gun.rotation.set(-recoil * 0.5 + dip * 1.2, 0, 0);

  scene.render();
  updateNametags();

  hud.textContent =
    `${connected ? "online" : "offline"} · ${others.size + (myId ? 1 : 0)} players · ${engine.getFps().toFixed(0)} fps`;
});

// Project each visible player's head position to screen space and place its name tag there.
function updateNametags() {
  const rect = canvas.getBoundingClientRect();
  const viewport = new BABYLON.Viewport(0, 0, rect.width, rect.height);
  const transform = scene.getTransformMatrix();
  const forward = camera.getDirection(BABYLON.Axis.Z);
  for (const [id, mesh] of others) {
    const tag = tags.get(id);
    if (!tag || tag.style.display === "none") continue;
    const head = new BABYLON.Vector3(mesh.position.x, mesh.position.y + 1.1, mesh.position.z);
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
