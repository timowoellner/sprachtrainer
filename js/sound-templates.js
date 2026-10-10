// Trainingsmodus: eigene Laute und Wörter anlernen ("ehm", "quasi", "jetzt" …).
//
// Jede vorgesprochene Wiederholung wird als Klangverlauf gespeichert: alle 10 ms die
// Klangfarbe in 20 Frequenzbändern. Live wird der Mikrofonstrom fortlaufend mit allen
// Beispielen verglichen (Dynamic Time Warping), wobei schnelleres oder langsameres
// Sprechen ausgeglichen wird. Ist der Abstand zu einem Beispiel klein genug, gilt der
// Laut als erkannt. Die Schwelle ergibt sich aus den Beispielen selbst: wie ähnlich
// sich deine Wiederholungen untereinander sind.

import { decimate, removeDc, fft, nextPow2, makeBands, hzToSemitones } from './dsp.js';

export const SPOT_BANDS = 20;
const WARP_PENALTY = 1.0; // dB-Aufschlag für jeden Dehnungs-/Stauchungsschritt
const MIN_SPAN = 0.6; // erkannter Abschnitt darf 60 % …
const MAX_SPAN = 1.7; // … bis 170 % der Beispiellänge dauern

// Klangfarbe eines Frames in 20 Bändern bis 7 kHz (pegelbereinigt, dB).
export class SpotFeatures {
  constructor(sampleRate, frameLength) {
    this.decim = Math.max(1, Math.round(sampleRate / 16000));
    this.rate = sampleRate / this.decim;
    this.len = Math.floor(frameLength / this.decim);
    this.size = nextPow2(this.len);
    this.low = new Float32Array(this.len);
    this.re = new Float32Array(this.size);
    this.im = new Float32Array(this.size);
    this.window = new Float32Array(this.len);
    for (let i = 0; i < this.len; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.len - 1));
    this.bands = makeBands(this.rate, this.size, SPOT_BANDS, 120, 7000);
  }

  compute(frame) {
    const x = removeDc(decimate(frame, this.decim, this.low));
    const { re, im, window, bands } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < this.len; i++) re[i] = x[i] * window[i];
    fft(re, im);
    const out = new Float32Array(bands.length);
    let mean = 0;
    for (let b = 0; b < bands.length; b++) {
      let p = 0;
      for (let k = bands[b][0]; k < bands[b][1]; k++) p += re[k] * re[k] + im[k] * im[k];
      out[b] = 10 * Math.log10(p / (bands[b][1] - bands[b][0]) + 1e-12);
      mean += out[b];
    }
    mean /= bands.length;
    for (let b = 0; b < out.length; b++) out[b] -= mean;
    return out;
  }
}

function frameDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// Teilfolgen-DTW: findet ein Beispiel irgendwo im laufenden Strom (freier Anfang).
export class SequenceMatcher {
  constructor(seq) {
    this.seq = seq;
    const m = seq.length;
    this.prev = new Float32Array(m).fill(Infinity);
    this.cur = new Float32Array(m);
    this.prevStart = new Int32Array(m);
    this.curStart = new Int32Array(m);
  }

  reset() {
    this.prev.fill(Infinity);
  }

  // Nimmt den nächsten Frame des Stroms; liefert Abstand (dB) und Länge der besten Fundstelle, die hier endet.
  step(feat, j) {
    const { seq, prev, cur, prevStart, curStart } = this;
    const m = seq.length;
    for (let i = 0; i < m; i++) {
      const d = frameDistance(seq[i], feat);
      if (i === 0) {
        cur[0] = d;
        curStart[0] = j;
        continue;
      }
      let best = prev[i - 1];
      let start = prevStart[i - 1];
      if (prev[i] + WARP_PENALTY < best) {
        best = prev[i] + WARP_PENALTY;
        start = prevStart[i];
      }
      if (cur[i - 1] + WARP_PENALTY < best) {
        best = cur[i - 1] + WARP_PENALTY;
        start = curStart[i - 1];
      }
      cur[i] = best + d;
      curStart[i] = start;
    }
    this.prev = cur;
    this.cur = prev;
    this.prevStart = curStart;
    this.curStart = prevStart;
    const span = j - curStart[m - 1] + 1;
    const ok = span >= MIN_SPAN * m && span <= MAX_SPAN * m;
    return { score: ok ? cur[m - 1] / m : Infinity, span };
  }
}

// Bester (kleinster) Abstand der Beispiele zu irgendeiner Stelle in einer Folge.
export function bestScore(sampleSeqs, seq) {
  let best = Infinity;
  for (const s of sampleSeqs) {
    const m = new SequenceMatcher(s);
    for (let j = 0; j < seq.length; j++) best = Math.min(best, m.step(seq[j], j).score);
  }
  return best;
}

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));

// Aus den Beispielen eine Vorlage bauen.
// samples: [{ features: Float32Array[], durationMs, f0 }]
// negatives: optional Merkmalsfolge normaler Sprache ohne den Laut (Gegenprobe)
export function buildTemplate({ name, category = 'fuellwort', color = 'red', samples, negatives = null }) {
  if (samples.length < 3) throw new Error('Mindestens 3 Beispiele nötig');
  const seqs = samples.map((s) => s.features);

  // Wie ähnlich sind sich die Wiederholungen? (jedes Beispiel gegen alle anderen)
  const intra = seqs.map((seq, i) => bestScore(seqs.filter((_, k) => k !== i), seq));
  const finiteIntra = intra.filter(Number.isFinite);
  // Größter Abstand unter den eigenen Wiederholungen plus 50 % Spielraum
  let threshold = Math.max(...finiteIntra) * 1.5;

  let negativeMin = null;
  if (negatives && negatives.length > 10) {
    negativeMin = bestScore(seqs, negatives);
    // Schwelle unter den kleinsten Abstand zu normaler Sprache legen
    if (Number.isFinite(negativeMin)) threshold = Math.min(threshold, negativeMin * 0.92);
  }

  const durations = samples.map((s) => s.durationMs);
  const f0s = samples.map((s) => s.f0).filter((f) => f > 0);
  return {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    category,
    color,
    sensitivity: 1,
    threshold,
    samples: seqs.map((seq) => seq.map((f) => Array.from(f, (x) => Math.round(x * 10) / 10))),
    stats: {
      count: samples.length,
      durationMs: Math.round(mean(durations)),
      durationSdMs: Math.round(sd(durations)),
      f0: f0s.length ? Math.round(mean(f0s)) : 0,
      f0SdSt: f0s.length > 1 ? Math.round(sd(f0s.map(hzToSemitones)) * 10) / 10 : 0,
      consistencyDb: Math.round(mean(finiteIntra) * 100) / 100,
      negativeMinDb: negativeMin === null ? null : Math.round(negativeMin * 100) / 100,
      distinct: negativeMin === null ? null : negativeMin > Math.max(...finiteIntra) * 1.1,
      createdAt: new Date().toISOString(),
    },
  };
}

// Live-Erkennung aller angelernten Laute im Mikrofonstrom.
export class Spotter {
  constructor(sampleRate, frameLength, hopMs, templates, onHit) {
    this.features = new SpotFeatures(sampleRate, frameLength);
    this.hopMs = hopMs;
    this.onHit = onHit;
    this.j = 0;
    this.silentFrames = 0;
    this.setTemplates(templates);
  }

  setTemplates(templates) {
    this.entries = templates.map((t) => ({
      template: t,
      matchers: t.samples.map((s) => new SequenceMatcher(s.map((f) => Float32Array.from(f)))),
      candidate: null,
      blockedUntil: -1,
    }));
  }

  push(frame, f) {
    if (!this.entries.length) return;
    const j = this.j++;
    this.silentFrames = f.speech ? 0 : this.silentFrames + 1;
    if (this.silentFrames * this.hopMs > 400) {
      // lange Stille: nichts zu vergleichen, Rechenzeit sparen
      if (!this.idle) {
        for (const e of this.entries) {
          e.matchers.forEach((m) => m.reset());
          e.candidate = null;
        }
        this.idle = true;
      }
      return;
    }
    this.idle = false;
    const feat = this.features.compute(frame);

    for (const e of this.entries) {
      let best = Infinity;
      let span = 0;
      for (const m of e.matchers) {
        const r = m.step(feat, j);
        if (r.score < best) {
          best = r.score;
          span = r.span;
        }
      }
      const limit = e.template.threshold * (e.template.sensitivity || 1);
      if (best < limit && j >= e.blockedUntil && !f.suppressed) {
        if (!e.candidate || best < e.candidate.score) e.candidate = { score: best, span, j, t: f.t, age: 0 };
        else e.candidate.age++;
      } else if (e.candidate) {
        e.candidate.age++;
      }
      // Erst melden, wenn der Abstand nicht mehr kleiner wird (bestes Ende gefunden)
      if (e.candidate && e.candidate.age >= 3) {
        const c = e.candidate;
        e.candidate = null;
        e.blockedUntil = c.j + Math.round(c.span * 0.8);
        this.onHit({
          template: e.template,
          score: c.score,
          durationMs: c.span * this.hopMs,
          t: c.t - c.span * this.hopMs,
        });
      }
    }
  }
}

// Sammelt beim Anlernen einzelne Äußerungen (Laut – Pause – Laut – Pause …).
export class SampleCollector {
  constructor(sampleRate, frameLength, hopMs, onSample) {
    this.features = new SpotFeatures(sampleRate, frameLength);
    this.hopMs = hopMs;
    this.onSample = onSample;
    this.current = null;
    this.prevFeat = null;
    this.silentFrames = 0;
    this.all = []; // alle Frames für die Gegenprobe
    this.collectAll = false;
  }

  push(frame, f) {
    const feat = this.features.compute(frame);
    if (this.collectAll) this.all.push(feat);
    if (f.suppressed) return;
    if (f.speech) {
      this.silentFrames = 0;
      if (!this.current) this.current = { frames: [], lastSpeech: 0, f0: [], start: f.t, pre: this.prevFeat };
      this.current.frames.push(feat);
      this.current.lastSpeech = this.current.frames.length;
      if (f.voiced) this.current.f0.push(f.f0);
    } else if (this.current) {
      this.silentFrames++;
      this.current.frames.push(feat);
      if (this.silentFrames * this.hopMs >= 250) this.finish();
    }
    this.prevFeat = feat;
  }

  finish() {
    const c = this.current;
    this.current = null;
    // Stille am Ende abschneiden, ein Frame Rand bleibt
    const frames = c.frames.slice(0, c.lastSpeech + 1);
    if (c.pre) frames.unshift(c.pre);
    const durationMs = c.lastSpeech * this.hopMs;
    if (durationMs < 80 || durationMs > 2000) return;
    const f0 = c.f0.length ? c.f0.sort((a, b) => a - b)[Math.floor(c.f0.length / 2)] : 0;
    this.onSample({ features: frames, durationMs, f0 });
  }
}

// --- Speichern (nur im Browser dieses Geräts) --------------------------------

const STORE_KEY = 'redefluss-trainer-sounds-v1';

export function loadTemplates() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveTemplates(templates) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(templates));
    return true;
  } catch {
    return false;
  }
}
