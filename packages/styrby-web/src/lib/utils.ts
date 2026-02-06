/**
 * Utility functions for the Styrby web dashboard.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combines class names conditionally with Tailwind CSS conflict resolution.
 *
 * WHY: shadcn/ui components pass className props that may conflict with
 * default styles. `twMerge` resolves Tailwind class conflicts (e.g.,
 * 'p-2 p-4' → 'p-4') while `clsx` handles conditional classes.
 *
 * @param inputs - Class values (strings, objects, arrays, booleans, null/undefined)
 * @returns Merged class name string with Tailwind conflicts resolved
 *
 * @example
 * cn('bg-red-500', isActive && 'bg-blue-500', 'text-white')
 * // Returns 'bg-blue-500 text-white' if isActive is true (red overridden)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
