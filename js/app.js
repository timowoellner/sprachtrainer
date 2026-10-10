import { AcousticDetector, ACOUSTIC_DEFAULTS } from './acoustic-detector.js';
import { startMicrophone, decodeFile } from './audio-input.js';
import { LiveTranscriber } from './speech.js';
import { Alerter } from './alerts.js';
import { tokenize, findFillers, findRepetitions, checkSentenceEnd } from './text-analysis.js';
import { SentenceJudge, describeError } from './claude-check.js';

// ---------------------------------------------------------------------------
// Kategorien und Einstellungen
// ---------------------------------------------------------------------------

const CATEGORIES = {
  aeh: { label: 'Äh', color: 'red' },
  stottern: { label: 'Stottern', color: 'red' },
  satz: { label: 'Satzende', color: 'amber' },
  fuellwort: { label: 'Füllwort', color: 'amber' },
};

const DEFAULT_SETTINGS = {
  lang: 'de-DE',
  useSpeech: true,
  alerts: {
    aeh: { lamp: true, beep: false, vibrate: false },
    stottern: { lamp: true, beep: false, vibrate: false },
    satz: { lamp: true, beep: false, vibrate: false },
    fuellwort: { lamp: true, beep: false, vibrate: false },
  },
  holdMs: 1500,
  fillerMinMs: ACOUSTIC_DEFAULTS.fillerMinMs,
  shapeTolDb: ACOUSTIC_DEFAULTS.shapeTolDb,
  speechMarginDb: ACOUSTIC_DEFAULTS.speechMarginDb,
  prolongMinMs: ACOUSTIC_DEFAULTS.prolongMinMs,
  repetitionAcoustic: true,
  extraFillers: '',
  record: false,
  claude: { enabled: false, apiKey: '', model: 'claude-opus-5-5' },
};

const STORAGE_KEY = 'redefluss-trainer-settings-v1';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...s,
      alerts: { ...structuredClone(DEFAULT_SETTINGS.alerts), ...s.alerts },
      claude: { ...DEFAULT_SETTINGS.claude, ...s.claude },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // privater Modus o. Ä. – Einstellungen gelten dann nur für diese Sitzung
  }
}

const settings = loadSettings();

function acousticOptions() {
  return {
    fillerMinMs: Number(settings.fillerMinMs),
    shapeTolDb: Number(settings.shapeTolDb),
    speechMarginDb: Number(settings.speechMarginDb),
    prolongMinMs: Number(settings.prolongMinMs),
    repMinCount: settings.repetitionAcoustic ? 3 : Infinity,
  };
}

function extraFillerList() {
  return settings.extraFillers
    .split(/[,;\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const els = {
  lamp: $('#lamp'),
  lampLabel: $('#lamp-label'),
  start: $('#btn-start'),
  stage: $('#btn-stage'),
  stageExit: $('#stage-exit'),
  status: $('#status'),
  meterFill: $('#meter-fill'),
  meterInfo: $('#meter-info'),
  transcript: $('#transcript'),
  interim: $('#interim'),
  log: $('#log'),
  logEmpty: $('#log-empty'),
  duration: $('#stat-duration'),
  rate: $('#stat-rate'),
  downloads: $('#downloads'),
  fileInput: $('#file-input'),
  fileResult: $('#file-result'),
  speechWarning: $('#speech-warning'),
};
const counterEls = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, $(`#count-${k}`)]));

const alerter = new Alerter(els.lamp, els.lampLabel);

// ---------------------------------------------------------------------------
// Sitzung
// ---------------------------------------------------------------------------

let session = null;

function newSession() {
  return {
    startPerf: performance.now(),
    events: [],
    counts: { aeh: 0, stottern: 0, satz: 0, fuellwort: 0 },
    finals: [],
    interim: new Map(),
    fired: new Map(), // Ergebnis-ID -> Set bereits gemeldeter Stellen
    lastAcoustic: { aeh: -Infinity, stottern: -Infinity },
    mic: null,
    detector: null,
    transcriber: null,
    recorder: null,
    chunks: [],
    judge: null,
    wakeLock: null,
    lastFrame: null,
    timer: null,
  };
}

function elapsedMs() {
  return session ? performance.now() - session.startPerf : 0;
}

function perMinute(count, minutes) {
  return (count / minutes).toFixed(1).replace('.', ',');
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Zentrale Stelle für jeden Befund: zählen, protokollieren, Lampe/Ton auslösen.
function report({ category, source, text, lampText = text, detail = '', atMs = elapsedMs(), silent = false }) {
  if (!session) return;
  const evt = { category, source, text, detail, atMs };
  session.events.push(evt);
  session.counts[category]++;
  counterEls[category].textContent = session.counts[category];
  appendLog(evt);
  if (silent) return;

  const cfg = settings.alerts[category];
  if (!cfg.lamp && !cfg.beep && !cfg.vibrate) return;
  const color = CATEGORIES[category].color;
  const beepMs = alerter.flash({
    color: cfg.lamp ? color : 'listening',
    text: lampText,
    holdMs: Number(settings.holdMs),
    beep: cfg.beep,
    vibrate: cfg.vibrate,
  });
  // Eigenen Piepton nicht als "Äh" erkennen
  if (beepMs && session.detector) session.detector.suppressUntil(session.detector.now() + beepMs + 300);
}

function appendLog(evt) {
  els.logEmpty.hidden = true;
  const li = document.createElement('li');
  li.className = `log-item cat-${evt.category}`;
  li.innerHTML = `<span class="log-time"></span><span class="log-cat"></span><span class="log-text"></span>`;
  li.querySelector('.log-time').textContent = fmtTime(evt.atMs);
  li.querySelector('.log-cat').textContent = CATEGORIES[evt.category].label;
  li.querySelector('.log-text').textContent = evt.detail ? `${evt.text} · ${evt.detail}` : evt.text;
  li.title = `Quelle: ${evt.source}`;
  els.log.prepend(li);
}

// --- akustische Befunde ------------------------------------------------------

function onAcousticEvent(e) {
  const at = e.t;
  if (e.type === 'filler') {
    session.lastAcoustic.aeh = elapsedMs();
    report({ category: 'aeh', source: 'akustik', text: 'Laut gehalten', lampText: 'Äh', detail: `≥ ${Math.round(e.durationMs)} ms`, atMs: at });
  } else if (e.type === 'prolongation') {
    session.lastAcoustic.stottern = elapsedMs();
    report({ category: 'stottern', source: 'akustik', text: 'Dehnung', lampText: 'Stottern – Dehnung', detail: `≥ ${Math.round(e.durationMs)} ms`, atMs: at });
  } else if (e.type === 'repetition') {
    session.lastAcoustic.stottern = elapsedMs();
    report({ category: 'stottern', source: 'akustik', text: 'Silbenwiederholung', lampText: 'Stottern – Wiederholung', detail: `${e.count}×`, atMs: at });
  }
}

// --- Transkript-Befunde ------------------------------------------------------

const MERGE_WINDOW_MS = 3000;

function analyzeText(id, text, isFinal) {
  const tokens = tokenize(text);
  const extra = extraFillerList();
  let fired = session.fired.get(id);
  if (!fired) session.fired.set(id, (fired = new Set()));
  const marks = new Map();

  for (const f of findFillers(tokens, extra)) {
    marks.set(f.index, f.kind === 'äh' ? 'aeh' : 'fuellwort');
    const key = `f${f.index}`;
    if (fired.has(key)) continue;
    fired.add(key);
    if (f.kind === 'äh') {
      // Dasselbe Äh hat die Akustik meist schon gemeldet – nicht doppelt zählen.
      if (elapsedMs() - session.lastAcoustic.aeh < MERGE_WINDOW_MS) continue;
      report({ category: 'aeh', source: 'transkript', text: `„${f.word}“` });
    } else {
      report({ category: 'fuellwort', source: 'transkript', text: `„${f.word}“` });
    }
  }

  for (const r of findRepetitions(tokens)) {
    for (let i = r.index; i <= r.endIndex; i++) marks.set(i, 'stottern');
    const key = `r${r.index}`;
    if (fired.has(key)) continue;
    fired.add(key);
    const silent = elapsedMs() - session.lastAcoustic.stottern < MERGE_WINDOW_MS;
    const label = r.kind === 'wort' ? 'Wortwiederholung' : 'Teilwort';
    if (!silent) report({ category: 'stottern', source: 'transkript', text: `${label}: „${r.word}“` });
  }

  let sentence = null;
  if (isFinal) {
    sentence = checkSentenceEnd(tokens, extra);
    if (sentence) report({ category: 'satz', source: 'regeln', text: sentence.message });
  }
  return { tokens, marks, sentence };
}

function renderUtterance(tokens, marks) {
  const p = document.createElement('p');
  tokens.forEach((t, i) => {
    const cat = marks.get(i);
    if (cat) {
      const m = document.createElement('mark');
      m.className = `cat-${cat}`;
      m.textContent = t.raw;
      p.append(m, ' ');
    } else {
      p.append(`${t.raw} `);
    }
  });
  return p;
}

function onInterim(id, text) {
  session.interim.set(id, text);
  analyzeText(id, text, false);
  els.interim.textContent = [...session.interim.values()].join(' ');
}

function onFinal(id, text) {
  session.interim.delete(id);
  els.interim.textContent = [...session.interim.values()].join(' ');
  if (!text) return;
  const { tokens, marks, sentence } = analyzeText(id, text, true);
  session.fired.delete(id);
  const p = renderUtterance(tokens, marks);
  if (sentence) p.classList.add('flag-satz');
  els.transcript.append(p);
  els.transcript.scrollTop = els.transcript.scrollHeight;

  const context = session.finals.slice(-3).join('\n');
  session.finals.push(text);

  if (session.judge && !sentence && tokens.length >= 4) {
    session.judge.submit(
      context,
      text,
      (v) => {
        if (!session || v.ok || v.problem === 'keins') return;
        p.classList.add('flag-satz');
        report({ category: 'satz', source: 'claude', text: v.hinweis || 'Satzende prüfen', detail: `„…${text.split(' ').slice(-4).join(' ')}“` });
      },
      async (err) => setStatus(`KI-Prüfung: ${await describeError(err)}`, 'warn'),
    );
  }
}

// ---------------------------------------------------------------------------
// Start / Stopp
// ---------------------------------------------------------------------------

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

async function start() {
  alerter.unlock();
  session = newSession();
  resetView();
  els.start.disabled = true;
  setStatus('Mikrofon wird gestartet …');

  try {
    session.mic = await startMicrophone((chunk) => session?.detector?.push(chunk));
  } catch (err) {
    setStatus(`Kein Mikrofonzugriff: ${err.message}`, 'error');
    session = null;
    els.start.disabled = false;
    return;
  }

  session.detector = new AcousticDetector(session.mic.sampleRate, acousticOptions(), {
    onEvent: onAcousticEvent,
    onFrame: (f) => {
      if (session) session.lastFrame = f;
    },
  });
  // Erste 1,5 s dienen zum Einmessen des Raumgeräuschs.
  session.detector.suppressUntil(1500);
  session.startPerf = performance.now();

  if (settings.useSpeech && LiveTranscriber.supported) {
    session.transcriber = new LiveTranscriber({
      lang: settings.lang,
      onInterim,
      onFinal,
      onError: (e) => setStatus(`Spracherkennung: ${e}`, 'warn'),
    });
    try {
      session.transcriber.start();
    } catch (err) {
      setStatus(`Spracherkennung nicht verfügbar: ${err.message}`, 'warn');
    }
  }

  if (settings.claude.enabled && settings.claude.apiKey) {
    session.judge = new SentenceJudge({ apiKey: settings.claude.apiKey, model: settings.claude.model });
  }

  if (settings.record && typeof MediaRecorder !== 'undefined') {
    session.recorder = new MediaRecorder(session.mic.stream);
    session.recorder.ondataavailable = (e) => e.data.size && session.chunks.push(e.data);
    session.recorder.start(1000);
  }

  try {
    session.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Bildschirm darf dann ausgehen – kein Problem für die Analyse
  }

  alerter.setState('idle', 'Einmessen – kurz still sein …');
  setTimeout(() => session && alerter.setListening(), 1500);
  setStatus('Läuft');
  els.start.textContent = 'Stopp';
  els.start.disabled = false;
  els.start.classList.add('running');
  session.timer = setInterval(updateStats, 1000);
  requestAnimationFrame(drawMeter);
}

async function stop() {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.timer);
  s.transcriber?.stop();
  try {
    s.wakeLock?.release();
  } catch {
    // ignorieren
  }

  const durationMs = performance.now() - s.startPerf;
  let recordingUrl = null;
  if (s.recorder) {
    await new Promise((resolve) => {
      s.recorder.onstop = resolve;
      s.recorder.stop();
    });
    recordingUrl = URL.createObjectURL(new Blob(s.chunks, { type: s.recorder.mimeType || 'audio/webm' }));
  }
  await s.mic.stop();

  alerter.setIdle('Beendet');
  els.start.textContent = 'Start';
  els.start.classList.remove('running');
  els.interim.textContent = '';
  setStatus(summaryText(s, durationMs));
  offerDownloads(s, durationMs, recordingUrl);
}

function summaryText(s, durationMs) {
  const min = Math.max(durationMs / 60000, 1 / 60);
  const c = s.counts;
  return `Fertig nach ${fmtTime(durationMs)}: ${c.aeh}× Äh (${perMinute(c.aeh, min)}/min), ${c.stottern}× Stottern, ${c.satz}× Satzende, ${c.fuellwort}× Füllwort`;
}

function offerDownloads(s, durationMs, recordingUrl) {
  els.downloads.replaceChildren();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const csv = [
    'Zeit;Kategorie;Quelle;Befund;Details',
    ...s.events.map((e) =>
      [fmtTime(e.atMs), CATEGORIES[e.category].label, e.source, e.text, e.detail].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(';'),
    ),
  ].join('\n');
  addDownload(new Blob(['﻿' + csv], { type: 'text/csv' }), `redefluss-${stamp}.csv`, 'Protokoll (CSV)');
  if (s.finals.length) {
    const txt = `${summaryText(s, durationMs)}\n\n${s.finals.join('\n')}\n`;
    addDownload(new Blob([txt], { type: 'text/plain' }), `transkript-${stamp}.txt`, 'Transkript (TXT)');
  }
  if (recordingUrl) addDownload(recordingUrl, `aufnahme-${stamp}.webm`, 'Aufnahme (WebM)');
}

function addDownload(blobOrUrl, filename, label) {
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = filename;
  a.textContent = label;
  a.className = 'btn btn-small';
  els.downloads.append(a);
}

function resetView() {
  els.transcript.replaceChildren();
  els.interim.textContent = '';
  els.log.replaceChildren();
  els.logEmpty.hidden = false;
  els.downloads.replaceChildren();
  for (const k of Object.keys(counterEls)) counterEls[k].textContent = '0';
  els.duration.textContent = '00:00';
  els.rate.textContent = '0,0';
}

function updateStats() {
  if (!session) return;
  const ms = elapsedMs();
  els.duration.textContent = fmtTime(ms);
  els.rate.textContent = perMinute(session.counts.aeh, Math.max(ms / 60000, 1 / 60));
}

function drawMeter() {
  if (!session) {
    els.meterFill.style.width = '0%';
    els.meterInfo.textContent = '';
    return;
  }
  const f = session.lastFrame;
  if (f) {
    const above = Math.max(0, Math.min(1, (f.db - f.noiseFloor) / 45));
    els.meterFill.style.width = `${(above * 100).toFixed(0)}%`;
    els.meterFill.dataset.speech = f.speech ? 'yes' : 'no';
    els.meterInfo.textContent = f.voiced ? `stimmhaft · ${Math.round(f.f0)} Hz` : f.speech ? 'Sprache' : 'Stille';
  }
  requestAnimationFrame(drawMeter);
}

// ---------------------------------------------------------------------------
// Datei-Analyse (Probe-Aufnahme nachträglich auswerten)
// ---------------------------------------------------------------------------

async function analyzeFile(file) {
  els.fileResult.replaceChildren();
  const info = document.createElement('p');
  info.textContent = `Analysiere „${file.name}“ …`;
  els.fileResult.append(info);
  let decoded;
  try {
    decoded = await decodeFile(file);
  } catch (err) {
    info.textContent = `Datei konnte nicht gelesen werden: ${err.message}`;
    return;
  }
  const events = [];
  const det = new AcousticDetector(decoded.sampleRate, acousticOptions(), { onEvent: (e) => events.push(e) });
  det.suppressUntil(500);
  const step = 4096;
  for (let i = 0; i < decoded.samples.length; i += step) {
    det.push(decoded.samples.subarray(i, i + step));
    if (i % (step * 200) === 0) await new Promise((r) => setTimeout(r)); // UI nicht blockieren
  }

  const minutes = decoded.samples.length / decoded.sampleRate / 60;
  const fillers = events.filter((e) => e.type === 'filler').length;
  const stutter = events.length - fillers;
  info.textContent = `${fmtTime(minutes * 60000)} analysiert: ${fillers}× Äh (${perMinute(fillers, Math.max(minutes, 1 / 60))}/min), ${stutter}× Stotter-Verdacht. Klick auf einen Eintrag springt zur Stelle.`;

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = URL.createObjectURL(file);
  els.fileResult.append(audio);

  const list = document.createElement('ul');
  list.className = 'log';
  const names = { filler: ['aeh', 'Äh'], prolongation: ['stottern', 'Dehnung'], repetition: ['stottern', 'Silbenwiederholung'] };
  for (const e of events) {
    const [cat, label] = names[e.type];
    const li = document.createElement('li');
    li.className = `log-item cat-${cat} clickable`;
    li.innerHTML = `<span class="log-time"></span><span class="log-cat"></span><span class="log-text"></span>`;
    li.querySelector('.log-time').textContent = fmtTime(e.t);
    li.querySelector('.log-cat').textContent = CATEGORIES[cat].label;
    li.querySelector('.log-text').textContent = e.type === 'repetition' ? label : `${label} · ≥ ${Math.round(e.durationMs)} ms`;
    li.addEventListener('click', () => {
      audio.currentTime = Math.max(0, e.t / 1000 - 1);
      audio.play();
    });
    list.append(li);
  }
  els.fileResult.append(list);
}

// ---------------------------------------------------------------------------
// Einstellungen binden
// ---------------------------------------------------------------------------

function bindSettings() {
  for (const input of document.querySelectorAll('[data-setting]')) {
    const path = input.dataset.setting.split('.');
    const get = () => path.reduce((o, k) => o[k], settings);
    const set = (v) => {
      const last = path[path.length - 1];
      path.slice(0, -1).reduce((o, k) => o[k], settings)[last] = v;
    };
    const out = document.querySelector(`[data-output="${input.dataset.setting}"]`);
    const show = () => out && (out.textContent = input.value);

    if (input.type === 'checkbox') input.checked = Boolean(get());
    else input.value = get();
    show();

    input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
      set(input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value);
      show();
      saveSettings();
      session?.detector?.setOptions(acousticOptions());
    });
  }
  $('#btn-reset').addEventListener('click', () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignorieren
    }
    location.reload();
  });
  $('#btn-test-beep').addEventListener('click', () => {
    alerter.unlock();
    alerter.flash({ color: 'red', text: 'Test: so sieht ein Alarm aus', beep: true, vibrate: true });
  });
}

// ---------------------------------------------------------------------------
// Bühnenmodus: ganzer Bildschirm wird zur Lampe
// ---------------------------------------------------------------------------

function enterStage() {
  document.body.classList.add('stage');
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function exitStage() {
  document.body.classList.remove('stage');
  if (document.fullscreenElement) document.exitFullscreen?.();
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('stage');
});

// ---------------------------------------------------------------------------

els.start.addEventListener('click', () => (session ? stop() : start()));
els.stage.addEventListener('click', enterStage);
els.stageExit.addEventListener('click', exitStage);
els.fileInput.addEventListener('change', () => els.fileInput.files[0] && analyzeFile(els.fileInput.files[0]));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    session ? stop() : start();
  } else if (e.key === 'Escape') exitStage();
});

bindSettings();
if (!LiveTranscriber.supported) els.speechWarning.hidden = false;
alerter.setIdle('Bereit – Start drücken');
