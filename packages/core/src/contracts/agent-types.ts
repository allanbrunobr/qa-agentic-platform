import { z } from 'zod'
import { ToolPolicySchema } from './tool-types.ts'

export const AgentRoleSchema = z.enum([
  'orchestrator',
  'primary_user',
  'api_consumer',
  'cli_user',
  'integration_developer',
  'repository_reviewer',
  'quality_auditor',
  'sales_associate',
  'fulfillment_agent',
  'billing_clerk',
  'store_manager',
  'finance_reviewer',
  'auditor',
])
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  backoffMs: z.number().int().min(0).default(1000),
})
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

export const EvidencePolicySchema = z.object({
  requireScreenshotForFinding: z.boolean().default(true),
  requireDomSnippetForFinding: z.boolean().default(false),
})
export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>

export const AgentProfileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  role: z.string(),
  model: z.string().optional(),
  timeoutMs: z.number().int().min(1000).default(30000),
  retryPolicy: RetryPolicySchema.default({ maxAttempts: 1, backoffMs: 1000 }),
  toolPolicy: ToolPolicySchema.default({ browserAccess: false }),
  evidencePolicy: EvidencePolicySchema.default({
    requireScreenshotForFinding: true,
    requireDomSnippetForFinding: false,
  }),
  canBlockRun: z.boolean().default(false),
  outputContract: z.record(z.string(), z.unknown()).optional(),
  promptPath: z.string().optional(),
  systemPrompt: z.string().optional(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const ModelResponseSchema = z.object({
  text: z.string().optional(),
  toolCalls: z.array(ToolCallSchema),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'timeout']),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }).optional(),
})
export type ModelResponse = z.infer<typeof ModelResponseSchema>

export const ModelMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
})
export type ModelMessage = z.infer<typeof ModelMessageSchema>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelProviderOptions {
  maxTokens?: number
  temperature?: number
  model?: string
}

export interface ModelProvider {
  chat(messages: ModelMessage[], tools: ToolDefinition[], options?: ModelProviderOptions): Promise<ModelResponse>
}

export const FindingSchema = z.object({
  type: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string(),
  description: z.string(),
  evidence: z.array(z.string()),
})

export const AgentStepOutputSchema = z.object({
  status: z.enum(['completed', 'failed', 'needs_tool', 'timeout']).optional(),
  text: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  error: z.string().optional(),
  stepIndex: z.number().optional(),
  agentId: z.string().optional(),
  output: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().default(0),
  success: z.boolean().optional(),
})
export type AgentStepOutput = z.infer<typeof AgentStepOutputSchema>
