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

export const ToolMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  requiresBrowser: z.boolean().default(false),
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

export interface ToolContext {
  page?: unknown
  sessionId?: string
  agentRole?: string
  artifacts?: Record<string, unknown>
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
