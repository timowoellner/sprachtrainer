# Redefluss-Trainer

Live-Feedback beim Vortrag: Eine Lampe leuchtet **rot**, sobald du „Äh“/„Öh“ sagst oder ins
Stottern gerätst, und **gelb**, wenn ein Satz offen endet oder ein eigenes Füllwort fällt.
Optional piept es oder das Handy vibriert.

Reine Browser-App – keine Installation, kein Server-Backend.

## Starten

```bash
python3 -m http.server 8080      # oder: npm start
```

Dann im Browser `http://localhost:8080` öffnen, **Start** drücken, Mikrofon erlauben.
Die ersten 1,5 Sekunden kurz still sein – da wird das Raumgeräusch eingemessen.

Empfohlen: **Chrome oder Edge** (Desktop oder Android). In Firefox fehlt die Spracherkennung;
Äh und Stottern werden dort trotzdem akustisch erkannt.

Fürs Handy am Rednerpult muss die Seite über HTTPS laufen (Mikrofonzugriff), z. B. über
GitHub Pages: *Settings → Pages → Branch auswählen*. Dann **Bühnenmodus** antippen – der ganze
Bildschirm wird zur Lampe und ist aus dem Augenwinkel sichtbar.

## Was erkannt wird

| Befund | Wie | Lampe |
|---|---|---|
| **Äh / Öh / Ähm** | Akustisch: ein Laut, der ≥ 380 ms mit nahezu gleicher Tonhöhe *und* Klangfarbe gehalten wird. In flüssiger Rede ändern sich beide ständig. Zusätzlich im Transkript, falls die Spracherkennung „äh“ ausschreibt. | rot |
| **Stottern: Dehnung** | Akustisch: „Mmmmeine“, „Sssso“ – gehaltene stimmhafte Laute (wie Äh) und gehaltene Reibelaute (s, sch, f). | rot |
| **Stottern: Silbenwiederholung** | Akustisch: drei kurze, gleich klingende Silben direkt hintereinander („b-b-bitte“). | rot |
| **Stottern: Wort-/Teilwortwiederholung** | Transkript: „ich ich“, „Pro- Projekt“. Typisch doppelte Wörter wie „die die“ erst ab dreimal. | rot |
| **Satzende offen** | Transkript, nach jeder Sprechpause: Satz endet mit Artikel/Konjunktion („… und die“), Nebensatz ohne Verb („…, dass wir das Projekt“), offene Verbklammer nach Modalverb („Ich möchte heute über X“). | gelb |
| **Unpassendes Verb am Satzende** | Nur mit der optionalen **KI-Prüfung** (Claude): „Wir haben die Kosten deutlich gegangen“. | gelb |
| **Eigene Füllwörter** | Transkript, frei konfigurierbar (z. B. „also, sozusagen, halt“). | gelb |

Die akustische Erkennung reagiert innerhalb von etwa 0,4 s – noch während das Äh läuft.
Erkennungen aus dem Transkript kommen je nach Browser 0,5–2 s später.

Grenzen: Stille Blockaden (man bleibt hängen, ohne einen Ton zu machen) sind akustisch nicht von
normalen Pausen zu unterscheiden und werden nicht gemeldet. Bewusst gedehnte Wörter („jaaa“) können
als Äh zählen – dafür gibt es die Empfindlichkeitsregler.

## Einstellungen

- **Rückmeldung je Kategorie:** Lampe, Piepton, Vibration einzeln schaltbar. Den Piepton nur im
  Training mit Kopfhörer verwenden – im Saal hört ihn sonst das Publikum.
- **Äh ab Dauer:** Standard 380 ms. Kleiner = empfindlicher.
- **Klangfarben-Toleranz / Sprachschwelle:** bei Fehlalarmen (langsames, betontes Sprechen oder laute
  Umgebung) anpassen.
- **KI-Prüfung:** eigener Anthropic-API-Schlüssel nötig. Jede abgeschlossene Äußerung geht als Text an
  die Claude-API (kostenpflichtig, Antwort nach ca. 2–5 s). Der Schlüssel liegt nur im localStorage
  dieses Browsers. Standardmodell: Claude Opus 5.5; Sonnet 5.5 und Haiku 5.5 antworten schneller.
- **Aufnahme mitschneiden:** nach dem Stopp gibt es Aufnahme (WebM), Protokoll (CSV) und Transkript (TXT)
  zum Download.

## Probe-Aufnahmen auswerten

Unter *Aufnahme nachträglich analysieren* eine Audiodatei wählen (z. B. Handy-Aufnahme einer Probe).
Äh-Laute und Stotter-Stellen werden lokal gesucht; ein Klick auf einen Eintrag springt im Player an
die Stelle.

## Datenschutz

- Die akustische Analyse (Äh, Dehnung, Silbenwiederholung) läuft vollständig im Browser.
- Das Live-Transkript nutzt die Web Speech API. Chrome und Edge senden das Audio dafür an Google bzw.
  Microsoft. Wer das nicht möchte: *Einstellungen → Live-Transkript nutzen* ausschalten.
- Die KI-Prüfung sendet nur Text an `api.anthropic.com` und ist standardmäßig aus.

## Aufbau

```
index.html               Oberfläche
css/style.css            Gestaltung inkl. Bühnenmodus und Dark Mode
js/app.js                Ablaufsteuerung, Zähler, Protokoll, Einstellungen
js/acoustic-detector.js  Erkennung von Äh, Dehnung, Silbenwiederholung
js/dsp.js                Pegel, Tonhöhe (NSDF), Spektralform (FFT)
js/text-analysis.js      Füllwörter, Wiederholungen, Satzende-Regeln
js/speech.js             Web-Speech-API-Wrapper mit Auto-Neustart
js/claude-check.js       Optionale KI-Prüfung der Satzenden
js/alerts.js             Lampe, Piepton, Vibration
js/audio-input.js        Mikrofon (AudioWorklet) und Datei-Dekodierung
tests/                   Tests mit synthetischen Signalen und Beispielsätzen
```

```bash
npm test
```
