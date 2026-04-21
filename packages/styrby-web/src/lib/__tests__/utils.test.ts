/**
 * Tests for lib/utils.ts — cn() class-name utility
 *
 * WHY: cn() is the foundation of every component's conditional styling. A bug
 * here (wrong Tailwind conflict resolution or clsx behavior) causes broken
 * layouts across the entire dashboard without a clear failure signal.
 */

import { describe, it, expect } from 'vitest';
import { cn } from '../utils';

describe('cn', () => {
  it('returns a single class unchanged', () => {
    expect(cn('text-white')).toBe('text-white');
  });

  it('combines multiple classes', () => {
    const result = cn('flex', 'items-center', 'gap-4');
    expect(result).toBe('flex items-center gap-4');
  });

  it('handles conditional classes with truthy boolean', () => {
    const isActive = true;
    const result = cn('btn', isActive && 'btn-active');
    expect(result).toContain('btn-active');
    expect(result).toContain('btn');
  });

  it('omits conditional classes with falsy boolean', () => {
    const isActive = false;
    const result = cn('btn', isActive && 'btn-active');
    expect(result).not.toContain('btn-active');
  });

  it('resolves Tailwind class conflicts (last wins)', () => {
    // twMerge should resolve 'p-2 p-4' → 'p-4'
    const result = cn('p-2', 'p-4');
    expect(result).toBe('p-4');
    expect(result).not.toContain('p-2');
  });

  it('handles object syntax from clsx', () => {
    const result = cn({ 'text-red-500': true, 'text-blue-500': false });
    expect(result).toContain('text-red-500');
    expect(result).not.toContain('text-blue-500');
  });

  it('handles array inputs', () => {
    const result = cn(['flex', 'gap-2'], 'text-sm');
    expect(result).toContain('flex');
    expect(result).toContain('gap-2');
    expect(result).toContain('text-sm');
  });

  it('ignores null and undefined values', () => {
    const result = cn('base', null, undefined, 'extra');
    expect(result).toContain('base');
    expect(result).toContain('extra');
    expect(result).not.toContain('null');
    expect(result).not.toContain('undefined');
  });

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });

  it('resolves padding conflict: p-4 overrides px-2', () => {
    // twMerge should keep p-4 and remove conflicting px-2
    const result = cn('px-2', 'p-4');
    expect(result).toBe('p-4');
  });

  it('handles mixed conditional and static classes', () => {
    // WHY string cast: TS narrows a string literal to its exact type and
    // flags === comparisons against other literals as unreachable.
    // Casting to string keeps the runtime behaviour identical while satisfying tsc.
    const variant = 'destructive' as string;
    const result = cn(
      'inline-flex items-center rounded-md',
      variant === 'destructive' && 'bg-red-500 text-white',
      variant === 'default' && 'bg-blue-500'
    );
    expect(result).toContain('bg-red-500');
    expect(result).toContain('text-white');
    expect(result).not.toContain('bg-blue-500');
  });
});
