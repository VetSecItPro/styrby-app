/**
 * Accessibility regression guard (Cluster C3).
 *
 * Screen readers (VoiceOver / TalkBack) announce an interactive element using
 * its accessibility props. A raw `<Pressable>` / `<TouchableOpacity>` with no
 * `accessibilityRole` / `accessibilityLabel` is announced as an unlabeled
 * "button" (or not at all), which is the single most common mobile-a11y defect.
 *
 * The app already routes most interactions through accessible UI primitives
 * (e.g. SettingRow sets role+label once for every settings row). This test
 * guards the REMAINDER: any file that drops to a RAW touchable must reference
 * at least one accessibility prop, so a new screen can't ship a bare,
 * unlabeled control. It is a file-level guard (not per-element) on purpose —
 * raw layout-wrapper Pressables (e.g. tap-outside-to-dismiss backdrops) are
 * legitimate, so we only require that a file using raw touchables engages with
 * accessibility somewhere rather than ignoring it entirely.
 *
 * Caught real gaps when added (2026-06-12): costs, AgentSelector,
 * SessionCarousel, NotificationStream all had raw Pressables with no a11y.
 *
 * @module __tests__/a11y-touchables
 */

// WHY no vitest import: styrby-mobile uses Jest (not vitest). Jest globals
// (describe/it/expect) are available without import.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const MOBILE_ROOT = resolve(__dirname, '../..');
const SCAN_DIRS = ['app', 'src/components'];

/** Files using a RAW touchable. */
const RAW_TOUCHABLE = /<\s*(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b/;

/** Any accessibility prop / RN a11y API. */
const A11Y_REFERENCE =
  /accessibilityRole|accessibilityLabel|accessibilityHint|accessibilityState|accessibilityValue|accessible\s*=|importantForAccessibility|accessibilityElementsHidden/;

/** Recursively collect .tsx files under a directory, skipping tests. */
function collectTsx(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out = out.concat(collectTsx(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('mobile a11y — raw touchables carry accessibility props', () => {
  const files = SCAN_DIRS.flatMap((d) => collectTsx(resolve(MOBILE_ROOT, d)));

  it('scans a non-trivial number of component files (guard is actually running)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every file using a raw Pressable/Touchable references an accessibility prop', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      if (RAW_TOUCHABLE.test(src) && !A11Y_REFERENCE.test(src)) {
        offenders.push(file.replace(MOBILE_ROOT + '/', ''));
      }
    }
    if (offenders.length > 0) {
      // Surface the actionable guidance; the assertion below prints the list.
      console.error(
        'Files using a raw touchable with NO accessibility prop. Add ' +
          'accessibilityRole + accessibilityLabel (or use an accessible primitive ' +
          `like SettingRow):\n${offenders.join('\n')}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
