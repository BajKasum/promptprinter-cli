// Das Startbild. Nur volle Blöcke (█) und Leerzeichen: Rahmenlinien (╔═╝) zerfallen in Windows Terminal und in
// manchen Schriften zu einzelnen Strichen, volle Blöcke zeichnet jedes Terminal als geschlossene Fläche. Fünf
// Zeilen hoch; ab 71 Spalten auf einer Zeile, darunter in zwei Zeilen, unter 60 nur der Name. Ab 101 Spalten und mit
// Farbe steht Finn links daneben. Schrift und Bild stehen fest im Programm: für ein Bild keine Abhängigkeit.
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

// Finn, das Maskottchen, aus Halbblöcken: je Zeichen zwei Bildpunkte, oben die Vordergrund-, unten die
// Hintergrundfarbe. Nach dem Maskottchen im Haupt-Repo: hellblauer Körper, heller Bauch, Rückenflosse oben links,
// Schwanz unten links, Schnauze nach rechts, grosses Auge mit Glanzpunkt, Wange. Nur mit Farbe, ohne ist es ein Klecks.
const FINN_COLORS = {
  O: "31;61;115", // Umriss
  B: "104;178;226", // Körper
  L: "160;214;242", // Glanz auf dem Kopf
  W: "236;246;251", // Bauch
  E: "18;34;68", // Auge
  H: "255;255;255", // Glanzpunkt im Auge
  C: "168;190;220", // Wange
  D: "62;130;192", // Flossen
};
const FINN = [
  "...........OOOOOOO..........",
  "..OOO....OOBBBBBBBOO........",
  ".ODDDO..OBBBBBBBBBBBO.......",
  ".ODDDDOOBBBBBLLLBBBBBO......",
  "..ODDDOBBBBBBBBBBBBBBO......",
  "...OODBBBBBBBBBBBBBBBBO.....",
  "....OBBBBBBBBBBBBBBEBBBOOOO.",
  "....OBBBBBEEEBBBBBBBBBBBBBBO",
  "...OBBBBBEEEHEBBBBBBBBBBBBBO",
  "...OBBBBBEEEEEBBBOBBBBBBBBO.",
  "...OBBBBBBEEEBBBBBOOOOOOOO..",
  "...OBBBCCCBBBBBBBBWWWWWWO...",
  "...OBBBCCCBBBBBBWWWWWWWO....",
  "...OBBBBBBBBBBBWWWWWWWWO.ODO",
  "...OBBBBBBBBBBWWWWWWWWWOODDO",
  "...OBBBBBBBBBWWWWWWWWWWODDO.",
  "...OBBBBBBBBWWWWWWWWWWOOOO..",
  "...OBBBBBBBWWWWWWWWWWO......",
  "....OBBBBBBWWWWWWWWWO.......",
  "..OOOBBBBBBBWWWWWWOO........",
  ".ODDDOOBBBBBBBBOOO..........",
  "ODDDDDOOOOOOOOO.............",
  ".OOOOO......................",
];
export const FINN_WIDTH = FINN[0].length;
const FINN_GAP = "  ";
const FINN_COLUMNS = FINN_WIDTH + FINN_GAP.length + BANNER_WIDTH + 2;

function finnRows() {
  const rows = [];
  for (let y = 0; y < FINN.length; y += 2) {
    let row = "";
    for (let x = 0; x < FINN_WIDTH; x++) {
      const top = FINN_COLORS[FINN[y][x]];
      const bottom = FINN_COLORS[FINN[y + 1]?.[x]];
      if (top && bottom) row += `\u001b[38;2;${top};48;2;${bottom}m▀\u001b[0m`;
      else if (top) row += `\u001b[38;2;${top}m▀\u001b[0m`;
      else if (bottom) row += `\u001b[38;2;${bottom}m▄\u001b[0m`;
      else row += " ";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Das Bild passt nur in ein echtes Terminal, das Unicode zeigt und mindestens 60 Spalten hat; sonst nur Name und
 * Version. "PROMPT" in Finns Blau, "PRINTER" in der Grundfarbe, wie im Logo. Mit Finn steht der Schriftzug mittig
 * auf seiner Höhe, die Version darunter.
 */
export function banner(term, version) {
  const plain = `PromptPrinter ${version}`;
  if (!term.isTTY || !term.unicode || term.columns < MIN_COLUMNS) return plain;
  const pad = width(PROMPT);
  const oneLine = PROMPT.map((line, row) => `${term.accent(line.padEnd(pad))}${WORD_GAP}${PRINTER[row]}`);
  if (term.color && term.columns >= FINN_COLUMNS) {
    const finn = finnRows();
    const top = Math.floor((finn.length - oneLine.length - 2) / 2);
    const right = (row) =>
      row >= top && row < top + oneLine.length ? oneLine[row - top] : row === top + oneLine.length + 1 ? term.dim(plain) : "";
    return finn.map((row, i) => `${row}${FINN_GAP}${right(i)}`.trimEnd()).join("\n");
  }
  const lines =
    term.columns >= BANNER_WIDTH + 2
      ? oneLine.map((line) => line.trimEnd())
      : [...PROMPT.map((line) => term.accent(line)), "", ...PRINTER];
  return `${lines.join("\n")}\n\n${term.dim(plain)}`;
}
