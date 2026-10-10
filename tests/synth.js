// Synthetische Testsignale: grobe Vokal-Imitation (Quelle-Filter-Prinzip) und Rauschen.

export const SR = 48000;

// Formantfrequenzen grob nach deutschen Vokalen (F1, F2, F3)
export const VOWELS = {
  a: [800, 1250, 2600],
  ae: [600, 1750, 2600], // "ä" – typischer Äh-Laut
  e: [400, 2100, 2700],
  i: [300, 2300, 3000],
  o: [450, 850, 2600],
  u: [320, 750, 2400],
  oe: [460, 1450, 2400], // "ö"
};

let seed = Number(globalThis.process?.env?.SYNTH_SEED ?? 12345);
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

// Harmonische Quelle mit Formant-Gewichtung; f0 und Formanten dürfen über die Zeit gleiten.
export function vowel({ ms, f0From, f0To = f0From, from, to = from, amp = 0.2 }) {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const f0 = f0From + (f0To - f0From) * p;
    const formants = from.map((f, k) => f + (to[k] - f) * p);
    phase += (2 * Math.PI * f0) / SR;
    let s = 0;
    for (let h = 1; h * f0 < 5500; h++) {
      const fh = h * f0;
      let g = 0;
      for (const fm of formants) {
        const bw = 80 + fm * 0.06;
        g += 1 / (1 + ((fh - fm) / bw) ** 2);
      }
      s += (g / h) * Math.sin(h * phase);
    }
    // weiche Ein-/Ausblendung
    const env = Math.min(1, i / (SR * 0.01), (n - i) / (SR * 0.01));
    out[i] = s * amp * env * 0.4;
  }
  return out;
}

export function silence(ms) {
  return new Float32Array(Math.round((SR * ms) / 1000));
}

export function noise(ms, amp = 0.05) {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    out[i] = (w - prev * 0.5) * amp; // leicht hochpassgefiltert ("s"-artig)
    prev = w;
  }
  return out;
}

export function concat(...parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  // Grundrauschen, damit der Pegelschätzer realistisch arbeitet
  for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * 0.0005;
  return out;
}

// Flüssige "Rede": kurze Silben mit wechselnden Vokalen und gleitender Tonhöhe.
export function fluentSpeech(syllables = 12) {
  const keys = ['a', 'e', 'i', 'o', 'u', 'ae', 'oe'];
  const parts = [silence(300)];
  let f0 = 130;
  for (let k = 0; k < syllables; k++) {
    const v1 = VOWELS[keys[k % keys.length]];
    const v2 = VOWELS[keys[(k * 3 + 2) % keys.length]];
    const next = 110 + ((k * 37) % 60);
    parts.push(vowel({ ms: 110 + ((k * 23) % 90), f0From: f0, f0To: next, from: v1, to: v2 }));
    f0 = next;
    if (k % 3 === 2) parts.push(silence(60));
  }
  parts.push(silence(300));
  return concat(...parts);
}
