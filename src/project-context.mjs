import { buildPack, redactText, renderPack, searchRepo } from "./context.mjs";
import { sanitize } from "./text.mjs";

// Was `/pp --kontext` aus dem aktuellen Ordner mitschickt: Git-Stand und Regeldateien aus `pack`, dazu
// Trefferzeilen aus `search`, beide aus context.mjs. Die Absicht bleibt immer ganz; was neben ihr nicht in
// die Grenze des Servers passt, fällt am Kontext weg.

// Darunter passen nicht einmal Repo, Branch und Status: dann lieber gar kein Kontext als ein Stummel.
const MIN_CONTEXT_CHARS = 500;
const MAX_TERMS = 8;
const PACK_LEVELS = [0, 1, 2, 3];
const CUT_MARKER = "(cut)";
// Häufige Wörter einer Idee, die in jedem Repo treffen und nichts finden.
const STOPWORDS = new Set(
  (
    "aber alle allen alles also ändere ändern auch auf aus bauen baue beim bitte dann dass dein deine diese " +
    "diesem diesen dieser dieses doch eine einem einen einer eines erstelle erstellen etwas für füge geht " +
    "gibt haben habe hier hinzu immer kann können machen mache mehr mein meine meinen mich mit muss müssen " +
    "nach neue neuen neuer neues nicht noch oder prüfe prüfen schon schreibe schreiben sehr sein seine sich " +
    "sind soll sollen über unter unser viel vom von wenn werden wird will wollen zeige zeigen " +
    "zum zur z.b d.h u.a " +
    "about also could from have into just like make more only please should some than that their them then " +
    "there this what when which will with would e.g i.e"
  ).split(" ")
);

/** Suchbegriffe aus der Idee: Bezeichner zuerst (Pfade, snake_case, camelCase), dann längere Wörter. */
export function deriveTerms(idea) {
  const tokens = String(idea)
    .split(/[^\p{L}\p{N}_.\-/]+/u)
    .map((token) => token.replace(/[.\-/]+$/, ""))
    .filter((token) => token.length >= 2 && token.length <= 64 && !/^\d+$/.test(token))
    .filter((token) => !STOPWORDS.has(token.toLowerCase()));
  const identifiers = tokens.filter((token) => /[_./]|[a-z][A-Z]/.test(token));
  const words = tokens.filter((token) => token.length >= 4 || /^[A-Z0-9]{3}$/.test(token));
  const terms = [];
  for (const term of [...identifiers, ...words]) {
    if (terms.length >= MAX_TERMS) break;
    if (!terms.some((known) => known.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  return terms;
}

// Text aus dem Ordner ist fremd wie Text vom Server: er landet in der Vorschau im Terminal. Erst bereinigen,
// dann schwärzen, sonst setzte eine Steuerfolge mitten im Wert die Teile erst nach dem Schwärzen zusammen.
const clean = (text) => sanitize(text).split("\n").map(redactText).join("\n");

function searchChunks(search) {
  return search.results.map((hit, index) => {
    const what = hit.terms.length ? hit.terms.join(", ") : "path match";
    const notes = `${hit.changed ? "; changed recently" : ""}${hit.test ? "; test file" : ""}`;
    const lines = [`${index + 1}. ${hit.path} (${what}; ${hit.hits} hits${notes})`];
    for (const line of hit.lines) lines.push(`   ${line.n}: ${line.text}`);
    if (hit.relatedTests?.length) lines.push(`   tests: ${hit.relatedTests.join(", ")}`);
    return { text: clean(lines.join("\n")), lines: hit.lines.length };
  });
}

function compose(packText, chunks, shared) {
  if (!chunks.length) return packText;
  const parts = [packText, ["## Search hits", ...chunks.map((chunk) => chunk.text)].join("\n")];
  if (shared) parts.push(shared);
  return parts.join("\n\n");
}

function cutLines(text, max) {
  const kept = [];
  let length = CUT_MARKER.length;
  for (const line of text.split("\n")) {
    if (length + line.length + 1 > max) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, CUT_MARKER].join("\n");
}

/**
 * Baut die Nachricht: Absicht, Trennlinie, `intro` (sagt Finn, was folgt), Kontext. Höchstens `max` Zeichen.
 * Ergebnis `noRoom`, wenn neben der Absicht kein Kontext mehr Platz hat. Gekürzt wird zuerst der Umfang
 * von `pack`, dann fallen Trefferdateien von hinten weg (die schwächsten zuerst).
 */
export async function buildContextMessage({ cwd, idea, intro, max }) {
  const head = `${idea}\n\n---\n${intro}\n\n`;
  const budget = max - head.length;
  if (budget < MIN_CONTEXT_CHARS) return { kind: "noRoom" };

  const pack = buildPack(cwd, "claude");
  try {
    const terms = deriveTerms(idea);
    const search = terms.length ? await searchRepo(cwd, terms.join(","), "M") : { results: [], shared: [] };
    const packs = PACK_LEVELS.map((level) => clean(renderPack(pack, level)));
    const chunks = searchChunks(search);
    const shared = search.shared.length
      ? clean(["## Shared identifiers", ...search.shared.map((s) => `- ${s.term}: used in ${s.files} files`)].join("\n"))
      : "";

    let context = null;
    let used = 0;
    for (let n = chunks.length; n >= 0 && context === null; n--) {
      for (const packText of packs) {
        const candidate = compose(packText, chunks.slice(0, n), shared);
        if (candidate.length <= budget) {
          context = candidate;
          used = n;
          break;
        }
      }
    }
    context ??= cutLines(packs.at(-1), budget);

    const included = chunks.slice(0, used);
    return {
      kind: "ready",
      message: `${head}${context}`,
      repo: sanitize(pack.repo.name),
      files: included.length,
      lines: included.reduce((sum, chunk) => sum + chunk.lines, 0),
      redacted: context.split("[redacted:").length - 1,
      denied: pack.skipped.filter((s) => s.reason.startsWith("deny list")).length,
    };
  } finally {
    // context.mjs sammelt Hinweise in einer Liste je Prozess, das Programm lebt länger als ein Aufruf.
    pack.hints.length = 0;
  }
}
