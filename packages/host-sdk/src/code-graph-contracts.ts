import { z } from 'zod'
import { SourceLocationSchema } from './domain-discovery-contracts.ts'

export const CODE_GRAPH_SCHEMA_VERSION = 'code-graph/v1'

export const CodeGraphNodeTypeSchema = z.enum([
  'repository',
  'domain',
  'source_file',
  'surface',
  'route',
  'component',
  'form',
  'button',
  'text',
  'navigation',
  'package',
  'framework',
  'test',
  'role',
  'persona_candidate',
  'scenario_candidate',
  'scenario_step_candidate',
  'capability_candidate',
  'audit',
  'risk',
  'endpoint',
  'http_call',
  'handler',
  'function',
  'service',
  'state',
  'env_var',
  'feedback_signal',
])
export type CodeGraphNodeType = z.infer<typeof CodeGraphNodeTypeSchema>

export const CodeGraphEdgeTypeSchema = z.enum([
  'contains',
  'detected_from',
  'infers_domain',
  'has_evidence',
  'allows_capability',
  'uses_persona',
  'requires_capability',
  'contains_step',
  'maps_surface',
  'reported_risk',
  'downgraded_candidate',
  'imports',
  'renders',
  'calls',
  'handles',
  'makes_http_request',
  'uses_state',
  'uses_env',
  'produces_feedback',
  'supports_capability',
  'related_to',
])
export type CodeGraphEdgeType = z.infer<typeof CodeGraphEdgeTypeSchema>

export const CodeGraphNodeSchema = z.object({
  id: z.string().min(1).max(200),
  type: CodeGraphNodeTypeSchema,
  label: z.string().min(1).max(300),
  status: z.string().min(1).max(80).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: SourceLocationSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type CodeGraphNode = z.infer<typeof CodeGraphNodeSchema>

export const CodeGraphEdgeSchema = z.object({
  id: z.string().min(1).max(240),
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  type: CodeGraphEdgeTypeSchema,
  label: z.string().min(1).max(240).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type CodeGraphEdge = z.infer<typeof CodeGraphEdgeSchema>

export const CodeGraphStatsSchema = z.object({
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  evidenceNodeCount: z.number().int().nonnegative(),
  candidateNodeCount: z.number().int().nonnegative(),
})
export type CodeGraphStats = z.infer<typeof CodeGraphStatsSchema>

export const CodeGraphSchema = z.object({
  schemaVersion: z.literal(CODE_GRAPH_SCHEMA_VERSION).default(CODE_GRAPH_SCHEMA_VERSION),
  targetId: z.string().min(1).max(160),
  repositoryKind: z.string().min(1).max(80).default('unknown'),
  generatedAt: z.string().datetime(),
  nodes: z.array(CodeGraphNodeSchema).default([]),
  edges: z.array(CodeGraphEdgeSchema).default([]),
  stats: CodeGraphStatsSchema,
})
export type CodeGraph = z.infer<typeof CodeGraphSchema>

export function normalizeCodeGraph(input: unknown): CodeGraph {
  return CodeGraphSchema.parse(input)
}
