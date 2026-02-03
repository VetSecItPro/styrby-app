/**
 * Project Path Utilities
 *
 * Provides functions for resolving and validating project paths
 * for AI agent sessions. The project path determines where the
 * agent operates and where session data is stored.
 *
 * @module projectPath
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolves a project path to an absolute path.
 *
 * @param inputPath - The path provided by the user (can be relative)
 * @returns Absolute path to the project directory
 * @throws {Error} If the path doesn't exist or isn't a directory
 *
 * @example
 * const projectDir = resolveProjectPath('./my-project');
 * // Returns: /Users/dev/my-project
 */
export function resolveProjectPath(inputPath?: string): string {
  const resolved = inputPath
    ? path.resolve(process.cwd(), inputPath)
    : process.cwd();

  if (!fs.existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }

  return resolved;
}

/**
 * Gets the current working directory for the CLI.
 *
 * @returns Current working directory path
 */
export function getCurrentProjectPath(): string {
  return process.cwd();
}

/**
 * Checks if a path is within the project directory (security check).
 *
 * @param projectPath - The root project path
 * @param targetPath - The path to check
 * @returns True if targetPath is within projectPath
 *
 * @example
 * isWithinProject('/project', '/project/src/file.ts'); // true
 * isWithinProject('/project', '/etc/passwd'); // false
 */
export function isWithinProject(projectPath: string, targetPath: string): boolean {
  const resolvedProject = path.resolve(projectPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedProject + path.sep) ||
         resolvedTarget === resolvedProject;
}

/**
 * Default export for compatibility with Happy Coder imports
 */
export default {
  resolveProjectPath,
  getCurrentProjectPath,
  isWithinProject,
};
