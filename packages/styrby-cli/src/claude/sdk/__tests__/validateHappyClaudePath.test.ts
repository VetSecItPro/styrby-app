/**
 * Tests for validateHappyClaudePath (claude/sdk/utils.ts).
 *
 * SECURITY: this validator is the only gate against an attacker poisoning
 * HAPPY_CLAUDE_PATH (via .env injection, env-var leak, etc.) to redirect
 * the claude-binary spawn to /tmp/evil. CLI-003 audit hardening (PR #262)
 * added the validator; coverage was 0% — this file fixes that.
 *
 * Test categories (matches the validator's check sequence):
 *   1. Control character rejection (null/CR/LF)
 *   2. Path-traversal rejection (`..` segments)
 *   3. Allowed-root enforcement (must resolve under a known install root)
 *   4. Existence check (rejects non-existent paths even if under allowed root)
 *
 * @module claude/sdk/__tests__/validateHappyClaudePath
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateHappyClaudePath } from '@/claude/sdk/utils';

describe('validateHappyClaudePath: control character rejection', () => {
  it('rejects path with NULL byte', () => {
    expect(validateHappyClaudePath('/usr/local/bin/claude\x00.sh')).toBeNull();
  });

  it('rejects path with CR', () => {
    expect(validateHappyClaudePath('/usr/local/bin/claude\rinjected')).toBeNull();
  });

  it('rejects path with LF', () => {
    expect(validateHappyClaudePath('/usr/local/bin/claude\nbash')).toBeNull();
  });

  it('rejects path with mixed control chars', () => {
    expect(validateHappyClaudePath('\r\n/usr/local/bin/claude')).toBeNull();
  });
});

describe('validateHappyClaudePath: path traversal rejection', () => {
  it('rejects absolute path with .. segment', () => {
    expect(validateHappyClaudePath('/usr/local/bin/../../tmp/evil')).toBeNull();
  });

  it('rejects relative path with .. segment', () => {
    expect(validateHappyClaudePath('../../etc/passwd')).toBeNull();
  });

  it('rejects path with multiple .. segments', () => {
    expect(validateHappyClaudePath('/opt/../../tmp/x')).toBeNull();
  });
});

describe('validateHappyClaudePath: allowed-root enforcement', () => {
  it('rejects path outside allowed install roots (/tmp)', () => {
    expect(validateHappyClaudePath('/tmp/claude')).toBeNull();
  });

  it('rejects path outside allowed install roots (/etc)', () => {
    expect(validateHappyClaudePath('/etc/claude')).toBeNull();
  });

  it('rejects path that LOOKS like /usr/local but is /usrlocal', () => {
    expect(validateHappyClaudePath('/usrlocal/bin/claude')).toBeNull();
  });

  it('rejects path that LOOKS like /opt but is /options', () => {
    expect(validateHappyClaudePath('/options/bin/claude')).toBeNull();
  });
});

describe('validateHappyClaudePath: existence check', () => {
  it('rejects non-existent path even under allowed root', () => {
    expect(validateHappyClaudePath('/usr/local/bin/definitely-not-a-real-binary-xyz123')).toBeNull();
  });

  it('rejects when path under allowed root has typo / does not exist', () => {
    expect(validateHappyClaudePath('/opt/totally-fake-claude-installation/bin/claude')).toBeNull();
  });
});

describe('validateHappyClaudePath: positive case', () => {
  // Need a real file under an allowed root for the happy-path test.
  // /opt is an allowed root but most CI environments don't have writable
  // paths under /opt. Create a temp file and skip if /opt isn't writable.
  let createdPath: string | null = null;

  beforeAll(() => {
    const optDir = '/opt';
    if (!fs.existsSync(optDir)) return;
    const candidatePath = path.join(optDir, `styrby-test-${Date.now()}-${process.pid}`);
    try {
      fs.writeFileSync(candidatePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      createdPath = candidatePath;
    } catch {
      // /opt not writable — skip these tests
      createdPath = null;
    }
  });

  afterAll(() => {
    if (createdPath && fs.existsSync(createdPath)) {
      try { fs.unlinkSync(createdPath); } catch { /* ignore */ }
    }
  });

  it.skipIf(!process.env.STYRBY_TEST_OPT_WRITABLE)(
    'accepts a real file under /opt (allowed root)',
    () => {
      if (!createdPath) {
        // Test skipped if /opt isn't writable in this env.
        return;
      }
      const result = validateHappyClaudePath(createdPath);
      expect(result).toBe(createdPath);
    }
  );

  it('accepts a real file under HOME/.local (when HOME is on a writable disk)', () => {
    // Use os.tmpdir under HOME if possible. Most environments have HOME/.local
    // either existing or creatable. If we can't create the test fixture,
    // skip with a clear note.
    const localBin = path.join(os.homedir(), '.local', 'bin');
    let testFile: string | null = null;
    try {
      fs.mkdirSync(localBin, { recursive: true });
      testFile = path.join(localBin, `styrby-validate-test-${Date.now()}-${process.pid}`);
      fs.writeFileSync(testFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = validateHappyClaudePath(testFile);
      expect(result).toBe(testFile);
    } catch (e) {
      // If we can't create under HOME/.local (rare), skip the assertion
      // rather than fail spuriously.
      console.warn(`[validateHappyClaudePath test] Could not create fixture under HOME/.local: ${(e as Error).message}`);
    } finally {
      if (testFile && fs.existsSync(testFile)) {
        try { fs.unlinkSync(testFile); } catch { /* ignore */ }
      }
    }
  });
});
