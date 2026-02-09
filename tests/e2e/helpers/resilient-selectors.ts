/**
 * Resilient Selectors
 * Smart selectors with fallback strategies and auto-suggestion
 */

import { Page, Locator } from '@playwright/test';
import { createTestIdSuggestion, logFallbackUsage } from './auto-suggest';

interface ResilientOptions {
  role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'dialog' | 'heading';
  text?: string | RegExp;
  name?: string; // Accessible name
  type?: string; // Input type
  placeholder?: string | RegExp;
  timeout?: number;
}

/**
 * Get element with resilient fallback strategies
 *
 * Strategy:
 * 1. Try data-testid (primary)
 * 2. Try role + accessible name (semantic fallback)
 * 3. Try text content (last resort, logs warning)
 * 4. On failure: Generate suggestion
 *
 * @example
 * // Best case: testid exists
 * await getResilient(page, 'login-submit-button', { role: 'button', text: 'Sign In' });
 *
 * // Fallback: testid missing, uses role
 * await getResilient(page, 'nav-tasks-link', { role: 'link', text: 'Tasks' });
 */
export async function getResilient(
  page: Page,
  testId: string,
  options: ResilientOptions = {}
): Promise<Locator> {
  const { role, text, name, timeout = 5000 } = options;

  // Strategy 1: Try testid first (primary)
  try {
    const testIdLocator = page.getByTestId(testId);
    const count = await testIdLocator.count();

    if (count > 0) {
      return testIdLocator;
    }
  } catch (error) {
    // Continue to fallback
  }

  // Strategy 2: Try role + accessible name (semantic fallback)
  if (role) {
    try {
      const accessibleName = name || text;
      const roleLocator = accessibleName
        ? page.getByRole(role, { name: accessibleName })
        : page.getByRole(role);

      const count = await roleLocator.count();

      if (count > 0) {
        await logFallbackUsage('role', testId, { role, name: accessibleName });
        await createTestIdSuggestion(testId, { role, text, name });
        return roleLocator;
      }
    } catch (error) {
      // Continue to next fallback
    }
  }

  // Strategy 3: Try text content (last resort)
  if (text) {
    try {
      const textLocator = page.getByText(text);
      const count = await textLocator.count();

      if (count > 0) {
        await logFallbackUsage('text', testId, { text }, 'BRITTLE');
        await createTestIdSuggestion(testId, { role, text, name }, 'high');
        return textLocator;
      }
    } catch (error) {
      // Element not found
    }
  }

  // All strategies failed
  await createTestIdSuggestion(testId, { role, text, name }, 'critical');
  throw new Error(
    `Element not found: ${testId}\n` +
    `Tried strategies: testid → role${role ? `(${role})` : ''} → text${text ? `("${text}")` : ''}\n` +
    `Suggestion: Add data-testid="${testId}" to the element`
  );
}

/**
 * Get button with resilient fallback
 */
export async function getButton(
  page: Page,
  testId: string,
  text?: string,
  options: Omit<ResilientOptions, 'role'> = {}
): Promise<Locator> {
  return getResilient(page, testId, {
    role: 'button',
    text,
    ...options,
  });
}

/**
 * Get link with resilient fallback
 */
export async function getLink(
  page: Page,
  testId: string,
  text?: string,
  options: Omit<ResilientOptions, 'role'> = {}
): Promise<Locator> {
  return getResilient(page, testId, {
    role: 'link',
    text,
    ...options,
  });
}

/**
 * Get input with resilient fallback
 */
export async function getInput(
  page: Page,
  testId: string,
  options: Omit<ResilientOptions, 'role'> & { type?: string; placeholder?: string } = {}
): Promise<Locator> {
  return getResilient(page, testId, {
    role: 'textbox',
    ...options,
  });
}

/**
 * Get checkbox with resilient fallback
 */
export async function getCheckbox(
  page: Page,
  testId: string,
  name?: string,
  options: Omit<ResilientOptions, 'role'> = {}
): Promise<Locator> {
  return getResilient(page, testId, {
    role: 'checkbox',
    name,
    ...options,
  });
}

/**
 * Get dialog/modal with resilient fallback
 */
export async function getDialog(
  page: Page,
  testId: string,
  name?: string,
  options: Omit<ResilientOptions, 'role'> = {}
): Promise<Locator> {
  return getResilient(page, testId, {
    role: 'dialog',
    name,
    ...options,
  });
}

/**
 * Resilient click with retry and suggestion
 */
export async function resilientClick(
  page: Page,
  testId: string,
  options: ResilientOptions & { retries?: number } = {}
): Promise<void> {
  const { retries = 2, ...resilientOptions } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const element = await getResilient(page, testId, resilientOptions);
      await element.click();
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      // Wait before retry
      await page.waitForTimeout(1000);
    }
  }
}

/**
 * Resilient fill with retry and suggestion
 */
export async function resilientFill(
  page: Page,
  testId: string,
  value: string,
  options: ResilientOptions & { retries?: number } = {}
): Promise<void> {
  const { retries = 2, ...resilientOptions } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const element = await getResilient(page, testId, resilientOptions);
      await element.fill(value);
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      // Wait before retry
      await page.waitForTimeout(1000);
    }
  }
}

/**
 * Wait for element with resilient fallback
 */
export async function waitForElement(
  page: Page,
  testId: string,
  options: ResilientOptions & { state?: 'visible' | 'hidden' | 'attached' } = {}
): Promise<void> {
  const { state = 'visible', ...resilientOptions } = options;
  const element = await getResilient(page, testId, resilientOptions);
  await element.waitFor({ state });
}

/**
 * Check if element exists (non-throwing)
 */
export async function elementExists(
  page: Page,
  testId: string,
  options: ResilientOptions = {}
): Promise<boolean> {
  try {
    const element = await getResilient(page, testId, options);
    const count = await element.count();
    return count > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Resilient selector factory
 * Use for complex selectors with custom fallback logic
 */
export function createResilientSelector(
  testId: string,
  fallbackStrategies: Array<(page: Page) => Promise<Locator>>
) {
  return async (page: Page): Promise<Locator> => {
    // Try testid first
    try {
      const testIdLocator = page.getByTestId(testId);
      const count = await testIdLocator.count();
      if (count > 0) {
        return testIdLocator;
      }
    } catch (error) {
      // Continue
    }

    // Try each fallback strategy
    for (let i = 0; i < fallbackStrategies.length; i++) {
      const strategy = fallbackStrategies[i];
      try {
        const locator = await strategy(page);
        const count = await locator.count();

        if (count > 0) {
          await logFallbackUsage(`custom-${i}`, testId, {}, i === fallbackStrategies.length - 1 ? 'BRITTLE' : 'WARNING');
          await createTestIdSuggestion(testId, { customFallback: true });
          return locator;
        }
      } catch (error) {
        // Continue to next strategy
      }
    }

    // All strategies failed
    await createTestIdSuggestion(testId, { customFallback: true }, 'critical');
    throw new Error(`Element not found: ${testId} (all ${fallbackStrategies.length + 1} strategies failed)`);
  };
}
