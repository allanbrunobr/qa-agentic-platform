import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const CodeGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  status: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.object({
    filePath: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const CodeGraphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const CodeGraphSchema = z.object({
  schemaVersion: z.literal('code-graph/v1'),
  targetId: z.string().min(1),
  repositoryKind: z.string().min(1),
  generatedAt: z.string().min(1),
  nodes: z.array(CodeGraphNodeSchema).default([]),
  edges: z.array(CodeGraphEdgeSchema).default([]),
  stats: z.object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    evidenceNodeCount: z.number().int().nonnegative(),
    candidateNodeCount: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

type CodeGraph = z.infer<typeof CodeGraphSchema>;

type ValidatedCodeGraph =
  | { status: 'missing' }
  | { status: 'invalid'; filePath: string; details: unknown }
  | { status: 'available'; filePath: string; graph: CodeGraph };

function getCodeGraphCandidates(): string[] {
  return [
    process.env['PERSONA_QA_CODE_GRAPH_FILE'],
    path.resolve(process.cwd(), 'adapter', 'config', 'code-graph.generated.json'),
    path.resolve(process.cwd(), '..', '..', 'adapter', 'config', 'code-graph.generated.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function loadCodeGraph(): Promise<ValidatedCodeGraph> {
  const filePath = await firstExistingFile(getCodeGraphCandidates());
  if (!filePath) return { status: 'missing' };

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsedJson = JSON.parse(content);
    const parsed = CodeGraphSchema.safeParse(parsedJson);

    if (!parsed.success) {
      return {
        status: 'invalid',
        filePath,
        details: parsed.error.issues,
      };
    }

    return {
      status: 'available',
      filePath,
      graph: parsed.data,
    };
  } catch (error) {
    return {
      status: 'invalid',
      filePath,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeCodeGraph(graph: CodeGraph) {
  const nodeTypes = countBy(graph.nodes.map((node) => node.type));
  const edgeTypes = countBy(graph.edges.map((edge) => edge.type));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const httpCallEndpointEdges = graph.edges.filter((edge) => (
    edge.type === 'calls'
    && nodeById.get(edge.from)?.type === 'http_call'
    && nodeById.get(edge.to)?.type === 'endpoint'
  ));
  const supportEdges = graph.edges.filter((edge) => edge.type === 'supports_capability');
  const supportEdgesByCapability = new Map<string, typeof supportEdges>();
  for (const edge of supportEdges) {
    const list = supportEdgesByCapability.get(edge.to) ?? [];
    list.push(edge);
    supportEdgesByCapability.set(edge.to, list);
  }
  const capabilityMappings = graph.nodes
    .filter((node) => node.type === 'capability_candidate')
    .map((node) => {
      const edges = supportEdgesByCapability.get(node.id) ?? [];
      const sources = edges
        .map((edge) => nodeById.get(edge.from))
        .filter((source): source is NonNullable<typeof source> => Boolean(source));
      const graphMapping = node.metadata['graphMapping'];
      const mapping = graphMapping && typeof graphMapping === 'object' && !Array.isArray(graphMapping)
        ? graphMapping as Record<string, unknown>
        : {};
      return {
        id: node.id,
        capabilityId: typeof node.metadata['capabilityId'] === 'string' ? node.metadata['capabilityId'] : node.label,
        label: node.label,
        status: node.status ?? null,
        mappingStatus: typeof mapping['status'] === 'string'
          ? mapping['status']
          : edges.length > 0 ? 'mapped' : 'unmapped',
        confidence: typeof mapping['confidence'] === 'number'
          ? mapping['confidence']
          : Math.max(0, ...edges.map((edge) => edge.confidence ?? 0)),
        sourceCount: sources.length,
        sources: sources.slice(0, 5).map((source) => ({
          id: source.id,
          type: source.type,
          label: source.label,
          source: source.source ?? null,
        })),
      };
    });
  const scenarioReadiness = graph.nodes
    .filter((node) => ['scenario_candidate', 'scenario_step_candidate'].includes(node.type))
    .map((node) => {
      const graphReadiness = node.metadata['graphReadiness'];
      const readiness = graphReadiness && typeof graphReadiness === 'object' && !Array.isArray(graphReadiness)
        ? graphReadiness as Record<string, unknown>
        : {};
      return {
        id: node.id,
        type: node.type,
        label: node.label,
        status: node.status ?? null,
        readinessStatus: typeof readiness['status'] === 'string' ? readiness['status'] : 'unmapped',
        confidence: typeof readiness['confidence'] === 'number' ? readiness['confidence'] : 0,
        requiredCapabilityCount: typeof readiness['requiredCapabilityCount'] === 'number' ? readiness['requiredCapabilityCount'] : 0,
        mappedCapabilityCount: typeof readiness['mappedCapabilityCount'] === 'number' ? readiness['mappedCapabilityCount'] : 0,
        missingCapabilityIds: Array.isArray(readiness['missingCapabilityIds'])
          ? readiness['missingCapabilityIds'].filter((item): item is string => typeof item === 'string')
          : [],
        supportSourceTypes: Array.isArray(readiness['supportSourceTypes'])
          ? readiness['supportSourceTypes'].filter((item): item is string => typeof item === 'string')
          : [],
      };
    });
  const endpoints = graph.nodes
    .filter((node) => node.type === 'endpoint')
    .slice(0, 12)
    .map((node) => ({
      id: node.id,
      label: node.label,
      source: node.source ?? null,
      method: typeof node.metadata['method'] === 'string' ? node.metadata['method'] : null,
      path: typeof node.metadata['path'] === 'string' ? node.metadata['path'] : null,
    }));
  const httpCalls = graph.nodes
    .filter((node) => node.type === 'http_call')
    .slice(0, 12)
    .map((node) => ({
      id: node.id,
      label: node.label,
      source: node.source ?? null,
      method: typeof node.metadata['method'] === 'string' ? node.metadata['method'] : null,
      url: typeof node.metadata['url'] === 'string' ? node.metadata['url'] : null,
      normalizedPath: typeof node.metadata['normalizedPath'] === 'string' ? node.metadata['normalizedPath'] : null,
    }));

  return {
    targetId: graph.targetId,
    repositoryKind: graph.repositoryKind,
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    evidenceNodeCount: graph.stats.evidenceNodeCount,
    candidateNodeCount: graph.stats.candidateNodeCount,
    endpointCount: nodeTypes['endpoint'] ?? 0,
    httpCallCount: nodeTypes['http_call'] ?? 0,
    linkedHttpCallCount: httpCallEndpointEdges.length,
    capabilitySupportEdgeCount: supportEdges.length,
    mappedCapabilityCount: capabilityMappings.filter((mapping) => mapping.mappingStatus === 'mapped').length,
    unmappedCapabilityCount: capabilityMappings.filter((mapping) => mapping.mappingStatus !== 'mapped').length,
    fullyMappedScenarioCount: scenarioReadiness.filter((item) => item.type === 'scenario_candidate' && item.readinessStatus === 'fully_mapped').length,
    partiallyMappedScenarioCount: scenarioReadiness.filter((item) => item.type === 'scenario_candidate' && item.readinessStatus === 'partially_mapped').length,
    unmappedScenarioCount: scenarioReadiness.filter((item) => item.type === 'scenario_candidate' && item.readinessStatus === 'unmapped').length,
    nodeTypes,
    edgeTypes,
    endpoints,
    httpCalls,
    capabilityMappings,
    scenarioReadiness,
  };
}

function countBy(items: string[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});
}

export async function codeGraphRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/p2/code-graph', async (_request, reply) => {
    const loaded = await loadCodeGraph();
    if (loaded.status === 'missing') {
      return reply.send({
        available: false,
        filePath: null,
        summary: null,
        graph: null,
      });
    }

    if (loaded.status === 'invalid') {
      return reply.status(422).send({
        available: false,
        filePath: loaded.filePath,
        error: 'Invalid code graph',
        details: loaded.details,
      });
    }

    return reply.send({
      available: true,
      filePath: loaded.filePath,
      summary: summarizeCodeGraph(loaded.graph),
      graph: loaded.graph,
    });
  });
}
