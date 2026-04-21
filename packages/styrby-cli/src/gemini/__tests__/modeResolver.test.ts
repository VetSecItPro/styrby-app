/**
 * Tests for `resolvePermissionMode` and `resolveModel`.
 *
 * These two helpers encode the per-message override semantics — getting
 * them wrong would silently change the model or permission scope without
 * the user noticing. Every documented branch is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { resolvePermissionMode, resolveModel } from '@/gemini/utils/modeResolver';

describe('resolvePermissionMode', () => {
  it('initializes to default on first message with no meta', () => {
    const r = resolvePermissionMode(undefined, undefined);
    expect(r.forMessage).toBe('default');
    expect(r.newCurrent).toBe('default');
    expect(r.didChange).toBe(true);
    expect(r.invalid).toBe(false);
  });

  it('keeps current when meta omits permissionMode', () => {
    const r = resolvePermissionMode({}, 'yolo');
    expect(r.forMessage).toBe('yolo');
    expect(r.didChange).toBe(false);
  });

  it('accepts a valid override and marks change', () => {
    const r = resolvePermissionMode({ permissionMode: 'read-only' }, 'default');
    expect(r.forMessage).toBe('read-only');
    expect(r.newCurrent).toBe('read-only');
    expect(r.didChange).toBe(true);
    expect(r.invalid).toBe(false);
  });

  it('rejects invalid override and keeps current', () => {
    const r = resolvePermissionMode({ permissionMode: 'evil-mode' }, 'safe-yolo');
    expect(r.forMessage).toBe('safe-yolo');
    expect(r.invalid).toBe(true);
  });

  it('rejects invalid override but initializes when current is undefined', () => {
    const r = resolvePermissionMode({ permissionMode: 'bad' }, undefined);
    expect(r.forMessage).toBe('default');
    expect(r.invalid).toBe(true);
  });

  it('accepts all four valid modes', () => {
    for (const mode of ['default', 'read-only', 'safe-yolo', 'yolo'] as const) {
      const r = resolvePermissionMode({ permissionMode: mode }, undefined);
      expect(r.invalid).toBe(false);
      expect(r.forMessage).toBe(mode);
    }
  });
});

describe('resolveModel', () => {
  it('keeps current when meta is undefined', () => {
    const r = resolveModel(undefined, 'gemini-2.5-pro');
    expect(r.kind).toBe('keep');
    expect(r.forMessage).toBe('gemini-2.5-pro');
  });

  it('keeps current when meta lacks model key', () => {
    const r = resolveModel({}, 'gemini-2.5-flash');
    expect(r.kind).toBe('keep');
  });

  it('returns "reset" when model is explicit null', () => {
    const r = resolveModel({ model: null }, 'gemini-2.5-flash');
    expect(r.kind).toBe('reset');
    expect(r.forMessage).toBeUndefined();
    expect(r.newCurrent).toBeUndefined();
  });

  it('returns "change" when model is a different string', () => {
    const r = resolveModel({ model: 'gemini-2.5-flash-lite' }, 'gemini-2.5-pro');
    expect(r.kind).toBe('change');
    if (r.kind === 'change') {
      expect(r.forMessage).toBe('gemini-2.5-flash-lite');
      expect(r.previous).toBe('gemini-2.5-pro');
    }
  });

  it('returns "change" when current is undefined and a model is supplied', () => {
    const r = resolveModel({ model: 'gemini-2.5-pro' }, undefined);
    expect(r.kind).toBe('change');
  });

  it('returns "noop" when model matches current', () => {
    const r = resolveModel({ model: 'gemini-2.5-pro' }, 'gemini-2.5-pro');
    expect(r.kind).toBe('noop');
    expect(r.forMessage).toBe('gemini-2.5-pro');
  });

  it('treats meta.model === undefined (key present, value undefined) as keep', () => {
    const r = resolveModel({ model: undefined }, 'gemini-2.5-flash');
    expect(r.kind).toBe('keep');
  });

  it('treats empty string model as keep (falsy non-null)', () => {
    const r = resolveModel({ model: '' }, 'gemini-2.5-flash');
    // Empty string is falsy and not null — original code's `meta.model || null`
    // path would fall to the keep branch in our resolver.
    expect(r.kind).toBe('keep');
  });
});
