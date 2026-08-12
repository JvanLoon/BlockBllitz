"use strict";

// ---- Procedural sound effects (Web Audio) ----------------------------------
//
// No external audio files: every sound here is synthesized at runtime from
// noise bursts / oscillators run through filters and gain envelopes. Keeps
// the game asset-free and makes it trivial to add new weapon sounds later —
// just describe a new envelope, no asset pipeline needed.

const SFX = (() => {
  let ctx = null;
  let noiseBuffer = null;
  let master = null;
  let unlocked = false;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);

    // 2s of white noise, reused (with random start offsets) for every noise-based hit.
    const len = ctx.sampleRate * 2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Must be called from a user-gesture handler (browsers block audio otherwise). */
  function unlock() {
    init();
    if (!unlocked && ctx.state === "suspended") ctx.resume();
    unlocked = true;
  }

  function noiseSource() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loopStart = Math.random() * 1.5;
    src.loop = false;
    return src;
  }

  function now() { return ctx.currentTime; }

  /** A filtered burst of noise with a linear decay envelope. */
  function noiseBurst({ t = now(), duration = 0.08, filterType = "bandpass", freq = 1200, q = 1, gain = 0.6, dest = master }) {
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(dest);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  /** A short oscillator blip, for the "body" of a shot or the pitch of a click. */
  function tone({ t = now(), freq = 220, endFreq = null, type = "sine", duration = 0.08, gain = 0.5, dest = master }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // ---- Weapon gunshots --------------------------------------------------

  const shots = {
    pistol() {
      const t = now();
      noiseBurst({ t, duration: 0.09, filterType: "bandpass", freq: 1400, q: 0.8, gain: 0.7 });
      tone({ t, freq: 160, endFreq: 60, type: "square", duration: 0.06, gain: 0.35 });
    },
    smg() {
      const t = now();
      noiseBurst({ t, duration: 0.05, filterType: "highpass", freq: 900, q: 0.6, gain: 0.55 });
      tone({ t, freq: 260, endFreq: 90, type: "square", duration: 0.04, gain: 0.22 });
    },
    rifle() {
      const t = now();
      noiseBurst({ t, duration: 0.11, filterType: "bandpass", freq: 750, q: 0.7, gain: 0.75 });
      tone({ t, freq: 130, endFreq: 45, type: "sawtooth", duration: 0.08, gain: 0.3 });
    },
    shotgun() {
      const t = now();
      noiseBurst({ t, duration: 0.22, filterType: "lowpass", freq: 2200, q: 0.4, gain: 0.9 });
      tone({ t, freq: 95, endFreq: 40, type: "sine", duration: 0.22, gain: 0.55 });
    },
  };

  function shoot(kind) { (shots[kind] || shots.rifle)(); }

  function dryFire() {
    const t = now();
    noiseBurst({ t, duration: 0.02, filterType: "highpass", freq: 3000, q: 1, gain: 0.35 });
  }

  /** Knife swing: a quick air whoosh, no bang. */
  function swing() {
    const t = now();
    noiseBurst({ t, duration: 0.09, filterType: "bandpass", freq: 1800, q: 0.4, gain: 0.3 });
  }

  /** Weapon pickup: a bright ascending two-note chime. */
  function pickup() {
    const t = now();
    tone({ t, freq: 700, type: "triangle", duration: 0.09, gain: 0.3 });
    tone({ t: t + 0.07, freq: 1050, type: "triangle", duration: 0.12, gain: 0.32 });
  }

  function reloadStart() {
    const t = now();
    noiseBurst({ t, duration: 0.05, filterType: "bandpass", freq: 500, q: 3, gain: 0.4 });
    tone({ t, freq: 220, type: "square", duration: 0.03, gain: 0.18 });
  }

  function reloadEnd() {
    const t = now();
    noiseBurst({ t, duration: 0.06, filterType: "bandpass", freq: 700, q: 3, gain: 0.45 });
    tone({ t, freq: 340, type: "square", duration: 0.04, gain: 0.2 });
  }

  function switchWeapon() {
    const t = now();
    noiseBurst({ t, duration: 0.03, filterType: "highpass", freq: 2000, q: 1, gain: 0.25 });
    tone({ t: t + 0.02, freq: 500, type: "square", duration: 0.02, gain: 0.15 });
  }

  function hitmarker() {
    const t = now();
    tone({ t, freq: 2000, type: "square", duration: 0.035, gain: 0.25 });
    tone({ t: t + 0.03, freq: 2600, type: "square", duration: 0.03, gain: 0.2 });
  }

  function damage() {
    const t = now();
    tone({ t, freq: 140, endFreq: 55, type: "sine", duration: 0.16, gain: 0.4 });
    noiseBurst({ t, duration: 0.14, filterType: "lowpass", freq: 400, q: 0.5, gain: 0.35 });
  }

  function death() {
    const t = now();
    tone({ t, freq: 300, endFreq: 40, type: "sawtooth", duration: 0.45, gain: 0.35 });
    noiseBurst({ t: t + 0.05, duration: 0.3, filterType: "lowpass", freq: 300, q: 0.4, gain: 0.3 });
  }

  let lastStep = 0;
  function footstep() {
    const t = now();
    const freq = 220 + Math.random() * 60;
    noiseBurst({ t, duration: 0.07, filterType: "lowpass", freq: 500, q: 0.6, gain: 0.18 });
    tone({ t, freq, type: "sine", duration: 0.05, gain: 0.08 });
  }
  /** Throttled footstep, safe to call every frame while moving. */
  function footstepThrottled(intervalMs) {
    const t = performance.now();
    if (t - lastStep < intervalMs) return;
    lastStep = t;
    footstep();
  }

  return { unlock, shoot, dryFire, swing, pickup, reloadStart, reloadEnd, switchWeapon, hitmarker, damage, death, footstepThrottled };
})();
