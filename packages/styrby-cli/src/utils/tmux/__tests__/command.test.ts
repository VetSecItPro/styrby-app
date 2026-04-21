/**
 * Unit tests for buildTmuxArgv - the pure argv constructor.
 *
 * WHY: argv construction has subtle rules (send-keys needs `-t` before keys,
 * other commands accept `-t` at the end, only some commands accept `-t` at
 * all). Testing it pure means we can verify the rules without spawning tmux.
 */

import { describe, expect, it } from 'vitest';

import { buildTmuxArgv } from '../command';

describe('buildTmuxArgv', () => {
    it('returns just `tmux` for empty cmd', () => {
        expect(buildTmuxArgv([], 'happy', undefined, undefined, undefined)).toEqual(['tmux']);
    });

    it('prefixes -S socketPath when provided', () => {
        const argv = buildTmuxArgv([], 'happy', undefined, undefined, '/tmp/sock');
        expect(argv).toEqual(['tmux', '-S', '/tmp/sock']);
    });

    it('inserts -t target immediately after send-keys (before payload)', () => {
        const argv = buildTmuxArgv(
            ['send-keys', 'hello', 'C-m'],
            'happy',
            'win',
            '0',
            undefined
        );
        expect(argv).toEqual(['tmux', 'send-keys', '-t', 'happy:win.0', 'hello', 'C-m']);
    });

    it('omits window/pane segments when not provided to send-keys', () => {
        const argv = buildTmuxArgv(['send-keys', 'echo'], 'happy', undefined, undefined, undefined);
        expect(argv).toEqual(['tmux', 'send-keys', '-t', 'happy', 'echo']);
    });

    it('appends -t target at end for target-supporting commands', () => {
        const argv = buildTmuxArgv(['kill-window'], 'happy', 'agent', undefined, undefined);
        expect(argv).toEqual(['tmux', 'kill-window', '-t', 'happy:agent']);
    });

    it('does NOT append -t for commands that do not support it', () => {
        const argv = buildTmuxArgv(['has-session'], 'happy', 'agent', undefined, undefined);
        expect(argv).toEqual(['tmux', 'has-session']);
    });

    it('combines socket flag and target append', () => {
        const argv = buildTmuxArgv(
            ['list-windows'],
            'happy',
            undefined,
            undefined,
            '/tmp/sock'
        );
        expect(argv).toEqual(['tmux', '-S', '/tmp/sock', 'list-windows', '-t', 'happy']);
    });

    it('builds full session:window.pane target for send-keys', () => {
        const argv = buildTmuxArgv(['send-keys', 'x'], 'sess', 'w1', '2', undefined);
        expect(argv).toEqual(['tmux', 'send-keys', '-t', 'sess:w1.2', 'x']);
    });
});
