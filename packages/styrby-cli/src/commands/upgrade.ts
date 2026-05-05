/**
 * Upgrade Command Handler
 *
 * Handles the `styrby upgrade` command which checks for and installs CLI updates.
 * Fetches the latest version from npm registry and compares with the current version.
 *
 * @module commands/upgrade
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { logger } from '@/ui/logger';
import { VERSION } from '@/index';

/** npm registry URL for fetching the latest package info. */
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/styrby-cli/latest';

/** Timeout for npm registry fetch in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Compare two semver version strings.
 *
 * @param current - Current version (e.g., "0.1.0")
 * @param latest - Latest version from registry (e.g., "0.2.0")
 * @returns -1 if current < latest, 0 if equal, 1 if current > latest
 */
function compareVersions(current: string, latest: string): number {
  const parseSemver = (v: string): number[] => {
    return v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  };

  const currentParts = parseSemver(current);
  const latestParts = parseSemver(latest);

  for (let i = 0; i < 3; i++) {
    const c = currentParts[i] ?? 0;
    const l = latestParts[i] ?? 0;
    if (c < l) return -1;
    if (c > l) return 1;
  }

  return 0;
}

/**
 * Fetch the latest version from npm registry.
 *
 * @returns Promise resolving to the latest version string, or null if fetch fails
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.debug('npm registry responded with non-OK status', {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const data = await response.json() as { version?: string };
    return data.version ?? null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.debug('npm registry fetch timed out');
    } else {
      logger.debug('Failed to fetch from npm registry', { error });
    }
    return null;
  }
}

/**
 * Read the locally-installed npm CLI version (e.g. "10.5.2").
 *
 * Returns null when npm is not available on PATH or the call fails for any
 * reason. Callers MUST treat null as "unknown" — do not assume an old or
 * new version when this returns null.
 *
 * WHY (ESC-4): Provenance verification (`--foreground-scripts=false`,
 * `dist.attestations` field) requires npm >= 10. Older npms silently ignore
 * the flag and never publish provenance, so we have to branch on version.
 *
 * @returns Parsed npm version string, or null on failure
 */
export function getNpmVersion(): string | null {
  try {
    const out = execSync('npm --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const version = out.trim();
    // Reject anything that doesn't look like semver — a malformed reply
    // from a wrapper script could otherwise short-circuit our gating.
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return null;
    }
    return version;
  } catch {
    return null;
  }
}

/**
 * Test whether `npmVersion` (semver string) is >= `minMajor.0.0`.
 *
 * @param npmVersion - Version string from `npm --version`
 * @param minMajor - Minimum major version required
 * @returns true when npm meets the minimum, false otherwise
 */
export function npmAtLeast(npmVersion: string | null, minMajor: number): boolean {
  if (!npmVersion) return false;
  const major = parseInt(npmVersion.split('.')[0] ?? '0', 10);
  return major >= minMajor;
}

/**
 * Verify that the freshly-installed package version was published with npm
 * provenance attestations.
 *
 * WHY (ESC-4 — defensive, non-blocking): npm 10+ publishes signed
 * attestations linking a package version to the git commit + CI workflow
 * that built it. The presence of `dist.attestations` in the registry
 * response signals the operator that the published artifact is verifiable.
 * This function does NOT cryptographically verify the attestation — that
 * happens implicitly during install when npm is configured to enforce
 * `--audit-signatures`. This is purely a transparency check the operator
 * can trust at a glance.
 *
 * @param latestVersion - Version we just attempted to install (for logging only)
 * @returns true if attestations are present, false otherwise (incl. errors)
 */
export function verifyProvenance(latestVersion: string): boolean {
  try {
    const out = execSync(`npm view styrby-cli@${latestVersion} --json`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(out) as { dist?: { attestations?: unknown } };
    return Boolean(data?.dist?.attestations);
  } catch (error) {
    logger.debug('Provenance lookup failed', { error });
    return false;
  }
}

/**
 * Determine the package manager used for global installs.
 *
 * @returns The package manager command to use ('npm', 'pnpm', or 'yarn')
 */
function detectPackageManager(): string {
  // Check if we were installed via a specific package manager
  // by looking at common indicators
  try {
    const npmRoot = execSync('npm root -g 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (npmRoot.includes('styrby-cli')) {
      return 'npm';
    }
  } catch {
    // npm not available or command failed
  }

  // Default to npm as it's most common
  return 'npm';
}

/**
 * Handle the `styrby upgrade` command.
 *
 * Checks the npm registry for the latest version and installs it if newer.
 * Supports a --check flag to only check without installing.
 *
 * @param args - Command arguments (--check to only check, don't install)
 * @returns Promise that resolves when the command completes
 *
 * @example
 * // Check and install updates
 * styrby upgrade
 *
 * // Only check for updates (don't install)
 * styrby upgrade --check
 */
export async function handleUpgrade(args: string[]): Promise<void> {
  const checkOnly = args.includes('--check') || args.includes('-c');

  console.log(chalk.blue('Checking for updates...'));

  const latestVersion = await fetchLatestVersion();

  if (!latestVersion) {
    console.log(chalk.yellow('Could not check for updates.'));
    console.log(chalk.gray('You can manually update with: npm install -g styrby-cli@latest'));
    return;
  }

  const comparison = compareVersions(VERSION, latestVersion);

  if (comparison >= 0) {
    console.log(chalk.green(`You're on the latest version (${VERSION})`));
    return;
  }

  // Update available
  console.log(chalk.yellow(`Update available: ${VERSION} -> ${latestVersion}`));

  if (checkOnly) {
    console.log('');
    console.log(chalk.gray('To update, run: styrby upgrade'));
    console.log(chalk.gray('Or manually: npm install -g styrby-cli@latest'));
    return;
  }

  // Perform the update
  console.log(chalk.blue('Installing update...'));

  const pm = detectPackageManager();
  const baseInstallCmd = `${pm} install -g styrby-cli@latest`;

  // ESC-4: npm-version-aware install with provenance signalling.
  // WHY: Older npm (<10) silently ignores --foreground-scripts=false and
  // never publishes/serves provenance attestations. Branching on the version
  // up-front avoids confusing operator output ("attestations missing!" when
  // the npm version simply can't surface them).
  const npmVersion = getNpmVersion();
  const supportsProvenance = npmAtLeast(npmVersion, 10);

  let installCmd = baseInstallCmd;
  if (supportsProvenance) {
    // WHY --foreground-scripts=false: prevents the install from inheriting
    // a tty for arbitrary post-install scripts. If the registry serves a
    // tampered package, the post-install script can't ask for sudo prompts
    // or steal terminal focus to phish credentials. The flag is npm 10+.
    installCmd = `${baseInstallCmd} --foreground-scripts=false`;
  } else if (npmVersion) {
    console.log(
      chalk.yellow(
        `Update integrity check unavailable on npm ${npmVersion}. Consider upgrading npm.`
      )
    );
  }

  /**
   * Run the install. Returns true on success, false when the
   * --foreground-scripts flag was rejected (so the caller can fall back).
   */
  const tryInstall = (cmd: string): boolean => {
    try {
      execSync(cmd, { stdio: 'inherit', encoding: 'utf-8' });
      return true;
    } catch (err) {
      // Detect the specific "unknown flag" failure so we can fall back.
      const stderr = err instanceof Error ? err.message : String(err);
      if (cmd.includes('--foreground-scripts=false') && /unknown|unrecognized|invalid/i.test(stderr)) {
        return false;
      }
      throw err;
    }
  };

  try {
    let installed = tryInstall(installCmd);

    if (!installed && installCmd !== baseInstallCmd) {
      // Fallback: drop the hardening flag and try again.
      console.log(
        chalk.yellow(
          'npm rejected --foreground-scripts=false; falling back to plain install.'
        )
      );
      installed = tryInstall(baseInstallCmd);
    }

    if (!installed) {
      throw new Error('install failed');
    }

    console.log('');
    console.log(chalk.green('Updated successfully!'));
    console.log(chalk.gray(`Installed version: ${latestVersion}`));

    if (supportsProvenance) {
      const hasProvenance = verifyProvenance(latestVersion);
      if (hasProvenance) {
        console.log(chalk.green('Provenance: verified (npm attestations present).'));
      } else {
        console.log(
          chalk.yellow(
            'Provenance: no attestations found for this version. Update is installed but cannot be cryptographically verified against the source repo.'
          )
        );
      }
    }

    console.log('');
    console.log(chalk.gray('Restart your terminal or run: exec $SHELL'));
  } catch (error) {
    console.log('');
    console.log(chalk.red('Failed to update.'));
    console.log('');
    console.log(chalk.gray('Try manually with:'));
    console.log(chalk.gray(`  ${baseInstallCmd}`));

    if (process.platform !== 'win32') {
      console.log('');
      console.log(chalk.gray('If you get permission errors:'));
      console.log(chalk.gray('  sudo npm install -g styrby-cli@latest'));
    }

    logger.debug('Upgrade failed', { error });
    process.exit(1);
  }
}

export default { handleUpgrade };
