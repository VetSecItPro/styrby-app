/**
 * Tests for difftastic module
 *
 * WHY: These tests depend on a bundled `difft` binary in tools/unpacked/.
 * In environments where the binary isn't present (CI without asset download,
 * fresh clones), they skip gracefully instead of failing the entire suite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { run } from './index';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, platform } from 'os';

/**
 * Check if the difftastic binary is available before running tests.
 * @returns true if the difft binary exists at the expected path
 */
function isDifftAvailable(): boolean {
    const binaryName = platform() === 'win32' ? 'difft.exe' : 'difft';
    const binaryPath = resolve(join(__dirname, '..', '..', '..', 'tools', 'unpacked', binaryName));
    return existsSync(binaryPath);
}

const describeMaybe = isDifftAvailable() ? describe : describe.skip;

describeMaybe('difftastic', () => {
    let testDir: string;
    let file1Path: string;
    let file2Path: string;

    beforeAll(() => {
        // Create test directory and files
        testDir = join(tmpdir(), `difftastic-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
        
        file1Path = join(testDir, 'file1.txt');
        file2Path = join(testDir, 'file2.txt');
        
        writeFileSync(file1Path, 'Hello\nWorld\nTest\n');
        writeFileSync(file2Path, 'Hello\nModified\nTest\n');
        
        return () => {
            // Cleanup
            rmSync(testDir, { recursive: true, force: true });
        };
    });

    it('should show version', async () => {
        const result = await run(['--version']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Difftastic');
    });

    it('should compare two files', async () => {
        const result = await run([file1Path, file2Path]);
        // Difftastic returns 0 even when files differ (unlike traditional diff)
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('file2.txt');
        expect(result.stdout).toContain('World');
        expect(result.stdout).toContain('Modified');
    });

    it('should respect color option', async () => {
        const result = await run(['--color', 'never', file1Path, file2Path]);
        expect(result.exitCode).toBe(0);
        // Check that ANSI color codes are not present
        expect(result.stdout).not.toContain('\x1b[');
    });

    it('should list languages', async () => {
        const result = await run(['--list-languages']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('JavaScript');
        expect(result.stdout).toContain('TypeScript');
        expect(result.stdout).toContain('Python');
    });

    it('should handle missing files', async () => {
        const result = await run(['nonexistent.txt', 'alsonothere.txt']);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toBeTruthy();
    });
});