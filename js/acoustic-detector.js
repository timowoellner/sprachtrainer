// Akustische Erkennung von Redeflussstörungen – komplett lokal, ohne Spracherkennung.
//
// Grundidee:
//  * "Äh" / "Öh" / "Ähm" (gefüllte Pause): ein stimmhafter Laut, bei dem Tonhöhe UND
//    Klangfarbe (Formanten) über längere Zeit fast unverändert bleiben. In normaler
//    Rede ändern sich beide alle 50–200 ms, weil Laute ineinander übergehen.
//  * Dehnung (Stottern, "Sssso", "Mmmmeine"): dasselbe Prinzip – ein Laut wird
//    ungewöhnlich lange gehalten. Stimmlose Reibelaute (s, sch, f) werden über die
//    Nulldurchgangsrate erkannt.
//  * Laut-/Silbenwiederholung (Stottern, "b-b-b-bitte", "ich-ich-ich"): mehrere kurze,
//    durch Mini-Pausen getrennte Silben mit nahezu gleicher Klangfarbe direkt hintereinander.

import {
  rmsDb,
  zeroCrossingRate,
  decimate,
  removeDc,
  detectPitch,
  ShapeAnalyzer,
  shapeDistance,
  hzToSemitones,
} from './dsp.js';

export const ACOUSTIC_DEFAULTS = {
  frameMs: 40,
  hopMs: 10,
  // Pegel
  speechMarginDb: 12, // so viel über dem Grundrauschen gilt als "Sprache"
  minSpeechDb: -62,
  // Tonhöhe
  minF0: 70,
  maxF0: 400,
  clarityMin: 0.72,
  // Äh / gehaltener stimmhafter Laut
  fillerMinMs: 380,
  pitchStepSt: 1.0, // max. Tonhöhensprung von Frame zu Frame (Halbtöne)
  pitchDriftSt: 2.0, // max. Abweichung vom Mittel des Lautes (Halbtöne)
  shapeTolDb: 5.5, // max. Klangfarbenänderung (dB, gemittelt über Bänder)
  gapToleranceFrames: 3,
  // Dehnung stimmloser Reibelaute
  prolongMinMs: 550,
  fricZcr: 0.28,
  // Wiederholungen
  repMinCount: 3,
  repMinSegMs: 40,
  repMaxSegMs: 320,
  repMinGapMs: 20,
  repMaxGapMs: 450,
  repShapeTolDb: 4.5,
};

export class AcousticDetector {
  constructor(sampleRate, options = {}, callbacks = {}) {
    this.sampleRate = sampleRate;
    this.opt = { ...ACOUSTIC_DEFAULTS, ...options };
    this.onEvent = callbacks.onEvent || (() => {});
    this.onFrame = callbacks.onFrame || (() => {});

    this.frameLen = Math.round((sampleRate * this.opt.frameMs) / 1000);
    this.hopLen = Math.round((sampleRate * this.opt.hopMs) / 1000);
    this.buf = new Float32Array(this.frameLen * 4);
    this.bufFill = 0;
    this.framesDone = 0;

    this.decim = Math.max(1, Math.round(sampleRate / 12000));
    this.lowRate = sampleRate / this.decim;
    this.frameCopy = new Float32Array(this.frameLen);
    this.shapes = new ShapeAnalyzer(this.lowRate, Math.floor(this.frameLen / this.decim));

    this.noiseFloor = null;
    this.suppressedUntil = -1;
    this.run = null;
    this.segment = null;
    this.silentFrames = 0;
    this.recentSegments = [];
    this.lastRepetitionAt = -Infinity;
  }

  setOptions(options) {
    Object.assign(this.opt, options);
  }

  // Aktuelle Detektorzeit in ms (bezogen auf verarbeitete Samples).
  now() {
    return (this.framesDone * this.opt.hopMs);
  }

  // Ereignisse bis zu diesem Zeitpunkt verwerfen (z. B. während der eigene Piepton läuft).
  suppressUntil(ms) {
    this.suppressedUntil = Math.max(this.suppressedUntil, ms);
    this.run = null;
    this.recentSegments = [];
  }

  push(samples) {
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, this.buf.length - this.bufFill);
      this.buf.set(samples.subarray(offset, offset + take), this.bufFill);
      this.bufFill += take;
      offset += take;
      while (this.bufFill >= this.frameLen) {
        this.frameCopy.set(this.buf.subarray(0, this.frameLen));
        this.processFrame(this.frameCopy);
        this.buf.copyWithin(0, this.hopLen, this.bufFill);
        this.bufFill -= this.hopLen;
      }
    }
  }

  processFrame(frame) {
    const o = this.opt;
    const t = this.now();
    this.framesDone++;

    const db = rmsDb(frame);
    const zcr = zeroCrossingRate(frame);
    const low = removeDc(decimate(frame, this.decim));
    const shape = this.shapes.shape(low);

    // Adaptives Grundrauschen: fällt schnell, steigt langsam.
    if (this.noiseFloor === null) this.noiseFloor = db;
    else if (db < this.noiseFloor) this.noiseFloor += (db - this.noiseFloor) * 0.3;
    else this.noiseFloor += 0.015;
    this.noiseFloor = Math.max(this.noiseFloor, -95);

    const speech = db > this.noiseFloor + o.speechMarginDb && db > o.minSpeechDb;
    let f0 = 0;
    let clarity = 0;
    if (speech) ({ f0, clarity } = detectPitch(low, this.lowRate, o.minF0, o.maxF0));
    const voiced = speech && clarity >= o.clarityMin && f0 > 0;
    const fricative = speech && !voiced && zcr >= o.fricZcr;

    const features = { t, db, noiseFloor: this.noiseFloor, speech, voiced, fricative, f0, clarity, zcr };
    this.onFrame(features);

    if (t < this.suppressedUntil) return;

    this.trackSustained(t, features, shape);
    this.trackSegments(t, features, shape);
  }

  // --- gehaltene Laute (Äh, Dehnung) ---------------------------------------
  trackSustained(t, f, shape) {
    const o = this.opt;
    const kind = f.voiced ? 'voiced' : f.fricative ? 'fric' : null;
    const st = f.voiced ? hzToSemitones(f.f0) : 0;
    const run = this.run;

    const fits =
      run &&
      kind === run.kind &&
      shapeDistance(shape, run.meanShape) <= o.shapeTolDb * (kind === 'fric' ? 1.2 : 1) &&
      (kind === 'fric' ||
        (Math.abs(st - run.lastSt) <= o.pitchStepSt && Math.abs(st - run.meanSt) <= o.pitchDriftSt));

    if (fits) {
      run.n++;
      run.gap = 0;
      run.lastT = t;
      run.lastSt = st;
      run.meanSt += (st - run.meanSt) / run.n;
      const w = 1 / Math.min(run.n, 20);
      for (let i = 0; i < shape.length; i++) run.meanShape[i] += (shape[i] - run.meanShape[i]) * w;
      run.minSt = Math.min(run.minSt, st);
      run.maxSt = Math.max(run.maxSt, st);
    } else if (run && run.gap < o.gapToleranceFrames) {
      run.gap++;
      return;
    } else {
      this.run = kind
        ? {
            kind,
            start: t,
            lastT: t,
            n: 1,
            gap: 0,
            lastSt: st,
            meanSt: st,
            minSt: st,
            maxSt: st,
            meanShape: Float32Array.from(shape),
            fired: false,
          }
        : null;
      return;
    }

    const duration = run.lastT - run.start + o.hopMs;
    const limit = run.kind === 'voiced' ? o.fillerMinMs : o.prolongMinMs;
    if (!run.fired && duration >= limit) {
      run.fired = true;
      this.onEvent({
        source: 'akustik',
        type: run.kind === 'voiced' ? 'filler' : 'prolongation',
        t: run.start,
        detectedAt: t,
        durationMs: duration,
        f0: run.kind === 'voiced' ? 55 * Math.pow(2, run.meanSt / 12) : 0,
        pitchRangeSt: run.maxSt - run.minSt,
      });
    }
  }

  // --- Silbenwiederholungen -------------------------------------------------
  trackSegments(t, f, shape) {
    const o = this.opt;
    if (f.speech) {
      this.silentFrames = 0;
      if (!this.segment) {
        this.segment = { start: t, end: t, onset: Float32Array.from(shape), onsetN: 1, peakDb: f.db, nucleus: Float32Array.from(shape) };
      } else {
        const s = this.segment;
        s.end = t;
        if (s.onsetN < 3) {
          s.onsetN++;
          for (let i = 0; i < shape.length; i++) s.onset[i] += (shape[i] - s.onset[i]) / s.onsetN;
        }
        if (f.db > s.peakDb) {
          s.peakDb = f.db;
          s.nucleus = Float32Array.from(shape);
        }
      }
      return;
    }

    if (!this.segment) return;
    this.silentFrames++;
    if (this.silentFrames * o.hopMs < o.repMinGapMs) return;

    const seg = this.segment;
    this.segment = null;
    seg.dur = seg.end - seg.start + o.hopMs;
    this.recentSegments.push(seg);
    while (this.recentSegments.length > 8) this.recentSegments.shift();
    this.checkRepetition(t);
  }

  checkRepetition(t) {
    const o = this.opt;
    const n = o.repMinCount;
    const segs = this.recentSegments;
    if (segs.length < n) return;
    const group = segs.slice(-n);
    if (group[0].start <= this.lastRepetitionAt) return;

    for (let i = 0; i < n; i++) {
      const s = group[i];
      if (s.dur < o.repMinSegMs || s.dur > o.repMaxSegMs) return;
      if (i > 0) {
        const gap = s.start - (group[i - 1].end + o.hopMs);
        if (gap > o.repMaxGapMs) return;
      }
    }
    const durs = group.map((s) => s.dur);
    if (Math.max(...durs) / Math.min(...durs) > 2.2) return;

    let worst = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d =
          (shapeDistance(group[i].onset, group[j].onset) + shapeDistance(group[i].nucleus, group[j].nucleus)) / 2;
        worst = Math.max(worst, d);
      }
    }
    if (worst > o.repShapeTolDb) return;

    this.lastRepetitionAt = group[n - 1].end;
    this.recentSegments = [];
    this.onEvent({
      source: 'akustik',
      type: 'repetition',
      t: group[0].start,
      detectedAt: t,
      durationMs: group[n - 1].end - group[0].start + o.hopMs,
      count: n,
      similarityDb: worst,
    });
  }
}
