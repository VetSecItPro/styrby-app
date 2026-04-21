/**
 * Pure helpers used by settings sub-components.
 *
 * WHY: Extracted from settings-client.tsx to enable unit-level test coverage
 * and to prevent duplication if more settings areas need base64url handling
 * (e.g., future WebAuthn credential encoding paths).
 */

/**
 * Converts a base64url-encoded string to a Uint8Array.
 *
 * WHY: The Push API's subscribe() method requires the applicationServerKey
 * as a Uint8Array, but VAPID public keys are distributed as base64url strings.
 * This conversion handles the base64url-to-standard-base64 translation and
 * then decodes into a byte array.
 *
 * @param base64String - A base64url-encoded VAPID public key
 * @returns The decoded key as a Uint8Array for the Push API
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
