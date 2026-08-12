"use strict";

// ---- Pre-game flow: name entry -> server browser -> hand off to game.js -----------------
//
// game.js does nothing at all — doesn't even build the 3D scene — until a lobby is chosen,
// at which point it's handed off to via window.BlockBlitzGame.start(code, name). This file
// owns everything before that, so there's nothing running in the background pre-game.

const nameScreen = document.getElementById("nameScreen");
const playerNameInput = document.getElementById("playerNameInput");
const nameContinueBtn = document.getElementById("nameContinueBtn");

const browserScreen = document.getElementById("browserScreen");
const changeNameLink = document.getElementById("changeNameLink");
const createNameInput = document.getElementById("createNameInput");
const createMapInput = document.getElementById("createMapInput");
const createMaxInput = document.getElementById("createMaxInput");
const createBtn = document.getElementById("createBtn");
const lobbyListBody = document.getElementById("lobbyListBody");
const lobbyListEmpty = document.getElementById("lobbyListEmpty");
const joinCodeInput = document.getElementById("joinCodeInput");
const joinCodeBtn = document.getElementById("joinCodeBtn");
const joinError = document.getElementById("joinError");

let myName = "";
let pollTimer = 0;

// Populate the map dropdown once; the list is static for the server's lifetime.
fetch("/api/maps").then((r) => r.json()).then((maps) => {
  createMapInput.innerHTML = "";
  for (const m of maps) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    createMapInput.appendChild(opt);
  }
}).catch(() => { /* dropdown just stays empty; server default (classic) still applies */ });

// ---- Step 1: name -----------------------------------------------------------
//
// Stored in localStorage, which only clears when the browser's site data/cache is cleared —
// so once set, we skip straight to the server browser on every later visit.

const NAME_KEY = "blockblitz-name";

function confirmName() {
  const name = playerNameInput.value.trim();
  if (name) localStorage.setItem(NAME_KEY, name);
  myName = name;
  nameScreen.classList.add("hidden");
  showBrowser();
}

nameContinueBtn.addEventListener("click", confirmName);
playerNameInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") confirmName();
});

/** Shows the name screen, pre-filled with whatever name we currently have. */
function showNameScreen() {
  hideBrowser();
  playerNameInput.value = myName;
  nameScreen.classList.remove("hidden");
  playerNameInput.focus();
}

const storedName = localStorage.getItem(NAME_KEY);
if (storedName) {
  myName = storedName;
  nameScreen.classList.add("hidden");
  showBrowser();
} else {
  playerNameInput.focus();
}

changeNameLink.addEventListener("click", showNameScreen);

// ---- Step 2: server browser -----------------------------------------------

function showBrowser() {
  browserScreen.classList.remove("hidden");
  joinError.textContent = "";
  refreshLobbies();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshLobbies, 2500);
}

function hideBrowser() {
  browserScreen.classList.add("hidden");
  clearInterval(pollTimer);
}

async function refreshLobbies() {
  let list;
  try {
    const res = await fetch("/api/lobbies");
    list = await res.json();
  } catch {
    return; // transient network hiccup — next poll will retry
  }
  lobbyListBody.innerHTML = "";
  lobbyListEmpty.classList.toggle("hidden", list.length > 0);
  for (const lobby of list) {
    const tr = document.createElement("tr");
    const name = document.createElement("td"); name.textContent = lobby.name;
    const map = document.createElement("td"); map.className = "map"; map.textContent = lobby.mapName || "";
    const count = document.createElement("td"); count.textContent = `${lobby.count}/${lobby.maxPlayers}`;
    const code = document.createElement("td"); code.className = "code"; code.textContent = lobby.code;
    tr.append(name, map, count, code);
    tr.addEventListener("click", () => joinLobby(lobby.code));
    lobbyListBody.appendChild(tr);
  }
}

createBtn.addEventListener("click", async () => {
  const name = createNameInput.value.trim() || "Lobby";
  const maxPlayers = Math.min(16, Math.max(2, parseInt(createMaxInput.value, 10) || 8));
  const mapId = createMapInput.value || undefined;
  createBtn.disabled = true;
  joinError.textContent = "";
  try {
    const res = await fetch("/api/lobbies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, maxPlayers, mapId }),
    });
    if (!res.ok) { joinError.textContent = "Couldn't create a lobby right now — try again."; return; }
    const created = await res.json();
    joinLobby(created.code);
  } catch {
    joinError.textContent = "Couldn't reach the server.";
  } finally {
    createBtn.disabled = false;
  }
});

joinCodeBtn.addEventListener("click", () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code) joinLobby(code);
});
joinCodeInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") joinCodeBtn.click();
});

function joinLobby(code) {
  hideBrowser();
  window.BlockBlitzGame.start(code, myName);
}

// Called by game.js if the WebSocket reports the lobby is gone/full instead of a welcome.
window.BlockBlitzLobby = {
  onJoinError(reason) {
    showBrowser();
    joinError.textContent = reason === "full"
      ? "That lobby is full."
      : "That lobby no longer exists — it may have closed.";
  },
};
