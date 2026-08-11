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

// ---- Player meshes --------------------------------------------------------

/** @type {Map<string, BABYLON.Mesh>} id -> box mesh for other players */
const others = new Map();

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

let pointerLocked = false;
let firing = false;   // left mouse held
let myHp = 100;
let myAlive = true;
let lastShotAt = 0;   // cosmetic tracer cadence (ms)
const FIRE_MS = 120;  // matches the server's fire interval

canvas.addEventListener("click", () => canvas.requestPointerLock());
document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
  overlay.classList.toggle("hidden", pointerLocked);
  crosshair.classList.toggle("hidden", !pointerLocked);
  healthEl.classList.toggle("hidden", !pointerLocked);
  if (!pointerLocked) firing = false; // don't keep shooting after releasing the mouse
});

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
  }
  // Remove players that left.
  for (const [id, mesh] of others) {
    if (!seen.has(id)) { mesh.dispose(); others.delete(id); }
  }
}

function updateSelf(p) {
  // Damage flash when our health drops.
  if (p.hp < myHp - 0.01) {
    damageEl.classList.add("flash");
    requestAnimationFrame(() => damageEl.classList.remove("flash"));
  }
  myHp = p.hp;
  myAlive = p.alive;

  hpSpan.textContent = Math.max(0, Math.round(p.hp));
  healthEl.classList.toggle("low", p.hp <= 30);

  deathEl.classList.toggle("hidden", p.alive);
  crosshair.classList.toggle("hidden", !p.alive || !pointerLocked);
}

// Send our input at the server's send rate (enough to be responsive without spamming).
setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const shooting = firing && pointerLocked && myAlive;
  ws.send(JSON.stringify({
    type: "input",
    fwd: !!keys["KeyW"],
    back: !!keys["KeyS"],
    left: !!keys["KeyA"],
    right: !!keys["KeyD"],
    fire: shooting,
    yaw,
    pitch,
  }));

  // Cosmetic only: spawn a tracer at roughly the server fire rate (the server is authoritative
  // for actual hits). Predicting the cadence locally keeps the feedback instant.
  if (shooting && performance.now() - lastShotAt >= FIRE_MS) {
    lastShotAt = performance.now();
    spawnTracer();
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
  scene.render();

  hud.textContent =
    `${connected ? "online" : "offline"} · id ${myId ?? "…"} · ` +
    `players ${others.size + (myId ? 1 : 0)} · ${engine.getFps().toFixed(0)} fps`;
});

window.addEventListener("resize", () => engine.resize());
