import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcousticDetector } from '../js/acoustic-detector.js';
import { SampleCollector, Spotter, buildTemplate } from '../js/sound-templates.js';
import { SR, VOWELS, vowel, silence, noise, concat, fluentSpeech } from './synth.js';

const NASAL_M = [260, 1100, 2300];

// Synthetische "Wörter"; v = Variation 0..1 (Tempo, Tonhöhe, Lautstärke)
const WORDS = {
  quasi: (v) => {
    const k = 0.85 + 0.3 * v;
    const f0 = 115 + 12 * v;
    return [
      noise(35 * k, 0.04),
      vowel({ ms: 130 * k, f0From: f0 + 8, f0To: f0, from: VOWELS.u, to: VOWELS.a, amp: 0.15 + 0.1 * v }),
      noise(90 * k, 0.05),
      vowel({ ms: 110 * k, f0From: f0, f0To: f0 - 10, from: VOWELS.i, amp: 0.12 + 0.08 * v }),
    ];
  },
  jetzt: (v) => {
    const k = 0.85 + 0.3 * v;
    const f0 = 125 + 10 * v;
    return [
      vowel({ ms: 40 * k, f0From: f0, f0To: f0, from: VOWELS.i, to: VOWELS.e, amp: 0.15 }),
      vowel({ ms: 110 * k, f0From: f0, f0To: f0 - 6, from: VOWELS.e, amp: 0.18 + 0.1 * v }),
      silence(30 * k),
      noise(110 * k, 0.06),
    ];
  },
  ehm: (v) => {
    const k = 0.85 + 0.3 * v;
    const f0 = 112 + 8 * v;
    return [
      vowel({ ms: 150 * k, f0From: f0, f0To: f0 - 1, from: VOWELS.e, amp: 0.15 + 0.08 * v }),
      vowel({ ms: 140 * k, f0From: f0 - 1, f0To: f0 - 2, from: NASAL_M, amp: 0.1 }),
    ];
  },
};

// Variation je Wiederholung, deterministisch
const variations = [0.1, 0.9, 0.4, 0.7, 0.2, 0.6, 0.0, 1.0];

function run(signal, { onRawFrame }) {
  const det = new AcousticDetector(SR, {}, { onRawFrame });
  for (let i = 0; i < signal.length; i += 1024) det.push(signal.subarray(i, i + 1024));
  return det;
}

function enroll(word, { withNegatives = false } = {}) {
  const parts = [silence(1000)];
  for (const v of variations) parts.push(...WORDS[word](v), silence(500));
  const samples = [];
  const det = new AcousticDetector(SR);
  const collector = new SampleCollector(SR, det.frameLength, 10, (s) => samples.push(s));
  det.onRawFrame = (frame, f) => collector.push(frame, f);
  const sig = concat(...parts);
  for (let i = 0; i < sig.length; i += 1024) det.push(sig.subarray(i, i + 1024));

  let negatives = null;
  if (withNegatives) {
    const neg = [];
    const d2 = new AcousticDetector(SR);
    const c2 = new SampleCollector(SR, d2.frameLength, 10, () => {});
    c2.collectAll = true;
    d2.onRawFrame = (frame, f) => c2.push(frame, f);
    const speech = fluentSpeech(30);
    for (let i = 0; i < speech.length; i += 1024) d2.push(speech.subarray(i, i + 1024));
    negatives = c2.all.length ? c2.all : neg;
  }
  return { samples, template: buildTemplate({ name: word, samples, negatives }) };
}

function spot(templates, signal) {
  const hits = [];
  let spotter;
  const det = new AcousticDetector(SR, {}, {
    onRawFrame: (frame, f) => {
      spotter ||= new Spotter(SR, det.frameLength, 10, templates, (h) => hits.push(h));
      spotter.push(frame, f);
    },
  });
  for (let i = 0; i < signal.length; i += 1024) det.push(signal.subarray(i, i + 1024));
  return hits;
}

test('Anlernen: jede Wiederholung wird als eigenes Beispiel erfasst', () => {
  const { samples, template } = enroll('quasi');
  assert.equal(samples.length, variations.length);
  assert.ok(template.threshold > 0 && Number.isFinite(template.threshold));
  assert.ok(template.stats.durationMs > 250 && template.stats.durationMs < 500, `Dauer ${template.stats.durationMs}`);
  assert.ok(template.stats.f0 > 90 && template.stats.f0 < 150, `f0 ${template.stats.f0}`);
});

test('angelerntes "quasi" wird mitten in der Rede gefunden', () => {
  const { template } = enroll('quasi', { withNegatives: true });
  const sig = concat(fluentSpeech(10), ...WORDS.quasi(0.5), fluentSpeech(10));
  const hits = spot([template], sig);
  assert.equal(hits.length, 1, JSON.stringify(hits.map((h) => [h.t, h.score])));
});

test('angelerntes "jetzt" wird gefunden, "quasi" löst es nicht aus', () => {
  const { template } = enroll('jetzt', { withNegatives: true });
  const sig = concat(fluentSpeech(8), ...WORDS.jetzt(0.3), fluentSpeech(8), ...WORDS.quasi(0.5), fluentSpeech(6));
  const hits = spot([template], sig);
  assert.equal(hits.length, 1, JSON.stringify(hits.map((h) => [h.t, h.score])));
});

test('mehrere angelernte Laute gleichzeitig werden auseinandergehalten', () => {
  const t = ['quasi', 'jetzt', 'ehm'].map((w) => enroll(w, { withNegatives: true }).template);
  const sig = concat(
    fluentSpeech(6), ...WORDS.ehm(0.5), silence(200),
    fluentSpeech(6), ...WORDS.quasi(0.3), silence(150),
    fluentSpeech(6), ...WORDS.jetzt(0.8), silence(150),
    fluentSpeech(6),
  );
  const names = spot(t, sig).map((h) => h.template.name);
  assert.deepEqual(names, ['ehm', 'quasi', 'jetzt']);
});

test('ohne den Laut gibt es keine Treffer', () => {
  const t = ['quasi', 'jetzt', 'ehm'].map((w) => enroll(w, { withNegatives: true }).template);
  assert.deepEqual(spot(t, fluentSpeech(40)).map((h) => h.template.name), []);
});

test('Empfindlichkeit: kleiner Wert macht strenger', () => {
  const { template } = enroll('quasi');
  template.sensitivity = 0.3;
  const sig = concat(fluentSpeech(6), ...WORDS.quasi(0.5), fluentSpeech(6));
  assert.equal(spot([template], sig).length, 0);
});

test('Vorlage lässt sich als JSON speichern und wieder nutzen', () => {
  const { template } = enroll('ehm');
  const restored = JSON.parse(JSON.stringify(template));
  const sig = concat(fluentSpeech(6), ...WORDS.ehm(0.5), silence(200), fluentSpeech(6));
  assert.equal(spot([restored], sig).length, 1);
});
