/**
 * Module augmentation for expo-passkey.
 *
 * WHY this file: The package's top-level `expo-passkey` entry (`build/index.d.ts`)
 * is a guard-rail stub that only exports `expoPasskeyClient: never` and tells
 * consumers to use subpath imports (`expo-passkey/native` or `/web`). Metro
 * (pre-0.82) cannot resolve those subpaths because it ignores the package's
 * `exports` map, so our runtime code imports from the bare `expo-passkey`
 * specifier and relies on Metro's platform-aware resolution to pick up
 * `build/index.native.js` automatically.
 *
 * This file declares the runtime shape that the native entry actually exposes
 * so TypeScript agrees with Metro's runtime resolution.
 *
 * Delete this file when:
 *   - Metro enables `unstable_enablePackageExports` by default, OR
 *   - expo-passkey ships a unified top-level entry, OR
 *   - we migrate to a different WebAuthn mobile library.
 */

declare module 'expo-passkey' {
  /**
   * Native Turbo/Expo module implementing WebAuthn L3 ceremonies on iOS and
   * Android. Both methods accept an object containing a JSON-stringified
   * WebAuthn request and return a Promise resolving to a JSON-stringified
   * WebAuthn credential response.
   */
  interface ExpoPasskeyModule {
    /**
     * Returns true if the current device supports platform passkeys.
     */
    isPasskeySupported(): boolean;

    /**
     * Creates a new passkey (WebAuthn registration ceremony).
     * @param options - `{ requestJson }` where requestJson is a JSON-stringified
     *                  PublicKeyCredentialCreationOptions.
     * @returns A JSON string of the attestation credential.
     */
    createPasskey(options: { requestJson: string }): Promise<string>;

    /**
     * Authenticates with an existing passkey (WebAuthn assertion ceremony).
     * @param options - `{ requestJson }` where requestJson is a JSON-stringified
     *                  PublicKeyCredentialRequestOptions.
     * @returns A JSON string of the assertion credential.
     */
    authenticateWithPasskey(options: { requestJson: string }): Promise<string>;
  }

  const ExpoPasskey: ExpoPasskeyModule;
  export default ExpoPasskey;
}
