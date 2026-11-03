// Das Startbild. Zwei Zeilen, weil "PromptPrinter" in dieser Schrift auf einer Zeile über 80 Spalten
// bräuchte. Die Schrift steht fest im Programm: für ein Bild keine Abhängigkeit.
const ART = [
  "██████╗ ██████╗  ██████╗ ███╗   ███╗██████╗ ████████╗",
  "██╔══██╗██╔══██╗██╔═══██╗████╗ ████║██╔══██╗╚══██╔══╝",
  "██████╔╝██████╔╝██║   ██║██╔████╔██║██████╔╝   ██║",
  "██╔═══╝ ██╔══██╗██║   ██║██║╚██╔╝██║██╔═══╝    ██║",
  "██║     ██║  ██║╚██████╔╝██║ ╚═╝ ██║██║        ██║",
  "╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝        ╚═╝",
  "██████╗ ██████╗ ██╗███╗   ██╗████████╗███████╗██████╗",
  "██╔══██╗██╔══██╗██║████╗  ██║╚══██╔══╝██╔════╝██╔══██╗",
  "██████╔╝██████╔╝██║██╔██╗ ██║   ██║   █████╗  ██████╔╝",
  "██╔═══╝ ██╔══██╗██║██║╚██╗██║   ██║   ██╔══╝  ██╔══██╗",
  "██║     ██║  ██║██║██║ ╚████║   ██║   ███████╗██║  ██║",
  "╚═╝     ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝",
];

export const BANNER_WIDTH = Math.max(...ART.map((line) => [...line].length));

/** Das Bild passt nur in ein echtes, breites Terminal, das Unicode zeigt; sonst nur Name und Version. */
export function banner(term, version) {
  const plain = `PromptPrinter ${version}`;
  if (!term.isTTY || !term.unicode || term.columns < BANNER_WIDTH + 2) return plain;
  return `${ART.map((line) => term.accent(line)).join("\n")}\n\n${term.dim(plain)}`;
}
