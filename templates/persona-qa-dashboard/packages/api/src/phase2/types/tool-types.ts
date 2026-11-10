import { z } from 'zod'

export const ToolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
})

export type ToolError = z.infer<typeof ToolErrorSchema>

export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), output: z.unknown() }),
  z.object({ ok: z.literal(false), error: ToolErrorSchema }),
])

export type ToolResult = z.infer<typeof ToolResultSchema>

export const ToolRiskLevelSchema = z.enum(['read', 'write', 'destructive'])

export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>

export const ToolMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  requiresBrowser: z.boolean().default(false),
  riskLevel: ToolRiskLevelSchema.optional(),
  tags: z.array(z.string()).default([]),
})

export type ToolMetadata = z.infer<typeof ToolMetadataSchema>

export const ToolPolicySchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  browserAccess: z.boolean().default(false),
  browser: z.boolean().optional(),
  api: z.boolean().optional(),
  database: z.boolean().optional(),
  file: z.boolean().optional(),
})

export type ToolPolicy = z.infer<typeof ToolPolicySchema>

/**
 * What the run is testing, as chosen when the run started (execution_context). Tools must prefer it
 * over environment defaults such as PLAYWRIGHT_BASE_URL or AGENTIC_QA_TARGET_REPO, or the verdict is
 * recorded for a target that was never exercised.
 */
export interface ExecutionTarget {
  baseUrl?: string
  targetRepoPath?: string
}

export interface ToolContext {
  page?: unknown
  sessionId?: string
  agentRole?: string
  artifacts?: Record<string, unknown>
  executionTarget?: ExecutionTarget
  /**
   * Aborted when the step ends (timeout, interruption, or normal completion). Tools must not act on
   * the page or store artifacts after it fires: the step they belonged to is over (B-06).
   */
  signal?: AbortSignal
}

export type ToolHandler = (input: unknown, context: ToolContext) => Promise<ToolResult>

export const ToolInvocationSchema = z.object({
  toolName: z.string(),
  input: z.unknown(),
  agentRole: z.string().optional(),
  timestamp: z.string().datetime(),
})

export type ToolInvocation = z.infer<typeof ToolInvocationSchema>

export const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /authorization/i,
  /bearer\s+\S+/i,
] as const
