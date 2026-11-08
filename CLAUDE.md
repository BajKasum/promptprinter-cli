# CLAUDE.md, Projekt-Kontext für Claude-Code-Sessions

Wird bei jedem Session-Start geladen. Kurz: was das Projekt ist, in welchem Zustand es steckt, nach welchen Regeln hier gearbeitet wird.

## Was ist promptprinter-cli?

Das Programm zu PromptPrinter fürs Terminal: dünner Client auf dem Chat des Haupt-Repos (`BajKasum/PromptPrinter`). Anmeldung per Geräte-Code im Browser, danach eine eigene Supabase-Sitzung als `Authorization: Bearer`. Plan und Stand stehen im Vault: "PromptPrinter Terminal-App Stand und Restplan", "PromptPrinter Terminal-App Architektur".

## IST-Zustand

Gegenwart, keine Historie.

- **Phase 2 gebaut:** Startbild, `login`, `logout`, `whoami`, Chat, `/pp <Idee>`, `/new`, `/copy`, `/save`.
- **`/an claude`, `/an codex` gebaut:** startet den Agenten im selben Terminal, der Prompt ist ein eigenes Argument nach `--`. Nie über eine Shell; unter Windows wird die `.cmd`-Datei von npm zu ihrem Skript aufgelöst, eine unbekannte Form wird nicht gestartet.
- **MCP gebaut:** `promptprinter mcp` (stdio, MCP 2026-07-28 und die älteren Versionen mit `initialize`), Werkzeuge `create_prompt`, `list_saved_prompts`, `get_saved_prompt`. Nutzt die gespeicherte Anmeldung, meldet nie selbst an. Die Liste kommt von `GET /api/cli/prompts` und `/api/cli/prompts/[id]` im Haupt-Repo; der Verlauf einer Rückfrage liegt im Speicher des Prozesses, unter der `conversation_id`.
- **Phase 3 gebaut:** `/pp --kontext <Idee>`. `src/context.mjs` ist eine Kopie aus `promptprinter-pp` (Herkunft im Kopf, Pin `contract/context-pin.json`; `test/context.test.mjs` und `npm run contract` melden Abweichungen), `src/project-context.mjs` baut daraus die Nachricht: höchstens 8000 Zeichen, gekürzt wird nur der Kontext. Vorschau mit Empfänger und Hinweis auf den Chat-Verlauf, nur ein getipptes `j` sendet, aus einer Pipe nie.
- **Phase 4 vorbereitet:** Version 0.2.0, `"private"` ist entfernt (Kasums Auftrag vom 08.11.2026). Veröffentlicht ist nichts; das kann nur Kasum mit seinem npm-Konto, die erste Version von Hand.

## Aufbau

Node 22 oder neuer, ESM, **keine Laufzeit-Abhängigkeiten**.

| Datei | Aufgabe |
|---|---|
| `bin/promptprinter.mjs` | Einstieg, Versionsprüfung |
| `src/cli.mjs` | Befehle von aussen, Start des Programms |
| `src/repl.mjs` | Eingabezeile und Befehle im Programm |
| `src/api.mjs` | je Route eine Methode, keine Umleitungen |
| `src/session.mjs` | Sitzung auf der Platte, Sperre, Erneuern |
| `src/login.mjs` | Anmeldung per Geräte-Code |
| `src/chat.mjs` | ein Zug, Verlauf |
| `src/sse.mjs` | Antwort-Strom lesen |
| `src/render.mjs` | Antwort zeichnen, Blöcke rahmen |
| `src/text.mjs` | Steuerzeichen entfernen, umbrechen |
| `src/system.mjs` | Zwischenablage, Datei, Browser |
| `src/mcp.mjs` | `promptprinter mcp`: MCP-Server über stdio, Werkzeuge |
| `src/agents.mjs` | `/an claude`, `/an codex`: Agent finden und ohne Shell starten |
| `src/messages.mjs` | Texte, deutsch und englisch |

## Regeln, die hier gelten

- **Text vom Server ist fremd.** Was auf den Bildschirm geht, läuft durch `sanitize` (`text.mjs`): ein Terminal führt Steuerfolgen aus.
- **Ein Token geht nur an seinen Server.** `session.mjs` lädt eine Sitzung nur für den Server, der sie ausgestellt hat; `api.mjs` folgt keiner Umleitung; `config.mjs` erlaubt `http` nur auf dem eigenen Rechner.
- **Das Programm kennt den Key des Anbieters nie.** Der Server holt ihn pro Zug.
- **Kein Token, kein Geräte-Code in einer Ausgabe.**
- **Das neue Refresh-Token wird gespeichert, bevor es jemand benutzt.** Auf Produktion erkennt der Auth-Server wiederverwendete Tokens.

## Verhältnis zum Haupt-Repo

Zwei Repos, kein gemeinsamer Code. Das Haupt-Repo ist "alle Rechte vorbehalten", dieses MIT, deshalb übernimmt dieses Repo nur Verträge und Ideen als eigenen Text.

| Quelle im Haupt-Repo | Wird hier |
|---|---|
| `src/shared/lib/chat-stream.ts` | `src/sse.mjs` |
| `src/app/api/cli/*/route.ts` | `src/api.mjs`, `src/login.mjs`, `src/mcp.mjs` (gespeicherte Prompts) |
| `src/shared/lib/chat-limits.ts` | `src/chat.mjs` |
| `extractPrompt` in `src/shared/lib/saved-prompts.ts` | `src/extract-prompt.mjs` |
| `normalizeFences` | `src/render.mjs` |
| `src/shared/lib/ai-marker.ts` | `src/system.mjs` |

`npm run contract` vergleicht die Dateien der Liste `contract/pins.json` mit dem Stand auf `main` (Workflow `contract.yml`, wöchentlich). Wird er rot, hat sich der Vertrag oder ein Kommentar dort geändert: lesen, hier nachziehen, dann `node scripts/check-contract.mjs --update`.

## Arbeitsregeln (wie im Haupt-Repo)

- Git-Staging explizit per Dateiname. Nach `main` per Pull Request mit "Rebase and merge", Branches nie löschen, nie force-pushen.
- Vor jedem Push: `npm run check && npm test`. Für jede neue Schranke eine Zeile in `test/mutation.mjs` (`npm run mutation`).
- Commit-Nachrichten deutsch, Conventional Commits, Trailer `Co-Authored-By: Claude <aktuelles Modell> <noreply@anthropic.com>`.
- Kommentare auf Deutsch, sagen was gilt und warum, kein Verlauf.
- Veröffentlichung auf npm, Rechtstexte: nur mit Kasums ausdrücklichem Ja.

## Veröffentlichung

Vorbereitet, nicht veröffentlicht. Seit 0.2.0 steht kein `"private"` mehr in `package.json`: ein `npm publish` mit Kasums Konto ginge durch. Deshalb hier nie `npm publish`, `npm login` oder einen Tag `v*` ausführen; das ist Kasums Schritt.

- **Paketinhalt:** `"files"` lässt nur `bin`, `src`, `LICENSE`, `README.md` und `package.json` hinein, `test/package.test.mjs` fragt dazu `npm pack --dry-run`. npm lässt eine `.env` in diesen Ordnern nicht von sich aus weg, der Test schlägt dann an.
- **Weg:** `.github/workflows/release.yml` läuft nur auf einen Tag `vX.Y.Z` (Tag gleich Version, Commit auf `main`), meldet sich per Trusted Publishing an und veröffentlicht mit Provenance. Kein npm-Token im Repo, `test/release-workflow.test.mjs` hält beides fest.
- **Die erste Version geht von Hand hinaus:** einen Trusted Publisher kann man nur für ein Paket eintragen, das es schon gibt. Danach auf npmjs.com den Workflow eintragen und Tokens für das Paket sperren. Kasums Handgriffe und der genaue Befehl stehen im Vault, "PromptPrinter Terminal-App Phase 4 Vorbereitung".
- **README:** der Abschnitt "Install" ist als Kommentar vorbereitet und wird erst mit der Veröffentlichung sichtbar. Vorher keinen Installationsbefehl zeigen: wer den Namen zuerst belegt, bekäme sonst die Nutzer.
- **Windows:** `session.mjs` gibt dem Sitzungsordner eine eigene Zugriffsliste (keine geerbten Rechte, nur der Nutzer), wie `0700` anderswo. `whoami` und `icacls` mit festem Pfad aus System32, in Git Bash steht ein anderes `whoami` vorn. Die Mutationen dazu laufen nur unter Windows, in der CI im Job "Mutationen unter Windows".
- **Abnahme mit dem echten Programm:** `acceptance/`, ausserhalb von `npm test` und Paket, läuft im Haupt-Repo gegen den lokalen Stack (`acceptance/README.md`).
