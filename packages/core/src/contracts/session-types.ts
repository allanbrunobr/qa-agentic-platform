import { z } from 'zod'

export const SessionStatusSchema = z.enum(['pending', 'running', 'complete', 'failed'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionEventTypeSchema = z.enum([
  'session_started',
  'step_started',
  'step_completed',
  'step_failed',
  'tool_called',
  'tool_call',
  'tool_result',
  'finding_recorded',
  'finding',
  'sensor_result',
  'orchestrator_decision',
  'handoff_emitted',
  'handoff_accepted',
  'handoff_rejected',
  'run_completed',
  'run_failed',
  'checkpoint_saved',
  'error',
  'info',
])
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>

export const SessionEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: SessionEventTypeSchema,
  agentRole: z.string().optional(),
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})
export type SessionEvent = z.infer<typeof SessionEventSchema>

export const SessionArtifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.enum(['screenshot', 'dom_snippet', 'domain_artifact']),
  agentRole: z.string(),
  description: z.string(),
  filePath: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string(),
})
export type SessionArtifact = z.infer<typeof SessionArtifactSchema>

export const SessionFindingSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  agentRole: z.string().optional(),
  stepId: z.string().optional(),
  type: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical', 'info']).default('info'),
  title: z.string(),
  description: z.string().optional(),
  evidence: z.unknown().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  timestamp: z.string().optional(),
  createdAt: z.string().optional(),
})
export type SessionFinding = z.infer<typeof SessionFindingSchema>

export const SessionCheckpointSchema = z.object({
  lastCompletedStep: z.number().default(-1),
  cursor: z.number().default(0),
})
export type SessionCheckpoint = z.infer<typeof SessionCheckpointSchema>

export const SessionSchema = z.object({
  id: z.string(),
  runId: z.number().optional(),
  scenarioId: z.string(),
  status: SessionStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  events: z.array(SessionEventSchema).default([]),
  artifacts: z.record(z.string(), z.unknown()).default({}),
  findings: z.array(SessionFindingSchema).default([]),
  checkpoint: SessionCheckpointSchema.default({ lastCompletedStep: -1, cursor: 0 }),
})
export type Session = z.infer<typeof SessionSchema>

export const SessionRecordSchema = SessionSchema
export type SessionRecord = Session
