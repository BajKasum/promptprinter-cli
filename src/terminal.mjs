// Was das Terminal kann. Eine Stelle, damit Farbe, Unicode und Breite überall gleich entschieden werden.
const ACCENT = "38;2;140;201;242"; // --accent der Marke (hsl 204 80% 75%, Finns Blau)

export function detectTerminal(stream = process.stdout, env = process.env, platform = process.platform) {
  const isTTY = Boolean(stream.isTTY);
  const dumb = env.TERM === "dumb";
  // https://no-color.org: gesetzt und nicht leer heisst keine Farbe.
  const color = isTTY && !dumb && !env.NO_COLOR;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const unicode = !dumb && env.TERM !== "linux" && (platform === "win32" || /utf-?8/i.test(locale));
  const paint = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    isTTY,
    unicode,
    color,
    get columns() {
      return stream.columns || 80;
    },
    /** Breite für umbrochenen Text. In eine Datei oder Pipe wird nichts umbrochen. */
    get wrapWidth() {
      return isTTY ? Math.max(20, (stream.columns || 80) - 2) : Infinity;
    },
    accent: paint(ACCENT),
    dim: paint("2"),
    /** Sprünge an den Zeilenanfang samt Löschen, nur im echten Terminal. */
    clearLine: isTTY ? "\r\u001b[K" : "",
  };
}
