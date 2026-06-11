/**
 * Terminal-control-sequence stripping for plain-text agent output.
 *
 * Plain-text agents (kiro-cli, and the version probes) emit markdown styled
 * with terminal escape sequences: CSI color codes, OSC title/hyperlink
 * sequences, charset designators, cursor show/hide, spinner frames, and stray
 * C0 control bytes. None of that is part of the model's actual text. Because
 * the stripped output is relayed to the mobile app and rendered as a plain
 * string, residual control bytes show up as garbage glyphs. This strips them
 * at the L6 encoding boundary so what reaches the relay is clean UTF-8 text.
 *
 * @module utils/ansi
 */

/* eslint-disable no-control-regex */

// Regexes use \u escapes (not raw bytes) so the source stays readable ASCII.
// Applied in order; earlier rules consume multi-byte sequences before the
// final catch-all strips any remaining lone control bytes.
const OSC = /\u001b\][^]*?(?:\u0007|\u001b\\)/g; // ESC ] ... (BEL | ESC backslash)
const CSI = /\u001b\[[0-?]*[ -\/]*[@-~]/g;          // ESC [ ... final byte
const CHARSET = /\u001b[()*+][@-~]/g;                 // ESC ( B  charset designation (3-byte)
const ESC2 = /\u001b[@-_=>#%]/g;                      // other 2-byte Fe/Fs escapes (keypad, reset)
const C0 = /[\u0000-\u0008\u000b-\u001f\u007f]/g; // C0 + DEL, keep \t(09) \n(0A)

/**
 * Strip terminal escape / control sequences from a stdout chunk, preserving
 * human-readable text plus tab and newline.
 *
 * Handles, in order: OSC (title/hyperlink), CSI (color/cursor/erase), charset
 * designators (ESC ( B), other two-byte ESC sequences (keypad/reset), then
 * stray C0 control bytes + DEL, EXCEPT tab and newline.
 *
 * WHY keep \t and \n: meaningful whitespace in the rendered text.
 * WHY strip \r (in the C0 range): kiro-cli redraws lines with carriage
 * returns; a lone \r in relayed text causes overwrite artifacts on mobile.
 *
 * @param text - Raw stdout chunk from a plain-text agent.
 * @returns The chunk with control sequences removed.
 *
 * @example
 * stripAnsi(escSeq + '[31mred' + escSeq + '[0m') // 'red'
 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(CHARSET, '')
    .replace(ESC2, '')
    .replace(C0, '');
}
