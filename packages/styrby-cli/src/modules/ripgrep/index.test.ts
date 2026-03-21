/**
 * Tests for low-level ripgrep wrapper
 *
 * WHY: These tests depend on a bundled ripgrep binary launched via
 * scripts/ripgrep_launcher.cjs. In environments where the launcher or
 * binary isn't present, tests skip gracefully instead of failing.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { run } from './index'

/**
 * Check if the ripgrep launcher script is available before running tests.
 * @returns true if the launcher CJS script exists at the expected path
 */
function isRipgrepAvailable(): boolean {
    const launcherPath = resolve(join(__dirname, '..', '..', '..', 'scripts', 'ripgrep_launcher.cjs'));
    return existsSync(launcherPath);
}

const describeMaybe = isRipgrepAvailable() ? describe : describe.skip;

describeMaybe('ripgrep low-level wrapper', () => {
    it('should get version', async () => {
        const result = await run(['--version'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('ripgrep')
    })
    
    it('should search for pattern', async () => {
        const result = await run(['describe', 'src/modules/ripgrep/index.test.ts'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('describe')
    })
    
    it('should return exit code 1 for no matches', async () => {
        const result = await run(['ThisPatternShouldNeverMatch999', 'package.json'])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
    })
    
    it('should handle JSON output', async () => {
        const result = await run(['--json', 'describe', 'src/modules/ripgrep/index.test.ts'])
        expect(result.exitCode).toBe(0)
        
        // Parse first line to check it's valid JSON
        const lines = result.stdout.trim().split('\n')
        const firstLine = JSON.parse(lines[0])
        expect(firstLine).toHaveProperty('type')
    })
    
    it('should respect custom working directory', async () => {
        const result = await run(['describe', 'index.test.ts'], { cwd: 'src/modules/ripgrep' })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('describe')
    })
})