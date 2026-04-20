/**
 * Time formatting utilities shared across mobile and web.
 *
 * WHY shared: both platforms render quiet-hours times from the same
 * `notification_preferences.quiet_hours_start` / `quiet_hours_end` columns
 * (HH:MM:SS Postgres TIME format). Centralizing the formatter prevents
 * divergence between platforms and makes tests applicable to both.
 */

/**
 * Formats a Postgres TIME string (HH:MM:SS) into a human-readable 12-hour
 * time such as "10:00 PM".
 *
 * @param time - Time string in HH:MM:SS (or HH:MM) format, or null
 * @param fallback - Value to return when `time` is null or empty
 * @returns Human-readable 12-hour time with AM/PM, or the fallback
 *
 * @example
 * formatTime('22:00:00', '--');   // "10:00 PM"
 * formatTime('07:30:00', '--');   // "7:30 AM"
 * formatTime(null, 'Not set');    // "Not set"
 */
export function formatTime(time: string | null, fallback: string): string {
  if (!time) return fallback;
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
}
