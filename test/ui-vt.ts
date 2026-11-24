/**
 * test/ui-vt.ts: a tiny terminal model for the live-region tests.
 *
 * It applies the few sequences the live region writes (text, `\r`, `\n`,
 * cursor up and down, erase line, cursor show and hide) to a grid of rows so a
 * test can assert what a person would see, not only which bytes went out.
 * Colors and other modes are ignored. Rows are unbounded downward (scrollback
 * and screen are one list); the cursor cannot move above row zero.
 *
 *   const vt = terminalModel(80);
 *   vt.apply(out.raw());
 *   vt.rows();        // ["first line", "second line"]
 *   vt.cursor;        // { row: 1, column: 0 }
 */

export interface TerminalModel {
  apply(bytes: string): void;
  rows(): string[];
  readonly cursor: { row: number; column: number };
  cursorVisible: boolean;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** A CSI sequence (with its private mark, parameters, command), an OSC sequence, or one character. */
const TOKEN = new RegExp(
  `${ESC}\\[(\\??)([0-9;]*)([A-Za-z])|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[\\s\\S]`,
  "gu",
);

export function terminalModel(columns: number): TerminalModel {
  const grid: string[][] = [[]];
  const cursor = { row: 0, column: 0 };
  const model: TerminalModel = {
    cursor,
    cursorVisible: true,
    apply(bytes) {
      for (const match of bytes.matchAll(TOKEN)) {
        const [token, privateMark, params, command] = match;
        if (command) {
          const n = Number(params || "1");
          if (privateMark && params === "25") model.cursorVisible = command === "h";
          else if (privateMark) continue;
          else if (command === "A") cursor.row = Math.max(0, cursor.row - n);
          else if (command === "B") cursor.row += n;
          else if (command === "K" && params === "2") grid[cursor.row] = [];
          continue;
        }
        if (token.startsWith(ESC)) continue;
        if (token === "\r") cursor.column = 0;
        else if (token === "\n") cursor.row++;
        else {
          if (cursor.column >= columns) {
            cursor.row++;
            cursor.column = 0;
          }
          const row = grid[cursor.row] ?? [];
          while (row.length < cursor.column) row.push(" ");
          row[cursor.column] = token;
          grid[cursor.row] = row;
          cursor.column++;
        }
        while (grid.length <= cursor.row) grid.push([]);
      }
      while (grid.length <= cursor.row) grid.push([]);
    },
    rows() {
      const lines = grid.map((row) => (row ?? []).join("").trimEnd());
      while (lines.length > 1 && lines.at(-1) === "") lines.pop();
      return lines;
    },
  };
  return model;
}
