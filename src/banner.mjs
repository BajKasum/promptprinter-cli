// Das Startbild. Nur volle Blöcke (█) und Leerzeichen: Rahmenlinien (╔═╝) zerfallen in Windows Terminal und in
// manchen Schriften zu einzelnen Strichen, volle Blöcke zeichnet jedes Terminal als geschlossene Fläche. Fünf
// Zeilen hoch; ab 71 Spalten auf einer Zeile, darunter in zwei Zeilen, unter 60 nur der Name. Die Schrift steht
// fest im Programm: für ein Bild keine Abhängigkeit.
const FONT = {
  P: ["####", "#  #", "####", "#   ", "#   "],
  R: ["####", "#  #", "####", "# # ", "#  #"],
  O: ["####", "#  #", "#  #", "#  #", "####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
  I: ["###", " # ", " # ", " # ", "###"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #"],
  E: ["####", "#   ", "### ", "#   ", "####"],
};

function word(text) {
  return FONT.P.map((_, row) =>
    [...text].map((letter) => FONT[letter][row]).join(" ").replaceAll("#", "█").trimEnd()
  );
}

const PROMPT = word("PROMPT");
const PRINTER = word("PRINTER");
const WORD_GAP = "   ";
const width = (lines) => Math.max(...lines.map((line) => [...line].length));

export const BANNER_WIDTH = width(PROMPT) + WORD_GAP.length + width(PRINTER);
const MIN_COLUMNS = 60;

/**
 * Das Bild passt nur in ein echtes Terminal, das Unicode zeigt und mindestens 60 Spalten hat; sonst nur Name und
 * Version. "PROMPT" in Finns Blau, "PRINTER" in der Grundfarbe, wie im Logo.
 */
export function banner(term, version) {
  const plain = `PromptPrinter ${version}`;
  if (!term.isTTY || !term.unicode || term.columns < MIN_COLUMNS) return plain;
  let lines;
  if (term.columns >= BANNER_WIDTH + 2) {
    const pad = width(PROMPT);
    lines = PROMPT.map((line, row) => `${term.accent(line.padEnd(pad))}${WORD_GAP}${PRINTER[row]}`.trimEnd());
  } else {
    lines = [...PROMPT.map((line) => term.accent(line)), "", ...PRINTER];
  }
  return `${lines.join("\n")}\n\n${term.dim(plain)}`;
}
