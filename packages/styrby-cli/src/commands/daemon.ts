/**
 * Daemon Management Commands
 *
 * Handles `styrby daemon install`, `styrby daemon uninstall`, and
 * `styrby daemon install --refresh-install` for setting up auto-start on boot.
 * Supports macOS (LaunchAgent) and Linux (systemd user service).
 *
 * WHY: Auto-start ensures the Styrby daemon is always available, so the mobile app
 * can reach the machine even after a reboot. This is essential for a seamless
 * remote control experience.
 *
 * @module commands/daemon
 */

import { homedir, platform } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { logger } from '@/ui/logger';

// ============================================================================
// Constants
// ============================================================================

/** LaunchAgent plist label for macOS. */
const MACOS_LABEL = 'com.styrby.daemon';

/** LaunchAgent plist file path. */
const MACOS_PLIST_PATH = path.join(homedir(), 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`);

/** systemd user service file path for Linux. */
const LINUX_SERVICE_PATH = path.join(homedir(), '.config', 'systemd', 'user', 'styrby-daemon.service');

// ============================================================================
// Public API
// ============================================================================

/**
 * Handle the `styrby daemon` command.
 *
 * Routes to install, uninstall, or usage based on the subcommand.
 *
 * Supports `--refresh-install` flag on `install` to regenerate the service file
 * with the current environment variables without a full uninstall/reinstall cycle.
 *
 * @param args - Command arguments (subcommand: install, uninstall, status; optional flags: --refresh-install)
 * @returns Promise that resolves when the command completes
 */
export async function handleDaemon(args: string[]): Promise<void> {
  const subCommand = args[0];
  const isRefresh = args.includes('--refresh-install');

  switch (subCommand) {
    case 'install':
      await handleDaemonInstall(isRefresh);
      break;

    case 'uninstall':
    case 'remove':
      await handleDaemonUninstall();
      break;

    case 'status':
      await handleDaemonServiceStatus();
      break;

    default:
      printDaemonUsage();
      break;
  }
}

/**
 * Install the daemon to start automatically on boot.
 *
 * On macOS: Creates a LaunchAgent plist and loads it.
 * On Linux: Creates a systemd user service and enables it.
 *
 * @param refreshOnly - When true, regenerates the service file and reloads without
 *   a full uninstall. Use after updating SUPABASE_URL / SUPABASE_ANON_KEY in the
 *   shell environment so the new values are baked into the service file immediately.
 * @returns Promise that resolves when installation completes
 */
export async function handleDaemonInstall(refreshOnly = false): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    await installMacOSLaunchAgent(refreshOnly);
  } else if (os === 'linux') {
    await installLinuxSystemdService(refreshOnly);
  } else {
    console.log(chalk.yellow(`Auto-start not supported on ${os}`));
    console.log(chalk.gray('You can manually start the daemon with: styrby start --daemon'));
  }
}

/**
 * Uninstall the daemon from auto-start.
 *
 * On macOS: Unloads and removes the LaunchAgent plist.
 * On Linux: Stops, disables, and removes the systemd user service.
 *
 * @returns Promise that resolves when uninstallation completes
 */
export async function handleDaemonUninstall(): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    await uninstallMacOSLaunchAgent();
  } else if (os === 'linux') {
    await uninstallLinuxSystemdService();
  } else {
    console.log(chalk.yellow(`Auto-start not supported on ${os}`));
  }
}

// ============================================================================
// macOS LaunchAgent
// ============================================================================

/**
 * Build the plist XML entries for env vars that should be baked into the LaunchAgent.
 *
 * WHY: LaunchAgents on macOS launch before any shell profile (.zshrc, .zprofile)
 * is sourced. Without baking SUPABASE_URL and SUPABASE_ANON_KEY directly into the
 * plist EnvironmentVariables dict, process.env in the daemon is empty on fresh boot
 * and the daemon transitions straight to connectionState = 'error'.
 *
 * Missing vars are omitted with a warning so the plist remains valid XML even when
 * the caller has not yet run `styrby onboard`.
 *
 * @returns Plist XML string for the EnvironmentVariables dict body (indented, no outer <dict> tags)
 */
function buildPlistEnvEntries(): string {
  const required: Array<{ key: string; envVar: string }> = [
    { key: 'SUPABASE_URL', envVar: 'SUPABASE_URL' },
    { key: 'SUPABASE_ANON_KEY', envVar: 'SUPABASE_ANON_KEY' },
  ];

  const lines: string[] = [
    '    <key>PATH</key>',
    '    <string>/usr/local/bin:/usr/bin:/bin</string>',
  ];

  for (const { key, envVar } of required) {
    const value = process.env[envVar];
    if (value) {
      lines.push(`    <key>${key}</key>`);
      // Escape XML special chars so the plist stays well-formed
      lines.push(`    <string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`);
    } else {
      logger.debug(`Warning: ${envVar} not found in environment — not baked into plist. Run 'styrby daemon install --refresh-install' after setting it.`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate the LaunchAgent plist content for macOS.
 *
 * WHY: LaunchAgent plists let macOS run a process on login without
 * requiring root access or running as a full system service.
 * SUPABASE_URL and SUPABASE_ANON_KEY are baked in at install time so the daemon
 * can connect on a fresh boot before any shell profile is sourced.
 *
 * @returns Plist XML string
 */
function generateMacOSPlist(): string {
  // Find the styrby executable
  const styrbyPath = process.argv[1];
  const nodePath = process.execPath;
  const logDir = path.join(homedir(), '.styrby');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${styrbyPath}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${logDir}/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>${logDir}/daemon.error.log</string>

  <key>WorkingDirectory</key>
  <string>${homedir()}</string>

  <key>EnvironmentVariables</key>
  <dict>
${buildPlistEnvEntries()}
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
`;
}

/**
 * Install the LaunchAgent on macOS.
 *
 * @param refreshOnly - When true, regenerates plist + reloads without printing full
 *   install success messaging. Exits early with a warning if the plist is not
 *   already installed (refresh assumes prior install).
 */
async function installMacOSLaunchAgent(refreshOnly = false): Promise<void> {
  if (refreshOnly) {
    if (!fs.existsSync(MACOS_PLIST_PATH)) {
      console.log(chalk.yellow('No existing daemon install found. Run `styrby daemon install` first.'));
      return;
    }
    console.log(chalk.blue('Refreshing Styrby daemon plist with current environment...'));
  } else {
    console.log(chalk.blue('Installing Styrby daemon for macOS...'));
  }

  // Ensure LaunchAgents directory exists
  const launchAgentsDir = path.dirname(MACOS_PLIST_PATH);
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Unload existing service if present
  if (fs.existsSync(MACOS_PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${MACOS_PLIST_PATH}" 2>/dev/null`, { encoding: 'utf-8' });
      logger.debug('Unloaded existing LaunchAgent');
    } catch {
      // May not be loaded
    }
  }

  // Write plist
  const plist = generateMacOSPlist();
  fs.writeFileSync(MACOS_PLIST_PATH, plist, { mode: 0o644 });
  logger.debug('Wrote LaunchAgent plist', { path: MACOS_PLIST_PATH });

  // Load the service
  try {
    execSync(`launchctl load "${MACOS_PLIST_PATH}"`, { encoding: 'utf-8' });

    if (refreshOnly) {
      console.log(chalk.green('Daemon plist refreshed and reloaded'));
      console.log(chalk.gray('New environment variables are now active.'));
    } else {
      console.log(chalk.green('Daemon installed and started'));
      console.log('');
      console.log(chalk.gray('The daemon will now start automatically on login.'));
      console.log(chalk.gray(`Plist location: ${MACOS_PLIST_PATH}`));
      console.log('');
      console.log(chalk.gray('To uninstall: styrby daemon uninstall'));
      console.log(chalk.gray('To check status: styrby status'));
    }
  } catch (error) {
    console.log(chalk.red('Failed to load LaunchAgent'));
    if (error instanceof Error) {
      console.log(chalk.red(error.message));
    }
    logger.error('Failed to load LaunchAgent', { error });
    process.exit(1);
  }
}

/**
 * Uninstall the LaunchAgent on macOS.
 */
async function uninstallMacOSLaunchAgent(): Promise<void> {
  if (!fs.existsSync(MACOS_PLIST_PATH)) {
    console.log(chalk.yellow('No daemon installed'));
    return;
  }

  console.log(chalk.blue('Uninstalling Styrby daemon...'));

  // Unload the service
  try {
    execSync(`launchctl unload "${MACOS_PLIST_PATH}" 2>/dev/null`, { encoding: 'utf-8' });
    logger.debug('Unloaded LaunchAgent');
  } catch {
    // May already be unloaded
  }

  // Remove the plist file
  try {
    fs.unlinkSync(MACOS_PLIST_PATH);
    console.log(chalk.green('Daemon uninstalled'));
    console.log('');
    console.log(chalk.gray('The daemon will no longer start on login.'));
    console.log(chalk.gray('To reinstall: styrby daemon install'));
  } catch (error) {
    console.log(chalk.red('Failed to remove plist file'));
    if (error instanceof Error) {
      console.log(chalk.red(error.message));
    }
    process.exit(1);
  }
}

// ============================================================================
// Linux systemd
// ============================================================================

/**
 * Build the `Environment=` directives for the systemd unit file.
 *
 * WHY: systemd user services launch outside the user's shell session, so
 * SUPABASE_URL and SUPABASE_ANON_KEY are unavailable unless explicitly baked in
 * via Environment= directives at install time.
 *
 * Missing vars are omitted with a warning so the unit file remains valid even when
 * the caller has not yet run `styrby onboard`.
 *
 * @returns Newline-separated `Environment="KEY=value"` lines (empty string if no vars found)
 */
function buildSystemdEnvDirectives(): string {
  const required: Array<{ envVar: string }> = [
    { envVar: 'SUPABASE_URL' },
    { envVar: 'SUPABASE_ANON_KEY' },
  ];

  const lines: string[] = [];

  for (const { envVar } of required) {
    const value = process.env[envVar];
    if (value) {
      // Systemd Environment= values with spaces must be quoted; always quote for safety.
      lines.push(`Environment="${envVar}=${value}"`);
    } else {
      logger.debug(`Warning: ${envVar} not found in environment — not baked into systemd unit. Run 'styrby daemon install --refresh-install' after setting it.`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate the systemd user service unit file for Linux.
 *
 * WHY: systemd user services run under the user's session without root,
 * and can be configured to start on login via lingering.
 * SUPABASE_URL and SUPABASE_ANON_KEY are baked in at install time so the daemon
 * can connect on a fresh boot before any shell profile is sourced.
 *
 * @returns Service unit file content
 */
function generateLinuxServiceFile(): string {
  const styrbyPath = process.argv[1];
  const nodePath = process.execPath;
  const extraEnv = buildSystemdEnvDirectives();

  return `[Unit]
Description=Styrby Daemon - Mobile Remote Control for AI Coding Agents
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${styrbyPath} start --daemon
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

# Environment
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=${homedir()}
${extraEnv ? `${extraEnv}\n` : ''}
# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${homedir()}/.styrby

[Install]
WantedBy=default.target
`;
}

/**
 * Install the systemd user service on Linux.
 *
 * @param refreshOnly - When true, regenerates the unit file + reloads/restarts without
 *   printing full install success messaging. Exits early with a warning if the service
 *   file is not already present (refresh assumes prior install).
 */
async function installLinuxSystemdService(refreshOnly = false): Promise<void> {
  if (refreshOnly) {
    if (!fs.existsSync(LINUX_SERVICE_PATH)) {
      console.log(chalk.yellow('No existing daemon install found. Run `styrby daemon install` first.'));
      return;
    }
    console.log(chalk.blue('Refreshing Styrby daemon service file with current environment...'));
  } else {
    console.log(chalk.blue('Installing Styrby daemon for Linux...'));
  }

  // Ensure systemd user directory exists
  const serviceDir = path.dirname(LINUX_SERVICE_PATH);
  if (!fs.existsSync(serviceDir)) {
    fs.mkdirSync(serviceDir, { recursive: true });
  }

  // Stop existing service if running
  try {
    execSync('systemctl --user stop styrby-daemon 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    // May not be running
  }

  // Write service file
  const serviceContent = generateLinuxServiceFile();
  fs.writeFileSync(LINUX_SERVICE_PATH, serviceContent, { mode: 0o644 });
  logger.debug('Wrote systemd service file', { path: LINUX_SERVICE_PATH });

  // Reload systemd daemon
  try {
    execSync('systemctl --user daemon-reload', { encoding: 'utf-8' });
    logger.debug('Reloaded systemd user daemon');
  } catch (error) {
    console.log(chalk.red('Failed to reload systemd'));
    if (error instanceof Error) {
      console.log(chalk.red(error.message));
    }
    process.exit(1);
  }

  // Enable and start (or restart on refresh) the service
  try {
    if (refreshOnly) {
      execSync('systemctl --user restart styrby-daemon', { encoding: 'utf-8' });
      console.log(chalk.green('Daemon service file refreshed and restarted'));
      console.log(chalk.gray('New environment variables are now active.'));
    } else {
      execSync('systemctl --user enable styrby-daemon', { encoding: 'utf-8' });
      execSync('systemctl --user start styrby-daemon', { encoding: 'utf-8' });
      console.log(chalk.green('Daemon installed and started'));
      console.log('');
      console.log(chalk.gray('The daemon will start automatically on login.'));
      console.log(chalk.gray(`Service file: ${LINUX_SERVICE_PATH}`));
      console.log('');
      console.log(chalk.gray('To enable lingering (start before login):'));
      console.log(chalk.gray('  loginctl enable-linger $USER'));
      console.log('');
      console.log(chalk.gray('To uninstall: styrby daemon uninstall'));
      console.log(chalk.gray('To check status: systemctl --user status styrby-daemon'));
    }
  } catch (error) {
    console.log(chalk.red(refreshOnly ? 'Failed to restart service' : 'Failed to enable or start service'));
    if (error instanceof Error) {
      console.log(chalk.red(error.message));
    }
    logger.error('Failed to start systemd service', { error });
    process.exit(1);
  }
}

/**
 * Uninstall the systemd user service on Linux.
 */
async function uninstallLinuxSystemdService(): Promise<void> {
  // Stop the service
  try {
    execSync('systemctl --user stop styrby-daemon 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    // May not be running
  }

  // Disable the service
  try {
    execSync('systemctl --user disable styrby-daemon 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    // May not be enabled
  }

  // Remove the service file
  if (fs.existsSync(LINUX_SERVICE_PATH)) {
    fs.unlinkSync(LINUX_SERVICE_PATH);
    console.log(chalk.green('Daemon uninstalled'));
  } else {
    console.log(chalk.yellow('No daemon installed'));
    return;
  }

  // Reload systemd
  try {
    execSync('systemctl --user daemon-reload', { encoding: 'utf-8' });
  } catch {
    // Best effort
  }

  console.log('');
  console.log(chalk.gray('The daemon will no longer start on login.'));
  console.log(chalk.gray('To reinstall: styrby daemon install'));
}

// ============================================================================
// Status
// ============================================================================

/**
 * Show the status of the auto-start service.
 */
async function handleDaemonServiceStatus(): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    // Check if plist exists
    if (!fs.existsSync(MACOS_PLIST_PATH)) {
      console.log(chalk.yellow('Daemon not installed'));
      console.log(chalk.gray('Install with: styrby daemon install'));
      return;
    }

    // Check if loaded
    // WHY: Previously used execSync(`launchctl list | grep ${MACOS_LABEL}`) which
    // passes a shell-interpolated string through /bin/sh. Even though MACOS_LABEL
    // is currently a hardcoded constant, the pattern is unsafe: if the label ever
    // becomes config-driven, it opens a shell-injection vector. Using spawnSync
    // with an explicit argv array (no shell) and filtering stdout in JS eliminates
    // the shell entirely. (sec H-04)
    try {
      const { stdout, status } = spawnSync('launchctl', ['list'], { encoding: 'utf-8' });
      const loaded = status === 0 && stdout.split('\n').some(line => line.includes(MACOS_LABEL));
      if (loaded) {
        console.log(chalk.green('Daemon installed and loaded'));
        console.log(chalk.gray(`Plist: ${MACOS_PLIST_PATH}`));
      } else {
        console.log(chalk.yellow('Daemon installed but not loaded'));
        console.log(chalk.gray('Try: launchctl load ' + MACOS_PLIST_PATH));
      }
    } catch {
      console.log(chalk.yellow('Daemon installed but not loaded'));
      console.log(chalk.gray('Try: launchctl load ' + MACOS_PLIST_PATH));
    }
  } else if (os === 'linux') {
    // Check if service file exists
    if (!fs.existsSync(LINUX_SERVICE_PATH)) {
      console.log(chalk.yellow('Daemon not installed'));
      console.log(chalk.gray('Install with: styrby daemon install'));
      return;
    }

    // Check service status
    try {
      const result = execSync('systemctl --user is-active styrby-daemon', { encoding: 'utf-8' }).trim();
      if (result === 'active') {
        console.log(chalk.green('Daemon installed and running'));
      } else {
        console.log(chalk.yellow(`Daemon installed but ${result}`));
      }
      console.log(chalk.gray(`Service file: ${LINUX_SERVICE_PATH}`));
      console.log(chalk.gray('For details: systemctl --user status styrby-daemon'));
    } catch {
      console.log(chalk.yellow('Daemon installed but not active'));
      console.log(chalk.gray('Try: systemctl --user start styrby-daemon'));
    }
  } else {
    console.log(chalk.yellow(`Auto-start not supported on ${os}`));
  }
}

// ============================================================================
// Usage
// ============================================================================

/**
 * Print usage information for the daemon command.
 */
function printDaemonUsage(): void {
  console.log(`
${chalk.bold('Usage:')} styrby daemon <command> [flags]

${chalk.bold('Commands:')}
  install     Install daemon to start automatically on boot
  uninstall   Remove daemon from auto-start
  status      Check if daemon auto-start is configured

${chalk.bold('Flags:')}
  --refresh-install   Regenerate the service file with the current environment
                      variables and reload, without a full uninstall/reinstall.
                      Use after updating SUPABASE_URL or SUPABASE_ANON_KEY.

${chalk.bold('Examples:')}
  styrby daemon install                    # Set up auto-start
  styrby daemon install --refresh-install  # Re-bake env vars into service file
  styrby daemon uninstall                  # Remove auto-start
  styrby daemon status                     # Check auto-start status

${chalk.bold('Platform Support:')}
  macOS   LaunchAgent (~/Library/LaunchAgents/)
  Linux   systemd user service (~/.config/systemd/user/)
`);
}

export default { handleDaemon, handleDaemonInstall, handleDaemonUninstall };
