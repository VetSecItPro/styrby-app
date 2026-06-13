/**
 * StatusBadge — status pill for a cloud task.
 *
 * Extracted from cloud-tasks.tsx (Cluster A2 split).
 *
 * @module components/cloud-tasks/StatusBadge
 */

import type { CloudTaskStatus } from '@styrby/shared';
import { STATUS_CONFIG } from './task-format';

/**
 * Status badge pill.
 *
 * @param status - The CloudTaskStatus to render.
 */
export function StatusBadge({ status }: { status: CloudTaskStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.badgeBg} ${cfg.badgeText}`}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: cfg.dotColor }} />
      {cfg.label}
    </span>
  );
}
