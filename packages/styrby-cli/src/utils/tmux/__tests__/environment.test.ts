/**
 * Unit tests for parseTmuxEnvVar - the pure parser for the `TMUX` env var.
 *
 * WHY: This helper was extracted from `TmuxUtilities.detectTmuxEnvironment`
 * so it can be tested without poking at process.env or spawning tmux.
 */

import { describe, expect, it } from 'vitest';

import { parseTmuxEnvVar } from '../environment';

describe('parseTmuxEnvVar', () => {
    it('returns null for undefined input', () => {
        expect(parseTmuxEnvVar(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseTmuxEnvVar('')).toBeNull();
    });

    it('returns null when fewer than 3 comma-separated parts', () => {
        expect(parseTmuxEnvVar('/tmp/tmux-1000/default,4219')).toBeNull();
    });

    // WHY: The TMUX env var format is `<socket>,<pid>,<pane>`. The historical
    // implementation extracts the session/window basename from the SECOND
    // comma-part (the PID/session-ref), not from the socket path. These tests
    // pin that behavior so the refactor cannot accidentally alter it.

    it('extracts session basename from the second comma-part (no dot)', () => {
        const result = parseTmuxEnvVar('/tmp/tmux-1000/default,4219,0');
        expect(result).toEqual({
            session: '4219',
            window: '0',
            pane: '0',
            socket_path: '/tmp/tmux-1000/default',
        });
    });

    it('splits session.window when the second comma-part contains a dot', () => {
        const result = parseTmuxEnvVar('/tmp/tmux-1000/sock,happy.2,1');
        expect(result).toEqual({
            session: 'happy',
            window: '2',
            pane: '1',
            socket_path: '/tmp/tmux-1000/sock',
        });
    });

    it('preserves the socket_path verbatim', () => {
        const result = parseTmuxEnvVar('/custom/path/sockfile,abc.def,9');
        expect(result?.socket_path).toBe('/custom/path/sockfile');
    });

    it('defaults window to "0" when second part has no dot', () => {
        const result = parseTmuxEnvVar('/socket,abc,3');
        expect(result?.window).toBe('0');
    });

    it('takes the path basename when the second part embeds slashes', () => {
        const result = parseTmuxEnvVar('/sock,foo/bar.baz,2');
        expect(result?.session).toBe('bar');
        expect(result?.window).toBe('baz');
    });
});
