// Grundlegende Signalverarbeitung: Pegel, Nulldurchgänge, Tonhöhe, Spektralform.
// Alles rein rechnerisch (kein Web Audio), damit es auch in Node testbar ist.

export function rmsDb(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return 20 * Math.log10(Math.sqrt(s / x.length) + 1e-10);
}

export function zeroCrossingRate(x) {
  let c = 0;
  for (let i = 1; i < x.length; i++) {
    if ((x[i] >= 0) !== (x[i - 1] >= 0)) c++;
  }
  return c / (x.length - 1);
}

// Einfache Dezimierung per Mittelwert (reicht für Tonhöhe und grobe Spektralform).
export function decimate(x, factor, out) {
  const n = Math.floor(x.length / factor);
  const y = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * factor;
    for (let k = 0; k < factor; k++) s += x[o + k];
    y[i] = s / factor;
  }
  return y;
}

export function removeDc(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length;
  for (let i = 0; i < x.length; i++) x[i] -= m;
  return x;
}

// Grundfrequenz per NSDF (McLeod Pitch Method).
// Liefert { f0, clarity }; clarity nahe 1 = klar stimmhaft/periodisch.
export function detectPitch(x, sampleRate, minF0 = 70, maxF0 = 400) {
  const n = x.length;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxF0));
  const tauMax = Math.min(n - 2, Math.ceil(sampleRate / minF0));
  if (tauMax <= tauMin + 2) return { f0: 0, clarity: 0 };

  const nsdf = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let acf = 0;
    let m = 0;
    for (let i = 0; i < n - tau; i++) {
      const a = x[i];
      const b = x[i + tau];
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Lokale Maxima jeweils zwischen positivem Nulldurchgang und nächstem negativen sammeln.
  const peaks = [];
  let tau = 1;
  while (tau <= tauMax && nsdf[tau] > 0) tau++; // erste Hauptkeule überspringen
  while (tau <= tauMax) {
    while (tau <= tauMax && nsdf[tau] <= 0) tau++;
    let best = -1;
    let bestTau = -1;
    while (tau <= tauMax && nsdf[tau] > 0) {
      if (nsdf[tau] > best) {
        best = nsdf[tau];
        bestTau = tau;
      }
      tau++;
    }
    if (bestTau >= tauMin) peaks.push(bestTau);
  }
  if (!peaks.length) return { f0: 0, clarity: 0 };

  let globalMax = 0;
  for (const p of peaks) globalMax = Math.max(globalMax, nsdf[p]);
  const chosen = peaks.find((p) => nsdf[p] >= 0.9 * globalMax);

  // Parabolische Interpolation für eine feinere Periodenschätzung.
  const a = nsdf[chosen - 1];
  const b = nsdf[chosen];
  const c = nsdf[chosen + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  const period = chosen + Math.max(-0.5, Math.min(0.5, shift));
  return { f0: sampleRate / period, clarity: b };
}

// In-place Radix-2-FFT (re/im gleiche Länge, Zweierpotenz).
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Logarithmisch verteilte Frequenzbänder für die Spektralform.
export function makeBands(sampleRate, fftSize, count = 16, fLow = 150, fHigh = 5000) {
  const nyquist = sampleRate / 2;
  const hi = Math.min(fHigh, nyquist * 0.95);
  const binHz = sampleRate / fftSize;
  const edges = [];
  for (let i = 0; i <= count; i++) edges.push(fLow * Math.pow(hi / fLow, i / count));
  const bands = [];
  for (let i = 0; i < count; i++) {
    const from = Math.max(1, Math.floor(edges[i] / binHz));
    const to = Math.max(from + 1, Math.ceil(edges[i + 1] / binHz));
    bands.push([from, Math.min(to, fftSize / 2)]);
  }
  return bands;
}

// Spektralform eines Frames: Bandenergien in dB, pegelbereinigt (Mittelwert abgezogen).
// Damit vergleicht man "Klangfarbe" unabhängig von der Lautstärke.
export class ShapeAnalyzer {
  constructor(sampleRate, frameLength, bandCount = 16) {
    this.size = nextPow2(frameLength);
    this.re = new Float32Array(this.size);
    this.im = new Float32Array(this.size);
    this.window = new Float32Array(frameLength);
    for (let i = 0; i < frameLength; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameLength - 1));
    }
    this.bands = makeBands(sampleRate, this.size, bandCount);
  }

  shape(x) {
    const { re, im, window, bands } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < x.length && i < window.length; i++) re[i] = x[i] * window[i];
    fft(re, im);
    const out = new Float32Array(bands.length);
    let mean = 0;
    for (let b = 0; b < bands.length; b++) {
      let p = 0;
      for (let k = bands[b][0]; k < bands[b][1]; k++) p += re[k] * re[k] + im[k] * im[k];
      out[b] = 10 * Math.log10(p + 1e-12);
      mean += out[b];
    }
    mean /= bands.length;
    for (let b = 0; b < out.length; b++) out[b] -= mean;
    return out;
  }
}

// Mittlere absolute Abweichung zweier Spektralformen in dB.
export function shapeDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

export function hzToSemitones(f) {
  return 12 * Math.log2(f / 55);
}
