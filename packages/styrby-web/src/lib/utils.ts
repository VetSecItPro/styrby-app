/**
 * Utility functions for the Styrby web dashboard.
 */

/**
 * Combines class names conditionally, filtering out falsy values.
 * A simple alternative to clsx/classnames for basic use cases.
 *
 * @param classes - Class name strings (falsy values are filtered out)
 * @returns Combined class name string
 *
 * @example
 * cn('base-class', isActive && 'active', 'another-class')
 * // Returns 'base-class active another-class' if isActive is true
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
