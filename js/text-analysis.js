// Auswertung des Live-Transkripts (Spracherkennung des Browsers).
// Erkennt: Äh-Laute im Text, Wort- und Teilwortwiederholungen sowie
// Satzenden, die grammatisch offen bleiben (deutsche Verbklammer).

const FILLER_RE = /^(ä+h*m*|ö+h*m*|e+h+m*|e+m+|h+m+|m+h+m*|äh+m*|öh+m*|eh+m*)$/;

// Wörter, die im Deutschen legitim doppelt vorkommen ("Leute, die die Regeln kennen").
// Bei ihnen schlagen wir erst bei dreifacher Wiederholung an.
const LEGIT_DOUBLES = new Set(['die', 'der', 'das', 'den', 'dem', 'des', 'sie', 'was', 'wer', 'ist', 'hat', 'ja', 'nein', 'sehr', 'so']);

// Kurze Wörter, die zufällig Anfang des nächsten Wortes sein können ("in Indien").
const SHORT_WORDS = new Set([
  'ab', 'am', 'an', 'als', 'auf', 'aus', 'bei', 'bis', 'da', 'das', 'dem', 'den', 'der', 'des', 'die', 'du',
  'ein', 'er', 'es', 'für', 'im', 'in', 'ich', 'ist', 'ja', 'man', 'mit', 'nach', 'nie', 'nur', 'ob', 'oder',
  'so', 'um', 'und', 'uns', 'von', 'vor', 'was', 'wer', 'wie', 'wir', 'zu', 'zum', 'zur', 'nun', 'gut', 'mal',
  'sie', 'hat', 'hin', 'her', 'wo', 'wen', 'wem', 'sei', 'tun', 'mir', 'dir', 'ihm', 'ihr', 'all', 'neu',
]);

// Wörter, mit denen ein Satz nicht enden kann (Artikel, Konjunktionen, Präpositionen
// ohne Verbpartikel-Funktion, Possessiva). Partikel wie "an", "auf", "mit", "zu" fehlen
// bewusst – "Ich rufe dich an" ist ein korrektes Satzende.
const DANGLING = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'kein', 'keine', 'keinen', 'keinem', 'keiner',
  'und', 'oder', 'aber', 'denn', 'sondern', 'sowie', 'beziehungsweise', 'bzw',
  'dass', 'weil', 'wenn', 'ob', 'obwohl', 'damit', 'nachdem', 'bevor', 'sodass', 'falls', 'indem',
  'für', 'von', 'im', 'am', 'zum', 'zur', 'vom', 'beim', 'ins', 'ans', 'aufs',
  'gegen', 'ohne', 'unter', 'zwischen', 'wegen', 'trotz', 'während', 'seit', 'bezüglich', 'hinsichtlich',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'dein', 'deine', 'unser', 'unsere', 'unseren', 'unserem', 'unserer',
  'euer', 'eure', 'ihre', 'ihren', 'ihrem', 'ihrer', 'sein', 'seine', 'seinen', 'seinem', 'seiner',
  'dieser', 'diese', 'dieses', 'diesen', 'diesem', 'jeder', 'jede', 'jedes', 'jeden', 'jedem',
  'sehr', 'besonders', 'ziemlich', 'ganz', 'eher',
]);

const SUBORDINATORS = new Set([
  'dass', 'weil', 'wenn', 'ob', 'obwohl', 'damit', 'nachdem', 'bevor', 'sodass', 'falls', 'indem', 'sobald', 'solange', 'bis', 'seitdem',
]);

// Modal- und Hilfsverben, die einen Infinitiv am Satzende verlangen.
const BRACKET_OPENERS = new Set([
  'kann', 'kannst', 'können', 'könnt', 'konnte', 'konnten', 'könnte', 'könnten',
  'muss', 'musst', 'müssen', 'müsst', 'musste', 'mussten', 'müsste', 'müssten',
  'soll', 'sollst', 'sollen', 'sollt', 'sollte', 'sollten',
  'will', 'willst', 'wollen', 'wollt', 'wollte', 'wollten',
  'darf', 'darfst', 'dürfen', 'dürft', 'durfte', 'durften', 'dürfte', 'dürften',
  'möchte', 'möchtest', 'möchten', 'möchtet',
  'werde', 'wirst', 'werden', 'werdet', 'würde', 'würdest', 'würden', 'würdet',
]);

const IRREGULAR_VERBS = new Set([
  'ist', 'sind', 'bin', 'bist', 'seid', 'war', 'waren', 'warst', 'sei', 'wäre', 'wären',
  'hat', 'hast', 'habe', 'haben', 'habt', 'hatte', 'hatten', 'hätte', 'hätten',
  'wird', 'wurde', 'wurden', 'worden', 'geworden', 'gewesen',
  'kann', 'muss', 'soll', 'will', 'darf', 'mag', 'weiß', 'gibt', 'gab', 'geht', 'ging', 'tut', 'tat',
  'kam', 'kommt', 'sah', 'sieht', 'nahm', 'nimmt', 'gilt', 'galt', 'lief', 'liegt', 'lag', 'hält', 'hielt',
  'bleibt', 'blieb', 'fand', 'findet', 'stand', 'steht', 'sitzt', 'saß', 'trifft', 'traf', 'spricht', 'sprach',
  'gesehen', 'gemacht', 'gesagt', 'gegangen', 'gekommen', 'getan', 'gefunden', 'gelesen', 'geschrieben',
  'sein', 'tun', 'lassen', 'lässt', 'ließ',
]);

export function normalizeWord(raw) {
  return raw
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export function tokenize(text) {
  return text
    .split(/\s+/)
    .map((raw) => {
      const clean = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, '');
      return { raw, clean, norm: normalizeWord(raw), cap: /^\p{Lu}/u.test(clean) };
    })
    .filter((t) => t.norm.length > 0);
}

export function isFiller(norm, extraFillers = []) {
  return FILLER_RE.test(norm) || extraFillers.includes(norm);
}

export function findFillers(tokens, extraFillers = []) {
  const out = [];
  tokens.forEach((t, index) => {
    if (FILLER_RE.test(t.norm)) out.push({ index, word: t.clean, kind: 'äh' });
    else if (extraFillers.includes(t.norm)) out.push({ index, word: t.clean, kind: 'füllwort' });
  });
  return out;
}

export function findRepetitions(tokens) {
  const out = [];
  // Füllwörter herausnehmen, damit "ich äh ich" als Wiederholung zählt.
  const words = tokens.map((t, index) => ({ ...t, index })).filter((t) => !FILLER_RE.test(t.norm));
  let i = 0;
  while (i < words.length - 1) {
    const w = words[i];
    let j = i + 1;
    while (j < words.length && words[j].norm === w.norm) j++;
    const count = j - i;
    const needed = LEGIT_DOUBLES.has(w.norm) ? 3 : 2;
    if (count >= needed) {
      out.push({ index: w.index, endIndex: words[j - 1].index, word: w.clean, count, kind: 'wort' });
      i = j;
      continue;
    }
    // Teilwort: "Pro- Projekt", "W wichtig", "Ver Verantwortung"
    const next = words[i + 1];
    const stem = w.norm.replace(/-+$/, '');
    if (
      stem.length >= 1 &&
      stem.length <= 4 &&
      !SHORT_WORDS.has(stem) &&
      next.norm.length >= stem.length + 2 &&
      next.norm.startsWith(stem)
    ) {
      out.push({ index: w.index, endIndex: next.index, word: `${w.clean}… ${next.clean}`, count: 2, kind: 'teilwort' });
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

export function looksLikeVerb(token) {
  const w = token.norm;
  if (IRREGULAR_VERBS.has(w) || BRACKET_OPENERS.has(w)) return true;
  // Die Spracherkennung schreibt Substantive groß – großgeschriebene Wörter sind keine Verben.
  if (token.cap) return false;
  if (DANGLING.has(w)) return false;
  return /(en|ern|eln|n|t|te|ten|tet|st|est|et)$/.test(w);
}

// Prüft eine abgeschlossene Äußerung (Spracherkennung liefert "final" nach einer Pause).
// Gibt null zurück, wenn alles plausibel ist, sonst { kind, message }.
export function checkSentenceEnd(tokens, extraFillers = []) {
  const words = tokens.filter((t) => !isFiller(t.norm, extraFillers));
  if (words.length < 3) return null;

  const last = words[words.length - 1];
  if (DANGLING.has(last.norm)) {
    return { kind: 'abgebrochen', message: `Satz bricht nach „${last.clean}“ ab` };
  }

  // Nebensatz (nicht am Satzanfang) muss mit einem Verb enden: "…, dass wir das Projekt [umsetzen]"
  for (let i = words.length - 2; i >= 1; i--) {
    if (SUBORDINATORS.has(words[i].norm)) {
      if (words.length - i >= 3 && !looksLikeVerb(last)) {
        return { kind: 'verb_fehlt', message: `Nebensatz mit „${words[i].clean}“ endet ohne Verb` };
      }
      return null;
    }
  }

  // Verbklammer: "Ich will heute über unser Projekt [sprechen]"
  for (let i = 0; i <= Math.min(3, words.length - 3); i++) {
    if (BRACKET_OPENERS.has(words[i].norm)) {
      if (last.cap && !looksLikeVerb(last)) {
        return { kind: 'verb_fehlt', message: `Nach „${words[i].clean}“ fehlt das Verb am Satzende` };
      }
      break;
    }
  }
  return null;
}
