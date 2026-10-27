/**
 * Tiny WebAudio synth for UI/gameplay feedback. No external assets.
 */
export class AudioBus {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.6;
  }

  _ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  resume() {
    const ctx = this._ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.2, slide = 0, delay = 0 } = {}) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  click() { this.tone({ freq: 620, dur: 0.05, type: 'triangle', gain: 0.09 }); }
  pickup() {
    this.tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.16 });
    this.tone({ freq: 990, dur: 0.16, type: 'sine', gain: 0.12, delay: 0.09 });
  }
  hurt() { this.tone({ freq: 180, dur: 0.22, type: 'sawtooth', gain: 0.16, slide: -110 }); }
  escape() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'sine', gain: 0.14, delay: i * 0.11 }));
  }
  fail() {
    [330, 262, 196].forEach((f, i) => this.tone({ freq: f, dur: 0.32, type: 'triangle', gain: 0.16, delay: i * 0.14 }));
  }
  alert() { this.tone({ freq: 300, dur: 0.1, type: 'square', gain: 0.07 }); }
}
