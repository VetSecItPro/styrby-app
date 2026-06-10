/**
 * Tests for the web ChatInput send path.
 *
 * Covers the two-channel send (web-send PR-A):
 *  - LIVE: broadcasts plaintext to the relay via sendChat(content, agent, sessionId)
 *  - HISTORY: encrypts (encryptForSession) + POSTs to /api/relay/send-message
 *  - persist is best-effort: skipped when no machineId or no CLI key (null)
 *  - send is gated on relay connection (button disabled + "Connecting…" hint)
 *  - sendChat failure surfaces an error and does not clear the input
 *
 * @module sessions/[id]/__tests__/chat-input
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => {
  type Enc = { content_encrypted: string; encryption_nonce: string } | null;
  return {
    sendChat: vi.fn(async (_content: string, _agent: string, _sessionId?: string): Promise<void> => {}),
    connected: true,
    encryptForSession: vi.fn(
      async (_content: string, _machineId: string): Promise<Enc> => ({
        content_encrypted: 'CT',
        encryption_nonce: 'NONCE',
      }),
    ),
    saveCommand: vi.fn(async (_input: unknown): Promise<unknown> => ({})),
  };
});

vi.mock('@/hooks/useRelaySend', () => ({
  useRelaySend: () => ({ sendChat: h.sendChat, connected: h.connected }),
}));
vi.mock('@/lib/encryption', () => ({
  encryptForSession: (content: string, machineId: string) => h.encryptForSession(content, machineId),
}));
vi.mock('@/lib/offline-storage', () => ({
  saveCommand: (input: unknown) => h.saveCommand(input),
}));

import { ChatInput } from '../chat-input';

const BASE_PROPS = { sessionId: 'sess-1', userId: 'user-1', agent: 'claude' as const, machineId: 'machine-1' };

beforeEach(() => {
  h.connected = true;
  h.sendChat.mockClear().mockResolvedValue(undefined);
  h.encryptForSession.mockClear().mockResolvedValue({ content_encrypted: 'CT', encryption_nonce: 'NONCE' });
  h.saveCommand.mockClear().mockResolvedValue({});
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

async function typeAndSend(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Message input'), text);
  await user.click(screen.getByLabelText('Send message'));
}

describe('ChatInput send path', () => {
  it('broadcasts plaintext over the relay AND persists encrypted', async () => {
    render(<ChatInput {...BASE_PROPS} />);
    await typeAndSend('do the thing');

    await waitFor(() => expect(h.sendChat).toHaveBeenCalledWith('do the thing', 'claude', 'sess-1'));
    expect(h.encryptForSession).toHaveBeenCalledWith('do the thing', 'machine-1');

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith('/api/relay/send-message', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ sessionId: 'sess-1', content_encrypted: 'CT', encryption_nonce: 'NONCE' });

    // Input cleared on success.
    await waitFor(() => expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe(''));
  });

  it('skips persistence (no fetch) when the CLI key is unavailable, but still broadcasts', async () => {
    h.encryptForSession.mockResolvedValue(null);
    render(<ChatInput {...BASE_PROPS} />);
    await typeAndSend('hi');

    await waitFor(() => expect(h.sendChat).toHaveBeenCalledTimes(1));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips encryption + persistence entirely when machineId is null', async () => {
    render(<ChatInput {...BASE_PROPS} machineId={null} />);
    await typeAndSend('hi');

    await waitFor(() => expect(h.sendChat).toHaveBeenCalledTimes(1));
    expect(h.encryptForSession).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('queues offline (saveCommand) instead of broadcasting when disconnected', async () => {
    h.connected = false;
    render(<ChatInput {...BASE_PROPS} />);

    // Offline hint shown. Sending while offline is allowed (queueing) — proven
    // by saveCommand being invoked below (a disabled button wouldn't fire it).
    expect(screen.getByText(/Offline — messages are queued/i)).toBeInTheDocument();

    await typeAndSend('offline message');

    await waitFor(() =>
      expect(h.saveCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command_type: 'chat',
          payload: { content: 'offline message', agent: 'claude', session_id: 'sess-1' },
          machine_id: 'machine-1',
          session_id: 'sess-1',
        }),
      ),
    );
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // The confirmation notice (distinct from the standing offline hint).
    expect(screen.getByText(/message queued\. It will send/i)).toBeInTheDocument();
  });

  it('errors when queueing offline with no paired machine', async () => {
    h.connected = false;
    render(<ChatInput {...BASE_PROPS} machineId={null} />);
    await typeAndSend('offline message');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no paired machine/i));
    expect(h.saveCommand).not.toHaveBeenCalled();
  });

  it('surfaces an error and keeps the input when the broadcast fails', async () => {
    h.sendChat.mockRejectedValue(new Error('Relay is not connected'));
    render(<ChatInput {...BASE_PROPS} />);
    await typeAndSend('keep me');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Relay is not connected/i));
    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('keep me');
  });
});
