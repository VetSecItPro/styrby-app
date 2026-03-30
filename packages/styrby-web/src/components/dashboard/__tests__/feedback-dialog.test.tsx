/**
 * FeedbackDialog Component Tests
 *
 * Tests for the feedback submission dialog:
 * - Open/close visibility gating
 * - Backdrop click closes the dialog
 * - Close button dismisses the dialog
 * - Category selector: renders all three options, description updates on change
 * - Message textarea: character counter, maxLength enforcement
 * - Submit button: disabled when message is empty, enabled when non-empty
 * - Successful submission: shows success alert, calls Supabase insert correctly
 * - Unauthenticated user: shows "must be logged in" error (no insert called)
 * - Supabase insert error: shows error alert
 * - Optional email field: included in insert metadata when provided
 *
 * WHY: The FeedbackDialog touches user auth state (getUser), writes to Supabase
 * (user_feedback table), and has branching UI for success/error/unauthenticated
 * states. Regressions here silently drop user feedback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: () => ({
      insert: mockInsert,
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { FeedbackDialog } from '../feedback-dialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SetupOptions {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function setup({ open = true, onOpenChange = vi.fn() }: SetupOptions = {}) {
  const user = userEvent.setup();
  const utils = render(
    <FeedbackDialog open={open} onOpenChange={onOpenChange} />
  );
  return { user, onOpenChange, ...utils };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeedbackDialog — visibility', () => {
  it('renders nothing when open is false', () => {
    render(<FeedbackDialog open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the dialog when open is true', () => {
    setup();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Send Feedback')).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when Close button is clicked', async () => {
    const { user, onOpenChange } = setup();

    await user.click(screen.getByRole('button', { name: /close feedback dialog/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when Cancel button is clicked', async () => {
    const { user, onOpenChange } = setup();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when backdrop is clicked', async () => {
    const { onOpenChange } = setup();

    // The backdrop is the sibling div with aria-hidden="true"
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(backdrop);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('FeedbackDialog — category selector', () => {
  it('renders all three category options', () => {
    setup();

    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();

    // All options should be present
    expect(screen.getByRole('option', { name: 'General Feedback' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bug Report' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Feature Request' })).toBeInTheDocument();
  });

  it('shows General Feedback description by default', () => {
    setup();

    expect(
      screen.getByText('Thoughts, suggestions, or comments about Styrby')
    ).toBeInTheDocument();
  });

  it('updates the description when category changes', async () => {
    const { user } = setup();

    await user.selectOptions(screen.getByRole('combobox'), 'bug');

    expect(
      screen.getByText('Something is broken or not working as expected')
    ).toBeInTheDocument();
  });
});

describe('FeedbackDialog — message textarea', () => {
  it('displays character count as the user types', async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Hello');

    expect(screen.getByText('5/2000')).toBeInTheDocument();
  });

  it('keeps Submit button disabled when message is empty', () => {
    setup();

    expect(
      screen.getByRole('button', { name: /submit feedback/i })
    ).toBeDisabled();
  });

  it('enables Submit button when message has content', async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'This is a bug');

    expect(
      screen.getByRole('button', { name: /submit feedback/i })
    ).not.toBeDisabled();
  });

  it('keeps Submit disabled when message is only whitespace', async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), '   ');

    expect(
      screen.getByRole('button', { name: /submit feedback/i })
    ).toBeDisabled();
  });
});

describe('FeedbackDialog — submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Great app!');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /must be logged in/i
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('inserts with correct fields on successful submission', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-abc-123' } },
      error: null,
    });
    mockInsert.mockResolvedValue({ data: null, error: null });

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Nice feature request');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-abc-123',
          feedback_type: 'general',
          message: 'Nice feature request',
          platform: 'web',
        })
      );
    });
  });

  it('includes metadata.contact_email when optional email is provided', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-xyz' } },
      error: null,
    });
    mockInsert.mockResolvedValue({ data: null, error: null });

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Please follow up');
    await user.type(
      screen.getByLabelText('Email for follow-up (optional)'),
      'contact@example.com'
    );
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { contact_email: 'contact@example.com' },
        })
      );
    });
  });

  it('does NOT include metadata when optional email is empty', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-xyz' } },
      error: null,
    });
    mockInsert.mockResolvedValue({ data: null, error: null });

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'No follow-up needed');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      const call = mockInsert.mock.calls[0][0];
      expect(call).not.toHaveProperty('metadata');
    });
  });

  it('shows success message after successful submit', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-abc' } },
      error: null,
    });
    mockInsert.mockResolvedValue({ data: null, error: null });

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Works great!');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /thank you.*submitted/i
    );
  });

  it('shows error message when Supabase insert fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-abc' } },
      error: null,
    });
    mockInsert.mockResolvedValue({
      data: null,
      error: { message: 'DB constraint violation' },
    });

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Will this fail?');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /failed to submit feedback/i
    );
  });

  it('uses the selected feedback category in the insert call', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-abc' } },
      error: null,
    });
    mockInsert.mockResolvedValue({ data: null, error: null });

    const { user } = setup();

    await user.selectOptions(screen.getByRole('combobox'), 'bug');
    await user.type(screen.getByLabelText('Message'), 'Found a bug');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ feedback_type: 'bug' })
      );
    });
  });

  it('shows submitting state while the request is in flight', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-abc' } },
      error: null,
    });
    // Never resolve so we can inspect the loading state
    mockInsert.mockReturnValue(new Promise(() => {}));

    const { user } = setup();

    await user.type(screen.getByLabelText('Message'), 'Testing loading state');
    await user.click(screen.getByRole('button', { name: /submit feedback/i }));

    // WHY: aria-label stays "Submit feedback" even during loading; we verify
    // the button text changes to "Submitting..." by querying the submit button
    // and checking its text content directly.
    const submitBtn = screen.getByRole('button', { name: /submit feedback/i });
    expect(submitBtn.textContent).toBe('Submitting...');
  });
});
