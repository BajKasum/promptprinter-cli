// Alles, was vom Server kommt, ist Text eines Sprachmodells und landet in einem Terminal. Ein Terminal
// führt Steuerfolgen aus: damit liesse sich die Ausgabe überschreiben, der Fenstertitel setzen, in
// manchen Terminals die Zwischenablage füllen. Deshalb geht nur bereinigter Text auf den Bildschirm.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\^_][^\u001b]*\u001b\\|[ -/]*[0-~])/g;
// Steuerzeichen ausser Zeilenumbruch und Tabulator, C1, und die Richtungszeichen, die Text anders
// anzeigen, als er dasteht.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function sanitize(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(UNSAFE, "");
}

/** Bricht eine Zeile an Wortgrenzen um. Ein Wort, das nicht passt, wird hart geteilt. */
export function wrapLine(line, width) {
  if (!Number.isFinite(width) || width < 1) return [line];
  if ([...line].length <= width) return [line];
  const out = [];
  let current = "";
  for (const word of line.split(/(?<= )/)) {
    let rest = word;
    while ([...current].length + [...rest.trimEnd()].length > width) {
      if (current) {
        out.push(current.trimEnd());
        current = "";
        continue;
      }
      const chars = [...rest];
      out.push(chars.slice(0, width).join(""));
      rest = chars.slice(width).join("");
    }
    current += rest;
  }
  if (current.trimEnd()) out.push(current.trimEnd());
  return out;
}
