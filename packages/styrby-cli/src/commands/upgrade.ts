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
  const installCmd = `${pm} install -g styrby-cli@latest`;

  try {
    execSync(installCmd, {
      stdio: 'inherit',
      encoding: 'utf-8',
    });

    console.log('');
    console.log(chalk.green('Updated successfully!'));
    console.log(chalk.gray(`Installed version: ${latestVersion}`));
    console.log('');
    console.log(chalk.gray('Restart your terminal or run: exec $SHELL'));
  } catch (error) {
    console.log('');
    console.log(chalk.red('Failed to update.'));
    console.log('');
    console.log(chalk.gray('Try manually with:'));
    console.log(chalk.gray(`  ${installCmd}`));

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
