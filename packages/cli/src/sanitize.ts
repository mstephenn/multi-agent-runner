/* eslint-disable no-control-regex */
// Stored model/agent text must never be able to drive the user's terminal (clear screen, set title, OSC 52 clipboard, ...).
const OSC = /(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)?/g;
const STRINGS = /(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[^\x1b\u009c]*(?:\x1b\\|\u009c)?/g; // DCS, SOS, PM, APC
const CSI = /(?:\x1b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?/g;
const ESC = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\u009f]/g; // everything but \t and \n (this also removes \r)

/** Removes ANSI/OSC/DCS escape sequences and all C0/C1 control characters except `\n` and `\t`. Everything else (markdown, unicode, emoji) is unchanged. */
export const sanitizeForTerminal = (s: string): string =>
  s.replace(OSC, "").replace(STRINGS, "").replace(CSI, "").replace(ESC, "").replace(CONTROL, "");
