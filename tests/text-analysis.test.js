import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, findFillers, findRepetitions, checkSentenceEnd } from '../js/text-analysis.js';

const fillers = (s, extra) => findFillers(tokenize(s), extra).map((f) => f.word);
const reps = (s) => findRepetitions(tokenize(s)).map((r) => `${r.kind}:${r.word}`);
const end = (s) => checkSentenceEnd(tokenize(s))?.kind ?? null;

test('Äh-Varianten werden im Text erkannt', () => {
  assert.deepEqual(fillers('ich habe äh das ähm Problem öh gesehen'), ['äh', 'ähm', 'öh']);
  assert.deepEqual(fillers('Ähm, also hm, ehm'), ['Ähm', 'hm', 'ehm']);
  assert.deepEqual(fillers('Das Ergebnis ist gut'), []);
});

test('eigene Füllwörter werden erkannt', () => {
  assert.deepEqual(fillers('das ist halt sozusagen quasi fertig', ['halt', 'sozusagen', 'quasi']), ['halt', 'sozusagen', 'quasi']);
});

test('Wortwiederholungen', () => {
  assert.deepEqual(reps('ich ich ich möchte heute'), ['wort:ich']);
  assert.deepEqual(reps('wir wir starten'), ['wort:wir']);
  assert.deepEqual(reps('ich äh ich glaube'), ['wort:ich']);
});

test('legitime Doppelungen ("die die") nur bei dreifacher Wiederholung', () => {
  assert.deepEqual(reps('Leute die die Regeln kennen'), []);
  assert.deepEqual(reps('und die die die Kunden'), ['wort:die']);
});

test('Teilwortwiederholungen', () => {
  assert.deepEqual(reps('das ist ein Pro Projekt'), ['teilwort:Pro… Projekt']);
  assert.deepEqual(reps('das ist w wichtig'), ['teilwort:w… wichtig']);
  assert.deepEqual(reps('wir fahren in Indien herum'), []);
});

test('Satz bricht mit Artikel/Konjunktion ab', () => {
  assert.equal(end('Wir haben im letzten Jahr die'), 'abgebrochen');
  assert.equal(end('Das Ergebnis war gut und'), 'abgebrochen');
  assert.equal(end('Ich zeige Ihnen jetzt unsere'), 'abgebrochen');
});

test('trennbare Verbpartikel am Ende sind korrekt', () => {
  assert.equal(end('Ich rufe Sie morgen an'), null);
  assert.equal(end('Wir fangen jetzt mit dem Thema an'), null);
  assert.equal(end('Bitte machen Sie das Fenster auf'), null);
});

test('Nebensatz ohne Verb am Ende', () => {
  assert.equal(end('Ich glaube dass wir das Projekt'), 'verb_fehlt');
  assert.equal(end('Es ist wichtig weil die Kunden das Ergebnis'), 'verb_fehlt');
  assert.equal(end('Ich glaube dass wir das Projekt erfolgreich abschließen'), null);
  assert.equal(end('Ich weiß nicht ob das funktioniert'), null);
});

test('offene Verbklammer nach Modalverb', () => {
  assert.equal(end('Ich möchte heute über unser neues Projekt'), 'verb_fehlt');
  assert.equal(end('Wir werden im nächsten Quartal die Kosten'), 'verb_fehlt');
  assert.equal(end('Ich möchte heute über unser neues Projekt sprechen'), null);
  assert.equal(end('Wir werden die Kosten deutlich senken'), null);
});

test('normale Hauptsätze sind in Ordnung', () => {
  assert.equal(end('Das Projekt war ein großer Erfolg'), null);
  assert.equal(end('Wir haben drei neue Kunden gewonnen'), null);
  assert.equal(end('Danke'), null);
});
