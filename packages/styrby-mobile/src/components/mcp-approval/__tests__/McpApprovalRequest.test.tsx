/**
 * Tests for McpApprovalRequest presentational component.
 *
 * Coverage:
 *   - Renders requested action, reason, machine prefix, and risk badge label.
 *   - Renders the JSON context block when context is non-empty.
 *   - Approve / Deny tap callbacks fire with the typed note text.
 *   - Disables both buttons while isSubmitting is true.
 *   - Disables both buttons when secondsRemaining hits 0 (expired).
 *   - Renders the submit error banner when submitError is provided.
 *   - Snapshot of medium-risk request locks the visual structure.
 *
 * @module components/mcp-approval/__tests__/McpApprovalRequest.test
 */

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { McpApprovalRequest } from '@/components/mcp-approval/McpApprovalRequest';
import type { McpApprovalRequestModel } from '@/components/mcp-approval';

const baseRequest: McpApprovalRequestModel = {
  approvalId: '11111111-2222-3333-4444-555555555555',
  requestedAction: 'bash',
  reason: 'Install project dependencies before running tests.',
  risk: 'medium',
  machineId: 'machineabc12345extra',
  context: { command: 'npm install' },
  createdAt: new Date().toISOString(),
};

describe('McpApprovalRequest', () => {
  const onApprove = jest.fn();
  const onDeny = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the requested action chip', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText('bash')).toBeTruthy();
  });

  it('renders the reason text', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(
      screen.getByText('Install project dependencies before running tests.'),
    ).toBeTruthy();
  });

  it('renders the truncated machine id', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText(/machinea/)).toBeTruthy();
  });

  it('renders the risk badge with the matching label', () => {
    render(
      <McpApprovalRequest
        request={{ ...baseRequest, risk: 'high' }}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText('High Risk')).toBeTruthy();
  });

  it('renders the JSON context block when context is non-empty', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText(/npm install/)).toBeTruthy();
  });

  it('omits the context block when context is empty', () => {
    render(
      <McpApprovalRequest
        request={{ ...baseRequest, context: {} }}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.queryByText('Context')).toBeNull();
  });

  it('renders the countdown text', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={272}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText(/Expires in 4:32/)).toBeTruthy();
  });

  it('renders expired copy when secondsRemaining is 0', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={0}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText(/expired/i)).toBeTruthy();
  });

  it('calls onApprove with the typed note', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    fireEvent.changeText(
      screen.getByLabelText('Optional note to attach to the approval decision'),
      'go for it',
    );
    fireEvent.press(screen.getByLabelText('Approve this MCP approval request'));
    expect(onApprove).toHaveBeenCalledWith('go for it');
  });

  it('calls onDeny with the typed note', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    fireEvent.changeText(
      screen.getByLabelText('Optional note to attach to the approval decision'),
      'looks scary',
    );
    fireEvent.press(screen.getByLabelText('Deny this MCP approval request'));
    expect(onDeny).toHaveBeenCalledWith('looks scary');
  });

  it('disables both buttons while submitting', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={true}
        submitError={null}
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(
      screen.getByLabelText('Approve this MCP approval request').props.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText('Deny this MCP approval request').props.disabled,
    ).toBe(true);
  });

  it('disables buttons when expired', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={0}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(
      screen.getByLabelText('Approve this MCP approval request').props.disabled,
    ).toBe(true);
  });

  it('renders the submit error banner', () => {
    render(
      <McpApprovalRequest
        request={baseRequest}
        isSubmitting={false}
        submitError="Biometric check cancelled"
        secondsRemaining={120}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText('Biometric check cancelled')).toBeTruthy();
  });

  it('matches the snapshot for a medium-risk request', () => {
    const tree = render(
      <McpApprovalRequest
        request={{ ...baseRequest, createdAt: '2026-04-30T00:00:00.000Z' }}
        isSubmitting={false}
        submitError={null}
        secondsRemaining={272}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    ).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
