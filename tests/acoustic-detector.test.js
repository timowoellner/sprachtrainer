import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcousticDetector } from '../js/acoustic-detector.js';
import { detectPitch } from '../js/dsp.js';
import { SR, VOWELS, vowel, silence, noise, concat, fluentSpeech } from './synth.js';

function analyze(signal, options = {}) {
  const events = [];
  const det = new AcousticDetector(SR, options, { onEvent: (e) => events.push(e) });
  // in kleinen Blöcken wie aus dem AudioWorklet
  for (let i = 0; i < signal.length; i += 1024) det.push(signal.subarray(i, i + 1024));
  return events;
}

test('Tonhöhe eines synthetischen Vokals wird erkannt', () => {
  const x = vowel({ ms: 40, f0From: 140, from: VOWELS.a });
  const low = new Float32Array(480);
  for (let i = 0; i < 480; i++) low[i] = (x[i * 4] + x[i * 4 + 1] + x[i * 4 + 2] + x[i * 4 + 3]) / 4;
  const { f0, clarity } = detectPitch(low, 12000);
  assert.ok(Math.abs(f0 - 140) < 4, `f0=${f0}`);
  assert.ok(clarity > 0.8, `clarity=${clarity}`);
});

test('gehaltenes "Äh" (600 ms, gleiche Tonhöhe und Klangfarbe) löst Äh-Alarm aus', () => {
  const sig = concat(silence(400), vowel({ ms: 600, f0From: 118, f0To: 116, from: VOWELS.ae }), silence(400));
  const events = analyze(sig);
  const fillers = events.filter((e) => e.type === 'filler');
  assert.equal(fillers.length, 1, JSON.stringify(events));
  assert.ok(fillers[0].t >= 350 && fillers[0].t <= 480, `start ${fillers[0].t}`);
});

test('"Öh" wird ebenfalls erkannt', () => {
  const sig = concat(silence(400), vowel({ ms: 500, f0From: 105, from: VOWELS.oe }), silence(400));
  assert.equal(analyze(sig).filter((e) => e.type === 'filler').length, 1);
});

test('kurzer Vokal (200 ms) ist kein Äh', () => {
  const sig = concat(silence(400), vowel({ ms: 200, f0From: 120, from: VOWELS.ae }), silence(400));
  assert.equal(analyze(sig).length, 0);
});

test('flüssige Rede mit wechselnden Lauten erzeugt keinen Alarm', () => {
  const events = analyze(fluentSpeech(18));
  assert.equal(events.length, 0, JSON.stringify(events));
});

test('langer Vokal mit starker Tonhöhenbewegung (Betonung) ist kein Äh', () => {
  const sig = concat(silence(400), vowel({ ms: 500, f0From: 180, f0To: 110, from: VOWELS.a }), silence(400));
  assert.equal(analyze(sig).filter((e) => e.type === 'filler').length, 0);
});

test('langer Vokal mit wanderndem Formant (Diphthong "ei") ist kein Äh', () => {
  const sig = concat(silence(400), vowel({ ms: 450, f0From: 125, from: VOWELS.a, to: VOWELS.i }), silence(400));
  assert.equal(analyze(sig).filter((e) => e.type === 'filler').length, 0);
});

test('Silbenwiederholung "ba-ba-ba" löst Stotter-Alarm aus', () => {
  const syl = () => vowel({ ms: 130, f0From: 130, f0To: 125, from: VOWELS.a });
  const sig = concat(silence(400), syl(), silence(90), syl(), silence(90), syl(), silence(500));
  const reps = analyze(sig).filter((e) => e.type === 'repetition');
  assert.equal(reps.length, 1);
});

test('drei verschiedene Silben sind keine Wiederholung', () => {
  const sig = concat(
    silence(400),
    vowel({ ms: 130, f0From: 130, from: VOWELS.a }),
    silence(90),
    vowel({ ms: 130, f0From: 120, from: VOWELS.i }),
    silence(90),
    vowel({ ms: 130, f0From: 140, from: VOWELS.u }),
    silence(500),
  );
  assert.equal(analyze(sig).filter((e) => e.type === 'repetition').length, 0);
});

test('gedehntes "Ssss" (stimmloser Reibelaut) löst Dehnungs-Alarm aus', () => {
  const sig = concat(silence(400), noise(800), silence(400));
  const events = analyze(sig);
  assert.equal(events.filter((e) => e.type === 'prolongation').length, 1, JSON.stringify(events));
});

test('Unterdrückung (eigener Piepton) verhindert Alarme', () => {
  const sig = concat(silence(400), vowel({ ms: 600, f0From: 118, from: VOWELS.ae }), silence(400));
  const events = [];
  const det = new AcousticDetector(SR, {}, { onEvent: (e) => events.push(e) });
  det.suppressUntil(1200);
  det.push(sig);
  assert.equal(events.length, 0);
});
