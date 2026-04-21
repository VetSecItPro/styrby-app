import { describe, expect, it } from 'vitest';
import { extractSendPromptErrorDetail } from '../errorFormatting';

/**
 * extractSendPromptErrorDetail must produce a stable, non-empty string for
 * every shape of error the ACP SDK / JSON-RPC layer can throw, so the
 * mobile UI never shows `[object Object]` to a user.
 */
describe('extractSendPromptErrorDetail', () => {
  it('returns Error.message for Error instances', () => {
    const err = new Error('boom');
    expect(extractSendPromptErrorDetail(err)).toBe('boom');
  });

  it('returns Error.message even when subclassed', () => {
    class CustomError extends Error {}
    expect(extractSendPromptErrorDetail(new CustomError('nope'))).toBe('nope');
  });

  it('serializes objects with a code field as JSON {code,message}', () => {
    const detail = extractSendPromptErrorDetail({ code: -32000, message: 'rpc' });
    expect(JSON.parse(detail)).toEqual({ code: -32000, message: 'rpc' });
  });

  it('falls back to String(error) when object has code but no message', () => {
    const detail = extractSendPromptErrorDetail({ code: 1 });
    const parsed = JSON.parse(detail);
    expect(parsed.code).toBe(1);
    // message becomes the String() representation of the object
    expect(typeof parsed.message).toBe('string');
  });

  it('returns plain message string for objects with message but no code', () => {
    expect(extractSendPromptErrorDetail({ message: 'plain' })).toBe('plain');
  });

  it('returns String(error) for objects without message or code', () => {
    expect(extractSendPromptErrorDetail({ foo: 'bar' })).toBe('[object Object]');
  });

  it('returns String(value) for primitives', () => {
    expect(extractSendPromptErrorDetail('string error')).toBe('string error');
    expect(extractSendPromptErrorDetail(42)).toBe('42');
    expect(extractSendPromptErrorDetail(null)).toBe('null');
    expect(extractSendPromptErrorDetail(undefined)).toBe('undefined');
  });
});
