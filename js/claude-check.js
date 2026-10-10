// Optionale KI-Prüfung der Satzenden mit Claude.
// Erkennt, was Regeln nicht können: ein Satz endet mit einem Verb, das inhaltlich
// oder grammatisch nicht passt ("Wir haben die Kosten deutlich gegangen").
//
// Der API-Schlüssel bleibt im Browser (localStorage) und geht nur an api.anthropic.com.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';

const SYSTEM = `Du bist Sprechtrainer für freie Vorträge auf Deutsch.
Du bekommst das automatische Live-Transkript eines Vortrags (ohne Satzzeichen, Fehler der Spracherkennung sind möglich).
Beurteile NUR die letzte Äußerung: Ist der Satz am Ende grammatisch vollständig, und passt das abschließende Verb inhaltlich und grammatisch zum Satzanfang?
Typische Fehler des Sprechers: Der Satz wird nicht zu Ende geführt, das Verb am Ende fehlt (offene Verbklammer), oder es wird ein Verb gewählt, das nicht zum Satz passt.
Sei tolerant gegenüber gesprochener Sprache, Ellipsen, Aufzählungen und Erkennungsfehlern einzelner Wörter. Melde nur eindeutige Probleme.
Der Hinweis soll sehr kurz sein (höchstens 8 Wörter) und, wenn möglich, das passende Verb vorschlagen.`;

const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problem: { type: 'string', enum: ['keins', 'abgebrochen', 'verb_fehlt', 'verb_passt_nicht', 'satzbau'] },
    hinweis: { type: 'string' },
  },
  required: ['ok', 'problem', 'hinweis'],
  additionalProperties: false,
};

let sdkPromise = null;

export class SentenceJudge {
  constructor({ apiKey, model = 'claude-opus-5-5' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.busy = false;
    this.pending = null;
    this.client = null;
  }

  async getClient() {
    if (!this.client) {
      sdkPromise ||= import(SDK_URL);
      const { default: Anthropic } = await sdkPromise;
      this.client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    }
    return this.client;
  }

  // Nimmt immer nur die jüngste Äußerung in die Warteschlange – ältere sind live nicht mehr relevant.
  submit(context, utterance, onResult, onError) {
    this.pending = { context, utterance, onResult, onError };
    if (!this.busy) this.drain();
  }

  async drain() {
    while (this.pending) {
      const job = this.pending;
      this.pending = null;
      this.busy = true;
      try {
        const verdict = await this.judge(job.context, job.utterance);
        if (verdict) job.onResult(verdict);
      } catch (err) {
        job.onError(err);
      } finally {
        this.busy = false;
      }
    }
  }

  async judge(context, utterance) {
    const client = await this.getClient();
    const prompt = `Bisheriger Vortrag (Kontext):\n${context || '(Anfang)'}\n\nLetzte Äußerung:\n${utterance}`;
    const response = await client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    const block = response.content.find((b) => b.type === 'text');
    return block ? JSON.parse(block.text) : null;
  }
}

export async function describeError(err) {
  try {
    const { default: Anthropic } = await (sdkPromise || import(SDK_URL));
    if (err instanceof Anthropic.AuthenticationError) return 'API-Schlüssel ungültig';
    if (err instanceof Anthropic.PermissionDeniedError) return 'Keine Berechtigung für dieses Modell';
    if (err instanceof Anthropic.RateLimitError) return 'Zu viele Anfragen – kurz warten';
    if (err instanceof Anthropic.APIConnectionError) return 'Keine Verbindung zur Claude-API';
    if (err instanceof Anthropic.APIError) return `API-Fehler ${err.status ?? ''}`.trim();
  } catch {
    // SDK nicht ladbar – unten generisch melden
  }
  return err?.message || String(err);
}
