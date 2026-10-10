// Live-Transkription über die Web Speech API (Chrome, Edge, Safari).
// Hinweis: In Chrome/Edge wird das Audio dafür an den Spracherkennungsdienst des
// Browserherstellers gesendet. Die akustische Erkennung funktioniert auch ohne.

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export class LiveTranscriber {
  static get supported() {
    return Boolean(Recognition);
  }

  constructor({ lang = 'de-DE', onInterim, onFinal, onError, onState } = {}) {
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onError = onError || (() => {});
    this.onState = onState || (() => {});
    this.running = false;
    this.rec = null;
    this.segment = 0;
  }

  start() {
    if (!Recognition) throw new Error('Spracherkennung wird von diesem Browser nicht unterstützt');
    this.running = true;
    this.open();
  }

  open() {
    const rec = new Recognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Jede Sitzung bekommt eigene Segmentnummern, damit Ergebnisse eindeutig bleiben.
    const session = ++this.segment;

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const id = `${session}-${i}`;
        const text = r[0].transcript.trim();
        if (r.isFinal) this.onFinal(id, text);
        else this.onInterim(id, text);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.running = false;
      this.onError(e.error);
    };
    rec.onend = () => {
      // Chrome beendet die Erkennung nach Pausen oder ~1 Minute – einfach neu starten.
      if (this.running) setTimeout(() => this.running && this.open(), 150);
      else this.onState('stopped');
    };
    rec.start();
    this.rec = rec;
    this.onState('running');
  }

  stop() {
    this.running = false;
    if (this.rec) this.rec.stop();
  }
}
