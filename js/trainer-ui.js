// Oberfläche des Trainingsmodus: Laut 10× vorsprechen, benennen, speichern, testen.

import { AcousticDetector } from './acoustic-detector.js';
import { startMicrophone } from './audio-input.js';
import { SampleCollector, Spotter, buildTemplate, loadTemplates, saveTemplates } from './sound-templates.js';

const TARGET_SAMPLES = 10;
const NEGATIVE_SECONDS = 15;

const CATEGORY_LABELS = { aeh: 'Äh-Laut', fuellwort: 'Füllwort' };
const COLOR_LABELS = { red: 'rot', amber: 'gelb' };

export class TrainerUI {
  constructor(root, { isLiveRunning, onTemplatesChanged, setStatus }) {
    this.root = root;
    this.isLiveRunning = isLiveRunning;
    this.onTemplatesChanged = onTemplatesChanged;
    this.setStatus = setStatus;
    this.templates = loadTemplates();
    this.mic = null;
    this.mode = null; // 'record' | 'negative' | 'test'
    this.samples = [];
    this.negatives = null;

    this.el = (sel) => root.querySelector(sel);
    this.el('#tr-record').addEventListener('click', () => this.toggleRecord());
    this.el('#tr-negative').addEventListener('click', () => this.recordNegatives());
    this.el('#tr-save').addEventListener('click', () => this.save());
    this.el('#tr-discard').addEventListener('click', () => this.discard());
    this.el('#tr-test').addEventListener('click', () => this.toggleTest());
    this.renderDraft();
    this.renderList();
  }

  get busy() {
    return Boolean(this.mic);
  }

  // --- Mikrofon --------------------------------------------------------------

  async openMic(onFrame) {
    if (this.isLiveRunning()) {
      this.setHint('Bitte zuerst die Live-Analyse stoppen.');
      return false;
    }
    let det = null;
    try {
      this.mic = await startMicrophone((chunk) => det?.push(chunk));
    } catch (err) {
      this.setHint(`Kein Mikrofonzugriff: ${err.message}`);
      this.mic = null;
      return false;
    }
    det = new AcousticDetector(this.mic.sampleRate, {}, { onRawFrame: (frame, f) => onFrame(frame, f, det) });
    det.suppressUntil(800); // kurz Raumgeräusch einmessen
    this.detector = det;
    return true;
  }

  async closeMic() {
    const mic = this.mic;
    this.mic = null;
    this.mode = null;
    this.detector = null;
    if (mic) await mic.stop();
  }

  // --- Schritt 1: Beispiele aufnehmen ---------------------------------------

  async toggleRecord() {
    if (this.mode === 'record') return this.stopRecord();
    if (this.mode) return;
    let collector = null;
    const ok = await this.openMic((frame, f, det) => {
      collector ||= new SampleCollector(this.mic.sampleRate, det.frameLength, 10, (s) => this.addSample(s));
      collector.push(frame, f);
    });
    if (!ok) return;
    this.mode = 'record';
    this.setHint('Jetzt den Laut sagen, kurz Pause, wieder sagen … Jede Wiederholung erscheint unten.');
    this.renderDraft();
  }

  addSample(sample) {
    this.samples.push(sample);
    this.renderDraft();
    if (this.samples.length >= TARGET_SAMPLES) this.stopRecord();
  }

  async stopRecord() {
    await this.closeMic();
    this.setHint(
      this.samples.length >= 3
        ? 'Gut. Optional die Gegenprobe machen, dann einen Namen eintragen und speichern.'
        : 'Mindestens 3 Wiederholungen nötig – einfach noch einmal aufnehmen.',
    );
    this.renderDraft();
  }

  // --- Schritt 2 (optional): Gegenprobe mit normaler Sprache -----------------

  async recordNegatives() {
    if (this.mode) return;
    let collector = null;
    const ok = await this.openMic((frame, f, det) => {
      if (!collector) {
        collector = new SampleCollector(this.mic.sampleRate, det.frameLength, 10, () => {});
        collector.collectAll = true;
        this.negCollector = collector;
      }
      collector.push(frame, f);
    });
    if (!ok) return;
    this.mode = 'negative';
    this.renderDraft();
    let left = NEGATIVE_SECONDS;
    this.setHint(`Jetzt ${left} Sekunden ganz normal sprechen – ohne den Laut.`);
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        left--;
        this.setHint(`Jetzt ${left} Sekunden ganz normal sprechen – ohne den Laut.`);
        if (left <= 0 || this.mode !== 'negative') {
          clearInterval(timer);
          resolve();
        }
      }, 1000);
    });
    this.negatives = this.negCollector?.all || null;
    await this.closeMic();
    this.setHint('Gegenprobe gespeichert. Jetzt Namen eintragen und speichern.');
    this.renderDraft();
  }

  // --- Schritt 3: benennen und speichern -------------------------------------

  save() {
    const name = this.el('#tr-name').value.trim();
    if (!name) {
      this.setHint('Bitte einen Namen eintragen, z. B. „ehm“, „quasi“ oder „jetzt“.');
      this.el('#tr-name').focus();
      return;
    }
    if (this.samples.length < 3) return;
    let template;
    try {
      template = buildTemplate({
        name,
        category: this.el('#tr-category').value,
        color: this.el('#tr-color').value,
        samples: this.samples,
        negatives: this.negatives,
      });
    } catch (err) {
      this.setHint(`Konnte nicht gespeichert werden: ${err.message}`);
      return;
    }
    this.templates.push(template);
    this.persist();
    this.samples = [];
    this.negatives = null;
    this.el('#tr-name').value = '';
    const warn = template.stats.distinct === false ? ' Achtung: Der Laut klingt ähnlich wie deine normale Sprache – evtl. Fehlalarme.' : '';
    this.setHint(`„${name}“ angelernt. Mit „Testen“ ausprobieren.${warn}`);
    this.renderDraft();
    this.renderList();
  }

  discard() {
    this.samples = [];
    this.negatives = null;
    this.setHint('');
    this.renderDraft();
  }

  persist() {
    if (!saveTemplates(this.templates)) this.setHint('Speichern im Browser nicht möglich (privater Modus?). Gilt nur bis zum Neuladen.');
    this.onTemplatesChanged(this.templates);
  }

  // --- Testen: nur angelernte Laute erkennen, nichts zählen ------------------

  async toggleTest() {
    if (this.mode === 'test') {
      await this.closeMic();
      this.setHint('');
      this.renderDraft();
      return;
    }
    if (this.mode || !this.templates.length) return;
    let spotter = null;
    const ok = await this.openMic((frame, f, det) => {
      spotter ||= new Spotter(this.mic.sampleRate, det.frameLength, 10, this.templates, (h) => this.showTestHit(h));
      spotter.push(frame, f);
    });
    if (!ok) return;
    this.mode = 'test';
    this.setHint('Test läuft: sprich normal und bau deine Laute ein. Treffer erscheinen hier.');
    this.el('#tr-test-hits').replaceChildren();
    this.renderDraft();
  }

  showTestHit(h) {
    const li = document.createElement('li');
    li.className = `log-item cat-${h.template.color === 'red' ? 'aeh' : 'fuellwort'}`;
    li.innerHTML = '<span class="log-time"></span><span class="log-cat"></span><span class="log-text"></span>';
    li.querySelector('.log-time').textContent = '✓';
    li.querySelector('.log-cat').textContent = h.template.name;
    const limit = h.template.threshold * (h.template.sensitivity || 1);
    li.querySelector('.log-text').textContent = `${Math.round(h.durationMs)} ms · Abstand ${fmt(h.score)} (Grenze ${fmt(limit)})`;
    this.el('#tr-test-hits').prepend(li);
  }

  // --- Darstellung -------------------------------------------------------------

  setHint(text) {
    this.el('#tr-hint').textContent = text;
  }

  renderDraft() {
    const n = this.samples.length;
    this.el('#tr-count').textContent = `${n} / ${TARGET_SAMPLES}`;
    this.el('#tr-progress').style.width = `${Math.min(100, (n / TARGET_SAMPLES) * 100)}%`;
    this.root.dataset.mode = this.mode || '';

    const rec = this.el('#tr-record');
    rec.textContent = this.mode === 'record' ? 'Aufnahme beenden' : n ? 'Weitere Wiederholungen aufnehmen' : 'Aufnahme starten';
    rec.disabled = Boolean(this.mode && this.mode !== 'record');
    rec.classList.toggle('running', this.mode === 'record');

    const neg = this.el('#tr-negative');
    neg.disabled = Boolean(this.mode) || n < 3;
    neg.textContent = this.mode === 'negative' ? 'Gegenprobe läuft …' : this.negatives ? 'Gegenprobe ✓ (wiederholen)' : `Gegenprobe: ${NEGATIVE_SECONDS} s normal sprechen`;

    this.el('#tr-save').disabled = Boolean(this.mode) || n < 3;
    this.el('#tr-discard').hidden = n === 0 || Boolean(this.mode);

    const test = this.el('#tr-test');
    test.textContent = this.mode === 'test' ? 'Test beenden' : 'Testen';
    test.disabled = !this.templates.length || Boolean(this.mode && this.mode !== 'test');
    test.classList.toggle('running', this.mode === 'test');

    const list = this.el('#tr-samples');
    list.replaceChildren();
    this.samples.forEach((s, i) => {
      const chip = document.createElement('li');
      chip.className = 'chip';
      chip.innerHTML = '<span></span><button type="button" class="chip-x" aria-label="Beispiel entfernen">×</button>';
      chip.querySelector('span').textContent = `${i + 1}: ${s.durationMs} ms${s.f0 ? ` · ${Math.round(s.f0)} Hz` : ''}`;
      chip.querySelector('button').addEventListener('click', () => {
        this.samples.splice(i, 1);
        this.renderDraft();
      });
      list.append(chip);
    });
  }

  renderList() {
    const list = this.el('#tr-list');
    list.replaceChildren();
    this.el('#tr-empty').hidden = this.templates.length > 0;
    for (const t of this.templates) list.append(this.renderTemplate(t));
    this.renderDraft();
  }

  renderTemplate(t) {
    const s = t.stats;
    const card = document.createElement('article');
    card.className = `sound cat-${t.color === 'red' ? 'aeh' : 'fuellwort'}`;
    card.innerHTML = `
      <header class="sound-head">
        <input class="sound-name" type="text" aria-label="Name">
        <span class="sound-tag"></span>
      </header>
      <dl class="sound-data"></dl>
      <label class="range">
        <span>Empfindlichkeit <output></output></span>
        <input type="range" min="0.6" max="1.4" step="0.05">
        <small>Links = strenger (weniger Fehlalarme), rechts = lockerer (verpasst weniger).</small>
      </label>
      <div class="sound-actions">
        <select aria-label="Kategorie"><option value="fuellwort">Füllwort</option><option value="aeh">Äh-Laut</option></select>
        <select aria-label="Lampenfarbe"><option value="red">rote Lampe</option><option value="amber">gelbe Lampe</option></select>
        <button type="button" class="btn btn-small sound-delete">Löschen</button>
      </div>`;

    const name = card.querySelector('.sound-name');
    name.value = t.name;
    name.addEventListener('change', () => {
      t.name = name.value.trim() || t.name;
      name.value = t.name;
      this.persist();
    });
    card.querySelector('.sound-tag').textContent = `${CATEGORY_LABELS[t.category]} · ${COLOR_LABELS[t.color]}`;

    const rows = [
      ['Beispiele', `${s.count}`],
      ['Dauer', `Ø ${s.durationMs} ms ± ${s.durationSdMs}`],
      ['Tonhöhe', s.f0 ? `Ø ${s.f0} Hz ± ${fmt(s.f0SdSt)} Halbtöne` : 'stimmlos'],
      ['Gleichmäßigkeit', `${fmt(s.consistencyDb)} dB (kleiner = gleichmäßiger)`],
      ['Abstand zur Rede', s.negativeMinDb === null ? 'keine Gegenprobe' : `${fmt(s.negativeMinDb)} dB${s.distinct === false ? ' – zu ähnlich!' : ''}`],
      ['Erkennungsgrenze', `${fmt(t.threshold)} dB`],
      ['Angelernt', new Date(s.createdAt).toLocaleDateString('de-DE')],
    ];
    const dl = card.querySelector('.sound-data');
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }

    const range = card.querySelector('input[type="range"]');
    const out = card.querySelector('output');
    range.value = t.sensitivity || 1;
    out.textContent = fmt(Number(range.value));
    range.addEventListener('input', () => (out.textContent = fmt(Number(range.value))));
    range.addEventListener('change', () => {
      t.sensitivity = Number(range.value);
      this.persist();
    });

    const [catSel, colorSel] = card.querySelectorAll('select');
    catSel.value = t.category;
    colorSel.value = t.color;
    const updateTag = () => {
      t.category = catSel.value;
      t.color = colorSel.value;
      card.className = `sound cat-${t.color === 'red' ? 'aeh' : 'fuellwort'}`;
      card.querySelector('.sound-tag').textContent = `${CATEGORY_LABELS[t.category]} · ${COLOR_LABELS[t.color]}`;
      this.persist();
    };
    catSel.addEventListener('change', updateTag);
    colorSel.addEventListener('change', updateTag);

    // Löschen mit Bestätigung im Button selbst
    const del = card.querySelector('.sound-delete');
    del.addEventListener('click', () => {
      if (del.dataset.confirm) {
        this.templates = this.templates.filter((x) => x !== t);
        this.persist();
        this.renderList();
      } else {
        del.dataset.confirm = '1';
        del.textContent = 'Wirklich löschen?';
        setTimeout(() => {
          delete del.dataset.confirm;
          del.textContent = 'Löschen';
        }, 3000);
      }
    });
    return card;
  }
}

function fmt(x) {
  return Number(x).toFixed(2).replace('.', ',');
}
