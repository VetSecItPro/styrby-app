/**
 * MobileDeleteSection — F2 verification (M1.1 follow-up)
 *
 * The lint cleanup pass (M1.1) noticed the component's JSDoc claimed
 * `userEmail` and `userDisplayName` were "shown in the info step for context"
 * but the rendered output never included them. The agent added a small
 * "Account: name (email)" header to close the contract gap. This test suite
 * verifies the header lands as designed across the three relevant input
 * shapes:
 *
 *   1. Both displayName + email present → "displayName (email)"
 *   2. Email only (no displayName)     → email alone
 *   3. Initial render (info sheet hidden) → header NOT rendered
 *
 * @see ../MobileDeleteSection.tsx
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// ── Mocks ─────────────────────────────────────────────────────────────────

jest.mock('@/components/account/account-io', () => ({
  deleteAccount: jest.fn().mockResolvedValue({ ok: true }),
}));

// SectionHeader pulls in design-system styles that aren't relevant to the
// header-rendering invariant we're guarding here. Stub it.
jest.mock('../../../components/ui', () => ({
  SectionHeader: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    return <Text>{title}</Text>;
  },
}));

import { MobileDeleteSection } from '../MobileDeleteSection';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Open the info sheet by tapping the "Delete Account" entry-point button,
 * because the account-identity header lives behind that gate.
 */
function openInfoSheet(getByLabelText: (label: string) => unknown): void {
  const trigger = getByLabelText('Begin account deletion process') as Parameters<typeof fireEvent.press>[0];
  fireEvent.press(trigger);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MobileDeleteSection — account identity header (F2)', () => {
  it('renders "displayName (email)" when both are provided', () => {
    const { queryByText, getByLabelText } = render(
      <MobileDeleteSection userEmail="alice@example.com" userDisplayName="Alice" />,
    );

    // Header is gated behind the info-sheet open state; nothing should be
    // visible on first render.
    expect(queryByText(/alice/i)).toBeNull();

    openInfoSheet(getByLabelText);

    // After tapping into the info sheet, both pieces of identity must
    // appear in the combined "displayName (email)" form.
    expect(queryByText('Alice (alice@example.com)')).not.toBeNull();
    // Plus the static "Account" caption above the value.
    expect(queryByText('Account')).not.toBeNull();
  });

  it('renders email alone when displayName is omitted', () => {
    const { queryByText, getByLabelText } = render(
      <MobileDeleteSection userEmail="bob@example.com" />,
    );

    openInfoSheet(getByLabelText);

    // No parens, no name — just the email.
    expect(queryByText('bob@example.com')).not.toBeNull();
    expect(queryByText(/\(.*\)/)).toBeNull();
  });

  it('does NOT render the account header before the info sheet opens', () => {
    // WHY this case: the header is meant to appear only inside the info
    // step. Rendering it on the entry-point button would leak account
    // identity into a settings list that doesn't otherwise mention it.
    const { queryByText } = render(
      <MobileDeleteSection userEmail="carol@example.com" userDisplayName="Carol" />,
    );

    expect(queryByText('Carol (carol@example.com)')).toBeNull();
    // The "Delete Account" trigger must still be there.
    expect(queryByText('Delete Account')).not.toBeNull();
  });
});
