/**
 * Pure header-string parsing for the OTEL settings form.
 *
 * Extracted from otel-settings.tsx (Cluster A2 split). The auth-headers
 * textarea holds a JSON object; this is the single place that text becomes a
 * Record. Kept pure + tested so the "empty vs malformed" distinction the save
 * handler relies on can't silently drift.
 *
 * @module components/dashboard/otel-settings/parse-headers
 */

/**
 * Parse the raw headers textarea value into a Record<string, string>.
 *
 * Returns an empty object for both an empty input and a parse error. Callers
 * distinguish the two by checking whether the raw string was non-empty: a
 * non-empty raw string that yields `{}` means malformed JSON (surfaced as a
 * validation error), whereas an empty raw string legitimately means "no
 * headers".
 *
 * @param raw - The textarea contents.
 * @returns Parsed headers, or `{}` when empty or malformed.
 */
export function parseHeaders(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Malformed JSON — validation surfaces this to the user.
  }
  return {};
}
