/**
 * Async render helper for component tests under React 19.
 *
 * WHY (task #85, MOBILE-TEST-OPT — un-skip the SDK 52→54 component-rendering
 * suites): Under React 19, `renderer.create(<Component/>).toJSON()` returns
 * `null` on initial render because effects are now flushed asynchronously.
 * The previous synchronous pattern that worked under React 18 + SDK 52 no
 * longer produces a meaningful tree.
 *
 * The fix: wrap in `await renderer.act(async () => {...})` to flush effects
 * before reading the tree. Centralising the pattern as a helper means we
 * don't have to repeat the cast + null-handling boilerplate in every test.
 *
 * USAGE:
 *
 *   it('renders something', async () => {
 *     const tree = await renderAsync(<MyScreen prop={value} />);
 *     expect(tree).toBeTruthy();
 *     expect(hasText(tree, 'expected copy')).toBe(true);
 *   });
 *
 * Each test must be marked `async` so the await completes before assertions
 * run. ESLint/typescript will surface missing `async` as a "await outside
 * async function" error.
 *
 * For tests that need access to the renderer instance (e.g. to update
 * props, navigate, or call instance methods), use `renderAsyncInstance`
 * which returns the renderer itself in addition to the tree.
 *
 * @module __tests__/utils/renderAsync
 */

import renderer from 'react-test-renderer';
import type React from 'react';

/**
 * Render a component and return its JSON tree, awaiting effect flush.
 *
 * @param element - The React element to render
 * @returns The rendered tree (single node, array of nodes, or null)
 */
export async function renderAsync(
  element: React.ReactElement,
): Promise<renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null> {
  let testRenderer: renderer.ReactTestRenderer | null = null;
  await renderer.act(async () => {
    // @ts-expect-error react-test-renderer typings haven't caught up to React 19 (ReactNode includes bigint)
    testRenderer = renderer.create(element);
  });
  if (!testRenderer) return null;
  return (testRenderer as renderer.ReactTestRenderer).toJSON();
}

/**
 * Render a component and return both the renderer instance AND the JSON
 * tree. Use when the test needs to call `update()`, `unmount()`, or
 * inspect the renderer's `root` property.
 *
 * @param element - The React element to render
 * @returns Object with the renderer instance and current JSON tree
 */
export async function renderAsyncInstance(
  element: React.ReactElement,
): Promise<{
  testRenderer: renderer.ReactTestRenderer;
  tree: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null;
}> {
  let testRenderer: renderer.ReactTestRenderer | null = null;
  await renderer.act(async () => {
    // @ts-expect-error react-test-renderer typings haven't caught up to React 19 (ReactNode includes bigint)
    testRenderer = renderer.create(element);
  });
  if (!testRenderer) {
    throw new Error('renderAsyncInstance: renderer.create did not produce a renderer');
  }
  const r = testRenderer as renderer.ReactTestRenderer;
  return { testRenderer: r, tree: r.toJSON() };
}
