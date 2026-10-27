/** Minimal WebAudio sound effects (no external assets). */
let ctx = null;
let master = null;
let muted = false;

function ensure() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  return ctx;
}

export function setVolume(value) {
  ensure();
  if (master) master.gain.value = Math.max(0, Math.min(1, value));
}

export function setMuted(value) {
  muted = value;
  if (master) master.gain.value = value ? 0 : master.gain.value;
}

export function resumeAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
}

function tone({ freq = 440, type = 'sine', duration = 0.12, gain = 0.15, delay = 0, slide = 0 }) {
  const c = ensure();
  if (!c || muted) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function noise({ duration = 0.25, gain = 0.16, lowpass = 900 }) {
  const c = ensure();
  if (!c || muted) return;
  const frames = Math.floor(c.sampleRate * duration);
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpass;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start();
}

export const sfx = {
  ui: () => tone({ freq: 520, type: 'triangle', duration: 0.07, gain: 0.07 }),
  select: () => {
    tone({ freq: 420, type: 'triangle', duration: 0.07, gain: 0.08 });
    tone({ freq: 700, type: 'triangle', duration: 0.09, gain: 0.06, delay: 0.06 });
  },
  pickup: () => {
    tone({ freq: 660, type: 'sine', duration: 0.16, gain: 0.13 });
    tone({ freq: 990, type: 'sine', duration: 0.22, gain: 0.1, delay: 0.08 });
  },
  damage: () => {
    noise({ duration: 0.3, gain: 0.2, lowpass: 700 });
    tone({ freq: 130, type: 'sawtooth', duration: 0.26, gain: 0.13, slide: -60 });
  },
  alert: () => {
    tone({ freq: 880, type: 'square', duration: 0.1, gain: 0.06 });
    tone({ freq: 660, type: 'square', duration: 0.1, gain: 0.06, delay: 0.12 });
  },
  escape: () => {
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, type: 'sine', duration: 0.28, gain: 0.11, delay: i * 0.11 }));
  },
  fail: () => {
    [330, 262, 196].forEach((f, i) => tone({ freq: f, type: 'sawtooth', duration: 0.4, gain: 0.11, delay: i * 0.16 }));
  },
  step: () => {
    noise({ duration: 0.08, gain: 0.025, lowpass: 420 });
  },
};
