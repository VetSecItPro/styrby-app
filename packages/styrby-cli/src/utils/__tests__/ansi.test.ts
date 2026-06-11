/**
 * Unit tests for `utils/ansi` stripAnsi (#26 L6 encoding resilience).
 *
 * Control bytes are built with String.fromCharCode so the test source stays
 * pure ASCII (no raw escape bytes embedded in the file).
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../ansi';

const ESC = String.fromCharCode(0x1b); // 
const BEL = String.fromCharCode(0x07); // 
const CR = String.fromCharCode(0x0d); // \r
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);

describe('stripAnsi', () => {
  it('strips CSI colour sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(stripAnsi(`${ESC}[1;32mbold green${ESC}[0m`)).toBe('bold green');
  });

  it('strips CSI cursor show/hide (kiro spinner frames)', () => {
    expect(stripAnsi(`${ESC}[?25lloading${ESC}[?25h`)).toBe('loading');
  });

  it('strips OSC title/hyperlink sequences (BEL-terminated)', () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}hello`)).toBe('hello');
  });

  it('strips OSC sequences terminated by ST (ESC backslash)', () => {
    expect(stripAnsi(`${ESC}]8;;https://x.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
  });

  it('strips other two-char ESC sequences (keypad/charset)', () => {
    expect(stripAnsi(`${ESC}=app${ESC}>${ESC}(Btext`)).toBe('apptext');
  });

  it('strips stray C0 control bytes and DEL', () => {
    expect(stripAnsi(`a${NUL}b${DEL}c`)).toBe('abc');
  });

  it('strips carriage returns (line-redraw artifacts)', () => {
    expect(stripAnsi(`overwritten${CR}final`)).toBe('overwrittenfinal');
  });

  it('preserves tab and newline (meaningful whitespace)', () => {
    expect(stripAnsi('line1\nline2\tindented')).toBe('line1\nline2\tindented');
  });

  it('leaves plain text untouched (incl. unicode/emoji)', () => {
    expect(stripAnsi('hello world 🚀 café')).toBe('hello world 🚀 café');
  });

  it('is idempotent (stripping twice equals once)', () => {
    const input = `${ESC}[31m${ESC}]0;t${BEL}x${CR}y`;
    expect(stripAnsi(stripAnsi(input))).toBe(stripAnsi(input));
  });

  it('handles an empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
