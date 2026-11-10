import { z } from 'zod';

export const HandoffContractSchema = z.object({
  nextAgentId: z.string(),
  reason: z.string(),
  requiredArtifacts: z.array(z.string()).default([]),
  expectedOutput: z.string(),
})
export type HandoffContract = z.infer<typeof HandoffContractSchema>

export const ScenarioStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  agentId: z.string(),
  capabilityId: z.string().optional(),
  order: z.number(),
  requiredArtifacts: z.array(z.string()).default([]),
  producedArtifacts: z.array(z.string()).default([]),
  timeoutMs: z.number().optional(),
  retryPolicy: z.object({
    maxAttempts: z.number().default(1),
    backoffMs: z.number().default(1000),
  }).optional(),
  handoff: HandoffContractSchema.optional(),
});
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const WorkflowStepContractSchema = z.object({
  id: z.string(),
  order: z.number(),
  agentId: z.string(),
  capabilityId: z.string(),
  requiredArtifacts: z.array(z.string()).default([]),
  producedArtifacts: z.array(z.string()).default([]),
  timeoutMs: z.number().optional(),
  retryPolicy: z.object({
    maxAttempts: z.number().default(1),
    backoffMs: z.number().default(1000),
  }).optional(),
});
export type WorkflowStepContract = z.infer<typeof WorkflowStepContractSchema>;

export const WorkflowContractSchema = z.object({
  version: z.literal('1.0'),
  deterministic: z.boolean().default(true),
  steps: z.array(WorkflowStepContractSchema),
});
export type WorkflowContract = z.infer<typeof WorkflowContractSchema>;

export const ScenarioContractSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(ScenarioStepSchema),
  workflowContract: WorkflowContractSchema.optional(),
  roles: z.array(z.string()).default([]),
  requiredArtifacts: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
});
export type ScenarioContract = z.infer<typeof ScenarioContractSchema>;

export const DecisionType = z.enum(['delegate', 'retry', 'skip', 'fail', 'escalate']);
export type DecisionType = z.infer<typeof DecisionType>;

export const StepExecutionStatusSchema = z.enum([
  'completed',
  'partially_completed',
  'recoverable_failed',
  'failed',
  'timeout',
  'interrupted',
  'exhausted_rounds',
]);
export type StepExecutionStatus = z.infer<typeof StepExecutionStatusSchema>;

export const FailureCategorySchema = z.enum([
  'timeout',
  'artifact',
  'sensor',
  'model',
  'tool_policy',
  'capability',
  'auth',
  'interruption',
  'unknown',
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const AdaptationTypeSchema = z.enum([
  'timeout',
  'retry',
  'model',
  'circuit_breaker',
  'historical_context',
  'trend_gate',
]);
export type AdaptationType = z.infer<typeof AdaptationTypeSchema>;

export const AdaptiveDecisionSchema = z.object({
  type: AdaptationTypeSchema,
  applied: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  previousValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  circuitBreakerOpen: z.boolean().optional(),
  historicalContext: z.record(z.string(), z.unknown()).optional(),
});
export type AdaptiveDecision = z.infer<typeof AdaptiveDecisionSchema>;

export const OrchestratorDecisionSchema = z.object({
  stepId: z.string(),
  decision: DecisionType,
  reason: z.string(),
  attempt: z.number().default(1),
  timestamp: z.string(),
  status: StepExecutionStatusSchema.optional(),
  recovery: z.object({
    cause: z.string(),
    decision: z.string(),
    outcome: z.string().optional(),
    factors: z.array(z.string()).optional(),
  }).optional(),
  adaptations: z.array(AdaptiveDecisionSchema).default([]),
  historicalContext: z.record(z.string(), z.unknown()).optional(),
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

export const RunResultSchema = z.object({
  sessionId: z.string(),
  scenarioId: z.string(),
  status: z.enum(['complete', 'failed']),
  stepsCompleted: z.number(),
  totalSteps: z.number(),
  decisions: z.array(OrchestratorDecisionSchema),
  durationMs: z.number(),
  error: z.string().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;
