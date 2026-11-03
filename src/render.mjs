import { wrapLine } from "./text.mjs";

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Schreibt eine Antwort, während sie ankommt. Fliesstext geht sofort raus, ein Codeblock wird gerahmt und
 * zeilenweise ausgegeben, damit der Umbruch den Rahmen nicht zerreisst. Gehalten wird am Fliesstext nur
 * der Zeilenanfang, solange er noch der Beginn eines Blocks sein könnte.
 *
 * Der Abschluss eines Blocks darf am Ende einer Inhaltszeile stehen, glm-4.5-air schreibt ihn oft so
 * (wie normalizeFences im Haupt-Repo): sonst stünden die Backticks sichtbar im Prompt.
 */
export class ReplyRenderer {
  constructor({ write, term, labels }) {
    this.write = write;
    this.term = term;
    this.labels = labels;
    this.buffer = "";
    this.atLineStart = true;
    this.open = null;
    const unicode = term.unicode;
    this.border = unicode
      ? { top: "┌─", side: "│", bottom: "└", line: "─" }
      : { top: "+-", side: "|", bottom: "+", line: "-" };
    this.frameWidth = Math.min(Number.isFinite(term.wrapWidth) ? term.wrapWidth : 60, 60);
  }

  feed(text) {
    this.buffer += text;
    while (this.buffer) {
      const newline = this.buffer.indexOf("\n");
      if (this.open) {
        if (newline === -1) return;
        this.frameLine(this.takeLine(newline));
        continue;
      }
      if (this.atLineStart) {
        if (newline === -1) {
          if (this.couldBeFence(this.buffer)) return;
          this.writeProse(this.buffer);
          this.buffer = "";
          this.atLineStart = false;
          return;
        }
        const line = this.takeLine(newline);
        const fence = line.match(OPENING_FENCE);
        if (fence) this.openFrame(fence);
        else this.writeProse(`${line}\n`);
        continue;
      }
      if (newline === -1) {
        this.writeProse(this.buffer);
        this.buffer = "";
        return;
      }
      this.writeProse(`${this.takeLine(newline)}\n`);
      this.atLineStart = true;
    }
  }

  finish() {
    if (this.open) {
      if (this.buffer) this.frameLine(this.buffer);
      this.buffer = "";
      if (this.open) this.closeFrame();
    } else if (this.buffer) {
      this.writeProse(this.buffer);
      this.buffer = "";
      this.atLineStart = false;
    }
    if (!this.atLineStart) this.write("\n");
    this.atLineStart = true;
  }

  takeLine(newline) {
    const line = this.buffer.slice(0, newline);
    this.buffer = this.buffer.slice(newline + 1);
    return line;
  }

  couldBeFence(text) {
    return /^ {0,3}$/.test(text) || /^ {0,3}(`+|~+)[^\n]*$/.test(text);
  }

  writeProse(text) {
    this.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  openFrame(fence) {
    const lang = fence[2].trim().toLowerCase();
    const title = !lang || lang === "text" ? this.labels.prompt : lang;
    this.open = { char: fence[1][0], length: fence[1].length };
    const head = `${this.border.top} ${title} `;
    const rest = Math.max(0, this.frameWidth - [...head].length);
    this.write(`${this.term.accent(head + this.border.line.repeat(rest))}\n`);
  }

  closeFrame() {
    this.write(`${this.term.accent(this.border.bottom + this.border.line.repeat(this.frameWidth - 1))}\n`);
    this.open = null;
    this.atLineStart = true;
  }

  frameLine(line) {
    const { char, length } = this.open;
    const trimmed = line.trim();
    const run = trailingRun(trimmed, char);
    if (run >= length && run === trimmed.length) {
      this.closeFrame();
      return;
    }
    if (run >= length && char === "`") {
      this.frameContent(line.replace(/\s*`+\s*$/, ""));
      this.closeFrame();
      return;
    }
    this.frameContent(line);
  }

  frameContent(line) {
    const side = this.term.accent(this.border.side);
    const width = Number.isFinite(this.term.wrapWidth) ? this.term.wrapWidth - 2 : Infinity;
    for (const part of wrapLine(line, width)) this.write(part ? `${side} ${part}\n` : `${side}\n`);
  }
}

function trailingRun(text, char) {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === char; i--) count++;
  return count;
}
