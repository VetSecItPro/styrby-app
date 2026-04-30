/**
 * MCP approval surface — barrel exports.
 *
 * WHY: matches the project's component-first / barrel-export discipline so
 * the route handler imports a single flat surface area.
 */

export { McpApprovalRequest } from './McpApprovalRequest';
export type { McpApprovalRequestProps } from './McpApprovalRequest';
export {
  useMcpApproval,
  type McpApprovalRequest as McpApprovalRequestModel,
  type UseMcpApprovalInput,
  type UseMcpApprovalResult,
} from './useMcpApproval';
