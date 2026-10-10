// Rückmeldung an den Vortragenden: Lampe, Piepton, Vibration.

const TONES = { red: 880, amber: 520 };

export class Alerter {
  constructor(lampEl, labelEl) {
    this.lamp = lampEl;
    this.label = labelEl;
    this.ctx = null;
    this.timer = null;
    this.lastBeep = 0;
  }

  // Muss aus einer Nutzeraktion heraus aufgerufen werden (Autoplay-Regeln der Browser).
  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setIdle(text = 'Bereit') {
    this.setState('idle', text);
  }

  setListening(text = 'Läuft – alles im grünen Bereich') {
    this.setState('listening', text);
  }

  setState(state, text) {
    clearTimeout(this.timer);
    document.body.dataset.lamp = state;
    this.lamp.dataset.state = state;
    if (text !== undefined) this.label.textContent = text;
  }

  // color: 'red' | 'amber'. Gibt die Dauer des Tons in ms zurück (0 = kein Ton).
  flash({ color, text, holdMs = 1500, beep = false, vibrate = false }) {
    this.setState(color, text);
    this.timer = setTimeout(() => this.setListening(), holdMs);
    if (vibrate && navigator.vibrate) navigator.vibrate(color === 'red' ? [120] : [60, 60, 60]);
    return beep ? this.beep(TONES[color] || 700) : 0;
  }

  beep(freq, ms = 120) {
    if (!this.ctx) return 0;
    const now = performance.now();
    if (now - this.lastBeep < 400) return 0;
    this.lastBeep = now;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
    gain.gain.linearRampToValueAtTime(0, t + ms / 1000);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
    return ms;
  }
}
