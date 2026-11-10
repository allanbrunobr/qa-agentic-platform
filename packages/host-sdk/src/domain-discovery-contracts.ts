import { z } from 'zod'

export const DOMAIN_DISCOVERY_SCHEMA_VERSION = 'domain-discovery/v1'
export const MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND = 50
export const MAX_EXTRACTED_TEXT_CHARS = 1_000
export const MAX_EVIDENCE_REF_COUNT = 20

export const FrontendEvidenceKindSchema = z.enum([
  'route',
  'component',
  'form',
  'button',
  'text',
  'navigation',
  'package',
  'framework',
  'test',
])
export type FrontendEvidenceKind = z.infer<typeof FrontendEvidenceKindSchema>

export const DiscoveryCandidateStatusSchema = z.enum([
  'draft',
  'runnable_candidate',
  'restricted',
  'needs_human_mapping',
])
export type DiscoveryCandidateStatus = z.infer<typeof DiscoveryCandidateStatusSchema>

export const DiscoveryRiskSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(['low', 'medium', 'high']),
  reason: z.string().min(1).max(500),
})
export type DiscoveryRisk = z.infer<typeof DiscoveryRiskSchema>

export const SourceLocationSchema = z.object({
  filePath: z.string().min(1).max(512),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})
export type SourceLocation = z.infer<typeof SourceLocationSchema>

const EvidenceMetadataSchema = z.record(z.string(), z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
])).default({})

function evidenceItemSchema(kind: FrontendEvidenceKind) {
  return z.object({
    id: z.string().min(1).max(120),
    kind: z.literal(kind),
    source: SourceLocationSchema,
    label: z.string().min(1).max(200).optional(),
    extractedText: z.string().max(MAX_EXTRACTED_TEXT_CHARS).default(''),
    metadata: EvidenceMetadataSchema,
  })
}

export const RouteEvidenceSchema = evidenceItemSchema('route').extend({
  path: z.string().min(1).max(300),
})
export type RouteEvidence = z.infer<typeof RouteEvidenceSchema>

export const ComponentEvidenceSchema = evidenceItemSchema('component').extend({
  componentName: z.string().min(1).max(160),
})
export type ComponentEvidence = z.infer<typeof ComponentEvidenceSchema>

export const FormEvidenceSchema = evidenceItemSchema('form').extend({
  fields: z.array(z.string().min(1).max(160)).max(40).default([]),
  actionName: z.string().min(1).max(160).optional(),
})
export type FormEvidence = z.infer<typeof FormEvidenceSchema>

export const ButtonEvidenceSchema = evidenceItemSchema('button').extend({
  buttonText: z.string().min(1).max(200),
  nearbyFormId: z.string().min(1).max(120).optional(),
})
export type ButtonEvidence = z.infer<typeof ButtonEvidenceSchema>

export const TextEvidenceSchema = evidenceItemSchema('text').extend({
  textRole: z.enum(['heading', 'label', 'body', 'empty_state', 'validation', 'unknown']).default('unknown'),
})
export type TextEvidence = z.infer<typeof TextEvidenceSchema>

export const NavigationEvidenceSchema = evidenceItemSchema('navigation').extend({
  targetPath: z.string().min(1).max(300).optional(),
})
export type NavigationEvidence = z.infer<typeof NavigationEvidenceSchema>

export const PackageEvidenceSchema = evidenceItemSchema('package').extend({
  packageName: z.string().min(1).max(160),
  versionRange: z.string().max(120).optional(),
})
export type PackageEvidence = z.infer<typeof PackageEvidenceSchema>

export const FrameworkEvidenceSchema = evidenceItemSchema('framework').extend({
  frameworkName: z.string().min(1).max(160),
})
export type FrameworkEvidence = z.infer<typeof FrameworkEvidenceSchema>

export const TestEvidenceSchema = evidenceItemSchema('test').extend({
  testName: z.string().min(1).max(240),
  tool: z.string().min(1).max(120).optional(),
})
export type TestEvidence = z.infer<typeof TestEvidenceSchema>

export const FrontendSurfaceMapSchema = z.object({
  schemaVersion: z.literal(DOMAIN_DISCOVERY_SCHEMA_VERSION).default(DOMAIN_DISCOVERY_SCHEMA_VERSION),
  targetId: z.string().min(1).max(160),
  repositoryRootName: z.string().min(1).max(160).optional(),
  generatedAt: z.string().datetime().optional(),
  routes: z.array(RouteEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  components: z.array(ComponentEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  forms: z.array(FormEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  buttons: z.array(ButtonEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  texts: z.array(TextEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  navigation: z.array(NavigationEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  packages: z.array(PackageEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  frameworks: z.array(FrameworkEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
  tests: z.array(TestEvidenceSchema).max(MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).default([]),
})
export type FrontendSurfaceMap = z.infer<typeof FrontendSurfaceMapSchema>

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1).max(120),
  kind: FrontendEvidenceKindSchema.optional(),
})
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

const CandidateBaseSchema = z.object({
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_REF_COUNT),
  risks: z.array(DiscoveryRiskSchema).default([]),
  status: DiscoveryCandidateStatusSchema,
})

export const DomainEntitySchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  kind: z.enum(['person', 'organization', 'record', 'transaction', 'content', 'workflow', 'unknown']).default('unknown'),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_REF_COUNT),
})
export type DomainEntity = z.infer<typeof DomainEntitySchema>

export const DomainInferenceSchema = CandidateBaseSchema.extend({
  domain: z.string().min(1).max(120),
  label: z.string().min(1).max(160).optional(),
  summary: z.string().min(1).max(1_000),
  entities: z.array(DomainEntitySchema).max(30).default([]),
})
export type DomainInference = z.infer<typeof DomainInferenceSchema>

export const PersonaCandidateSchema = CandidateBaseSchema.extend({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  rationale: z.string().min(1).max(1_000),
  goals: z.array(z.string().min(1).max(240)).min(1).max(10),
  allowedCapabilityIds: z.array(z.string().min(1).max(120)).max(30).default([]),
})
export type PersonaCandidate = z.infer<typeof PersonaCandidateSchema>

export const ScenarioStepCandidateSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(500),
  capabilityId: z.string().min(1).max(120).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_REF_COUNT),
})
export type ScenarioStepCandidate = z.infer<typeof ScenarioStepCandidateSchema>

export const ScenarioCandidateSchema = CandidateBaseSchema.extend({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(1_000),
  participatingPersonaIds: z.array(z.string().min(1).max(120)).min(1).max(12),
  requiredCapabilityIds: z.array(z.string().min(1).max(120)).max(30).default([]),
  steps: z.array(ScenarioStepCandidateSchema).min(1).max(30),
})
export type ScenarioCandidate = z.infer<typeof ScenarioCandidateSchema>

export const CapabilityCandidateSchema = CandidateBaseSchema.extend({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(1_000),
  kind: z.enum([
    'navigation',
    'input_fill',
    'form_submit',
    'button_click',
    'assertion',
    'api_call',
    'cli_command',
    'inspection',
    'unknown',
  ]),
  mappedSurfaceIds: z.array(z.string().min(1).max(120)).max(30).default([]),
  selectorHints: z.array(z.string().min(1).max(240)).max(20).default([]),
})
export type CapabilityCandidate = z.infer<typeof CapabilityCandidateSchema>

export const DiscoveryAuditFindingSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(['info', 'warning', 'blocker']),
  message: z.string().min(1).max(1_000),
  candidateIds: z.array(z.string().min(1).max(120)).max(20).default([]),
  evidenceRefs: z.array(EvidenceRefSchema).max(MAX_EVIDENCE_REF_COUNT).default([]),
})
export type DiscoveryAuditFinding = z.infer<typeof DiscoveryAuditFindingSchema>

export const DiscoveryAuditSchema = CandidateBaseSchema.extend({
  id: z.string().min(1).max(120),
  summary: z.string().min(1).max(1_000),
  findings: z.array(DiscoveryAuditFindingSchema).default([]),
  downgradedCandidateIds: z.array(z.string().min(1).max(120)).default([]),
})
export type DiscoveryAudit = z.infer<typeof DiscoveryAuditSchema>

export const DomainDiscoveryBundleSchema = z.object({
  surfaceMap: FrontendSurfaceMapSchema,
  domain: DomainInferenceSchema,
  personas: z.array(PersonaCandidateSchema).default([]),
  scenarios: z.array(ScenarioCandidateSchema).default([]),
  capabilities: z.array(CapabilityCandidateSchema).default([]),
  audit: DiscoveryAuditSchema.optional(),
})
export type DomainDiscoveryBundle = z.infer<typeof DomainDiscoveryBundleSchema>

export function normalizeFrontendSurfaceMap(input: unknown): FrontendSurfaceMap {
  const candidate = cloneRecord(input)
  for (const key of [
    'routes',
    'components',
    'forms',
    'buttons',
    'texts',
    'navigation',
    'packages',
    'frameworks',
    'tests',
  ] as const) {
    const list = Array.isArray(candidate[key]) ? candidate[key] : []
    candidate[key] = list.slice(0, MAX_SURFACE_EVIDENCE_ITEMS_PER_KIND).map(truncateEvidenceText)
  }
  return FrontendSurfaceMapSchema.parse(candidate)
}

export function collectFrontendEvidenceIds(surfaceMap: FrontendSurfaceMap): Set<string> {
  return new Set(flattenSurfaceEvidence(surfaceMap).map((item) => item.id))
}

export function findMissingEvidenceRefs(surfaceMap: FrontendSurfaceMap, refs: EvidenceRef[]): EvidenceRef[] {
  const ids = collectFrontendEvidenceIds(surfaceMap)
  return refs.filter((ref) => !ids.has(ref.evidenceId))
}

export function assertEvidenceRefsExist(surfaceMap: FrontendSurfaceMap, refs: EvidenceRef[], label: string): void {
  const missing = findMissingEvidenceRefs(surfaceMap, refs)
  if (missing.length > 0) {
    throw new Error(`${label} references missing evidence: ${missing.map((ref) => ref.evidenceId).join(', ')}`)
  }
}

function flattenSurfaceEvidence(surfaceMap: FrontendSurfaceMap) {
  return [
    ...surfaceMap.routes,
    ...surfaceMap.components,
    ...surfaceMap.forms,
    ...surfaceMap.buttons,
    ...surfaceMap.texts,
    ...surfaceMap.navigation,
    ...surfaceMap.packages,
    ...surfaceMap.frameworks,
    ...surfaceMap.tests,
  ]
}

function cloneRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return { ...(input as Record<string, unknown>) }
}

function truncateEvidenceText(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const record = { ...(item as Record<string, unknown>) }
  if (typeof record['extractedText'] === 'string' && record['extractedText'].length > MAX_EXTRACTED_TEXT_CHARS) {
    record['extractedText'] = record['extractedText'].slice(0, MAX_EXTRACTED_TEXT_CHARS)
  }
  return record
}
