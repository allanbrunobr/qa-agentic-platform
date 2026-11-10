/**
 * Capabilities performed by more than one tool. Shared by the agent runtime (which tools a step may
 * use) and contract evaluation (which observed tools satisfy the capability), so both agree.
 */
export const COMPOSITE_CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  validateManagementClosure: Object.freeze(['verifyFinanceDashboard', 'verifyReportsPage']),
})
