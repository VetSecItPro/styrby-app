/**
 * Tests for McpApprovalEventRow.
 *
 * Coverage:
 *   - Pending requested rows render "Pending approval - <action>" + Review button.
 *   - Approved decided rows render "Approved <action>" without Review button.
 *   - Denied decided rows render "Denied <action>".
 *   - Timeout rows render "Approval expired - <action>".
 *   - Tapping Review fires onReview with the approvalId.
 *
 * @module components/audit/__tests__/McpApprovalEventRow.test
 */

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { McpApprovalEventRow } from '@/components/audit/McpApprovalEventRow';

const APPROVAL_ID = '11111111-2222-3333-4444-555555555555';
const NOW = new Date().toISOString();

describe('McpApprovalEventRow', () => {
  it('renders pending requested row with Review button', () => {
    const onReview = jest.fn();
    render(
      <McpApprovalEventRow
        kind="mcp_approval_requested"
        approvalId={APPROVAL_ID}
        requestedAction="bash"
        timestamp={NOW}
        isPending={true}
        onReview={onReview}
      />,
    );
    expect(screen.getByText(/Pending approval - bash/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText(/Review pending MCP approval/));
    expect(onReview).toHaveBeenCalledWith(APPROVAL_ID);
  });

  it('does not render Review button on a resolved requested row', () => {
    render(
      <McpApprovalEventRow
        kind="mcp_approval_requested"
        approvalId={APPROVAL_ID}
        requestedAction="bash"
        timestamp={NOW}
        isPending={false}
      />,
    );
    expect(screen.queryByText('Review')).toBeNull();
  });

  it('renders approved decision row', () => {
    render(
      <McpApprovalEventRow
        kind="mcp_approval_decided"
        approvalId={APPROVAL_ID}
        requestedAction="edit"
        decision="approved"
        timestamp={NOW}
      />,
    );
    expect(screen.getByText('Approved edit')).toBeTruthy();
  });

  it('renders denied decision row', () => {
    render(
      <McpApprovalEventRow
        kind="mcp_approval_decided"
        approvalId={APPROVAL_ID}
        requestedAction="bash"
        decision="denied"
        timestamp={NOW}
      />,
    );
    expect(screen.getByText('Denied bash')).toBeTruthy();
  });

  it('renders timeout row', () => {
    render(
      <McpApprovalEventRow
        kind="mcp_approval_timeout"
        approvalId={APPROVAL_ID}
        requestedAction="bash"
        timestamp={NOW}
      />,
    );
    expect(screen.getByText(/Approval expired - bash/)).toBeTruthy();
  });
});
