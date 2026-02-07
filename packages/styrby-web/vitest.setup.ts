import '@testing-library/jest-dom/vitest';

/**
 * Mock DOM APIs not implemented by jsdom.
 *
 * WHY: jsdom doesn't implement scrollIntoView (or many other layout-related APIs)
 * because it has no visual rendering engine. Tests that render components calling
 * scrollIntoView would throw "not a function" errors without this stub.
 */
Element.prototype.scrollIntoView = () => {};
