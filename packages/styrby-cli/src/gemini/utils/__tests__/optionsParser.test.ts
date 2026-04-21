/**
 * Unit tests for `optionsParser` utilities.
 *
 * These helpers are the contract between Gemini's streaming output and the
 * mobile app's tappable-options UI. Tests pin every branch of the state
 * machine so a regex tweak can't silently break option rendering.
 */
import { describe, it, expect } from 'vitest';
import {
  hasIncompleteOptions,
  parseOptionsFromText,
  formatOptionsXml,
} from '@/gemini/utils/optionsParser';

// ============================================================================
// hasIncompleteOptions
// ============================================================================

describe('hasIncompleteOptions', () => {
  it('returns false for plain text with no options tags', () => {
    expect(hasIncompleteOptions('just some plain text')).toBe(false);
  });

  it('returns false for a complete <options> block', () => {
    const text = 'Pick one:\n<options><option>A</option></options>';
    expect(hasIncompleteOptions(text)).toBe(false);
  });

  it('returns true when <options> opener has no closer', () => {
    expect(hasIncompleteOptions('text <options><option>A</option>')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(hasIncompleteOptions('')).toBe(false);
  });

  it('is case-insensitive for the tag match', () => {
    // WHY: The regex uses the /i flag so ALLCAPS won't sneak through undetected.
    expect(hasIncompleteOptions('<OPTIONS><option>X</option>')).toBe(true);
    expect(hasIncompleteOptions('<OPTIONS><option>X</option></OPTIONS>')).toBe(false);
  });
});

// ============================================================================
// parseOptionsFromText
// ============================================================================

describe('parseOptionsFromText', () => {
  it('returns original text and empty options when no options block exists', () => {
    const input = 'Hello world';
    const result = parseOptionsFromText(input);
    expect(result.text).toBe('Hello world');
    expect(result.options).toEqual([]);
  });

  it('parses a single option', () => {
    const input = '<options><option>Yes</option></options>';
    const result = parseOptionsFromText(input);
    expect(result.options).toEqual(['Yes']);
    expect(result.text).toBe('');
  });

  it('parses multiple options in order', () => {
    const input =
      'What would you like?\n<options><option>A</option><option>B</option><option>C</option></options>';
    const result = parseOptionsFromText(input);
    expect(result.options).toEqual(['A', 'B', 'C']);
    expect(result.text).toBe('What would you like?');
  });

  it('strips the options block from the returned text', () => {
    const input = 'Preamble\n<options><option>X</option></options>\nSuffix';
    const result = parseOptionsFromText(input);
    expect(result.text).not.toContain('<options>');
    expect(result.text).not.toContain('<option>');
  });

  it('trims whitespace inside option tags', () => {
    const input = '<options><option>  spaced  </option></options>';
    const result = parseOptionsFromText(input);
    expect(result.options).toEqual(['spaced']);
  });

  it('ignores empty option tags', () => {
    // WHY: Empty options would render as blank buttons in the mobile UI.
    const input = '<options><option></option><option>Valid</option></options>';
    const result = parseOptionsFromText(input);
    expect(result.options).toEqual(['Valid']);
  });

  it('handles multiline option content', () => {
    const input = '<options>\n  <option>First choice</option>\n  <option>Second choice</option>\n</options>';
    const result = parseOptionsFromText(input);
    expect(result.options).toEqual(['First choice', 'Second choice']);
  });

  it('returns text trimmed even without options', () => {
    const result = parseOptionsFromText('  hello  ');
    expect(result.text).toBe('hello');
    expect(result.options).toEqual([]);
  });

  it('handles text that contains angle brackets but no options tag', () => {
    const input = 'Use <componentName> for rendering';
    const result = parseOptionsFromText(input);
    expect(result.text).toBe('Use <componentName> for rendering');
    expect(result.options).toEqual([]);
  });

  it('handles incomplete options block gracefully — returns no options', () => {
    // WHY: Gemini may stream a partial turn; incomplete blocks must not crash.
    const input = 'Here: <options><option>Partial';
    const result = parseOptionsFromText(input);
    expect(result.options).toEqual([]);
    // Text is returned unchanged since no complete block was found
    expect(result.text).toContain('Partial');
  });
});

// ============================================================================
// formatOptionsXml
// ============================================================================

describe('formatOptionsXml', () => {
  it('returns empty string for an empty array', () => {
    expect(formatOptionsXml([])).toBe('');
  });

  it('wraps a single option in <options> XML', () => {
    const xml = formatOptionsXml(['Yes']);
    expect(xml).toContain('<options>');
    expect(xml).toContain('<option>Yes</option>');
    expect(xml).toContain('</options>');
  });

  it('formats multiple options as individual <option> tags', () => {
    const xml = formatOptionsXml(['A', 'B', 'C']);
    expect(xml).toContain('<option>A</option>');
    expect(xml).toContain('<option>B</option>');
    expect(xml).toContain('<option>C</option>');
  });

  it('round-trips through parseOptionsFromText', () => {
    // WHY: The mobile app receives text + re-serialized XML. This round-trip
    // test ensures serialize → parse produces the same options array.
    const original = ['Option 1', 'Option 2', 'Option 3'];
    const xml = formatOptionsXml(original);
    const { options } = parseOptionsFromText(xml);
    expect(options).toEqual(original);
  });

  it('preserves option text exactly including spaces', () => {
    const xml = formatOptionsXml(['Go back to main menu']);
    expect(xml).toContain('<option>Go back to main menu</option>');
  });
});
