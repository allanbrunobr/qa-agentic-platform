import {
  DomainDiscoveryBundleSchema,
  assertEvidenceRefsExist,
  type CapabilityCandidate,
  type DiscoveryAudit,
  type DomainDiscoveryBundle,
  type DomainEntity,
  type DomainInference,
  type EvidenceRef,
  type FrontendEvidenceKind,
  type FrontendSurfaceMap,
  type PersonaCandidate,
  type ScenarioCandidate,
  type ScenarioStepCandidate,
} from '../../../host-sdk/src/domain-discovery-contracts.ts'
import { ZodError } from 'zod'

export class DiscoveryValidationError extends Error {
  readonly code = 'discovery_validation_failed'
  readonly statusCode = 422

  constructor() {
    super('Domain discovery did not satisfy the evidence schema.')
    this.name = 'DiscoveryValidationError'
  }
}

export interface DomainSpecialistOptions {
  maxCapabilities?: number
  minDomainConfidence?: number
}

interface EvidenceItem {
  id: string
  kind: FrontendEvidenceKind
  extractedText?: string
  label?: string
  path?: string
  name?: string
  fields?: string[]
}

interface DomainProfile {
  domain: string
  label: string
  summary: string
  keywords: string[]
  entities: Array<{ id: string; name: string; kind: DomainEntity['kind']; keywords: string[] }>
  personas: Array<{ id: string; title: string; goals: string[]; rationale: string }>
  scenarios: Array<{ id: string; title: string; rationale: string }>
}

interface ScoredDomainProfile {
  profile: DomainProfile
  matchedEvidence: EvidenceItem[]
  confidence: number
}

const DEFAULT_MAX_CAPABILITIES = 12
const MAX_FILL_CAPABILITIES = 3
const MAX_SCENARIO_STEPS = 7

const DOMAIN_PROFILES: DomainProfile[] = [
  {
    domain: 'finance',
    label: 'Finance',
    summary: 'Financial workflows such as portfolio review, account management, transfers, invoices, or payments.',
    keywords: ['account', 'allocation', 'balance', 'budget', 'finance', 'invoice', 'payment', 'portfolio', 'transfer'],
    entities: [
      { id: 'account', name: 'Account', kind: 'record', keywords: ['account', 'balance'] },
      { id: 'transfer', name: 'Transfer', kind: 'transaction', keywords: ['transfer', 'payment'] },
      { id: 'portfolio', name: 'Portfolio', kind: 'record', keywords: ['portfolio', 'allocation'] },
    ],
    personas: [
      {
        id: 'account_holder',
        title: 'Account Holder',
        goals: ['Review financial state', 'Complete account transactions'],
        rationale: 'Visible finance workflows imply a user responsible for account activity.',
      },
      {
        id: 'finance_operator',
        title: 'Finance Operator',
        goals: ['Monitor transaction flow', 'Validate financial operations'],
        rationale: 'Financial systems commonly require operational review of account and transaction evidence.',
      },
    ],
    scenarios: [
      {
        id: 'review_financial_state',
        title: 'Review financial state',
        rationale: 'Validates navigation and assertions around balances, accounts, or portfolio evidence.',
      },
      {
        id: 'submit_financial_operation',
        title: 'Submit financial operation',
        rationale: 'Validates forms and actions used for transfer, invoice, or payment flows.',
      },
    ],
  },
  {
    domain: 'education',
    label: 'Education',
    summary: 'Learning workflows such as courses, assignments, enrollment, grades, students, or classrooms.',
    keywords: ['assignment', 'classroom', 'course', 'education', 'enroll', 'grade', 'lesson', 'student'],
    entities: [
      { id: 'student', name: 'Student', kind: 'person', keywords: ['student', 'learner'] },
      { id: 'course', name: 'Course', kind: 'content', keywords: ['course', 'lesson'] },
      { id: 'assignment', name: 'Assignment', kind: 'workflow', keywords: ['assignment', 'grade'] },
    ],
    personas: [
      {
        id: 'student',
        title: 'Student',
        goals: ['Find learning material', 'Complete learning tasks'],
        rationale: 'Course and assignment evidence indicates learner-facing workflows.',
      },
      {
        id: 'course_coordinator',
        title: 'Course Coordinator',
        goals: ['Manage enrollment', 'Review course progress'],
        rationale: 'Enrollment and assignment evidence implies staff workflows around learning operations.',
      },
    ],
    scenarios: [
      {
        id: 'manage_course_access',
        title: 'Manage course access',
        rationale: 'Validates course discovery and enrollment evidence.',
      },
      {
        id: 'review_learning_work',
        title: 'Review learning work',
        rationale: 'Validates assignments, grades, or learning task evidence.',
      },
    ],
  },
  {
    domain: 'commerce',
    label: 'Commerce',
    summary: 'Buying workflows such as catalog browsing, carts, checkout, shipping, orders, or customer identity.',
    keywords: ['cart', 'catalog', 'checkout', 'customer', 'order', 'product', 'shipping', 'store'],
    entities: [
      { id: 'product', name: 'Product', kind: 'content', keywords: ['product', 'catalog'] },
      { id: 'order', name: 'Order', kind: 'transaction', keywords: ['order', 'checkout'] },
      { id: 'customer', name: 'Customer', kind: 'person', keywords: ['customer', 'shipping'] },
    ],
    personas: [
      {
        id: 'shopper',
        title: 'Shopper',
        goals: ['Browse products', 'Complete checkout'],
        rationale: 'Catalog and checkout evidence indicates buyer-facing workflows.',
      },
      {
        id: 'store_operator',
        title: 'Store Operator',
        goals: ['Validate order flow', 'Monitor checkout reliability'],
        rationale: 'Commerce workflows require operational confidence in checkout and order submission.',
      },
    ],
    scenarios: [
      {
        id: 'browse_products',
        title: 'Browse products',
        rationale: 'Validates catalog and product navigation evidence.',
      },
      {
        id: 'place_order',
        title: 'Place order',
        rationale: 'Validates checkout form and order action evidence.',
      },
    ],
  },
  {
    domain: 'support',
    label: 'Support',
    summary: 'Support workflows such as tickets, escalation, customer service, priority handling, or knowledge bases.',
    keywords: ['case', 'customer', 'escalate', 'knowledge base', 'priority', 'service level', 'support', 'ticket'],
    entities: [
      { id: 'ticket', name: 'Ticket', kind: 'record', keywords: ['ticket', 'case'] },
      { id: 'customer', name: 'Customer', kind: 'person', keywords: ['customer'] },
      { id: 'escalation', name: 'Escalation', kind: 'workflow', keywords: ['escalate', 'priority', 'service level'] },
    ],
    personas: [
      {
        id: 'support_agent',
        title: 'Support Agent',
        goals: ['Triage customer issues', 'Escalate priority work'],
        rationale: 'Ticket and escalation evidence indicates support agent workflows.',
      },
      {
        id: 'customer',
        title: 'Customer',
        goals: ['Request support', 'Receive issue resolution'],
        rationale: 'Customer support surfaces imply a requester or affected customer persona.',
      },
    ],
    scenarios: [
      {
        id: 'triage_ticket',
        title: 'Triage ticket',
        rationale: 'Validates ticket queue and priority evidence.',
      },
      {
        id: 'escalate_ticket',
        title: 'Escalate ticket',
        rationale: 'Validates escalation action and service level evidence.',
      },
    ],
  },
  {
    domain: 'logistics',
    label: 'Logistics',
    summary: 'Fulfilment workflows such as shipments, warehouses, dispatch, carriers, parcels, or freight tracking.',
    keywords: ['carrier', 'dispatch', 'freight', 'parcel', 'shipment', 'warehouse'],
    entities: [
      { id: 'shipment', name: 'Shipment', kind: 'record', keywords: ['shipment', 'parcel', 'freight'] },
      { id: 'warehouse', name: 'Warehouse', kind: 'organization', keywords: ['warehouse'] },
      { id: 'dispatch', name: 'Dispatch', kind: 'workflow', keywords: ['dispatch', 'carrier'] },
    ],
    personas: [
      {
        id: 'dispatcher',
        title: 'Dispatcher',
        goals: ['Create shipments', 'Finish dispatch runs'],
        rationale: 'Shipment creation and dispatch evidence indicates a dispatcher-facing workflow.',
      },
      {
        id: 'warehouse_operator',
        title: 'Warehouse Operator',
        goals: ['Review dispatch reports', 'Verify tracking summaries'],
        rationale: 'Dispatch report review and tracking summaries imply a warehouse operator acting as reviewer for validation workflows.',
      },
    ],
    scenarios: [
      {
        id: 'create_shipment',
        title: 'Create shipment',
        rationale: 'Validates shipment start, label generation, and dispatch closure evidence.',
      },
      {
        id: 'review_dispatch_report',
        title: 'Review dispatch report',
        rationale: 'Validates generated dispatch report, tracking summary, and review evidence.',
      },
    ],
  },
  {
    domain: 'technology',
    label: 'Technology',
    summary: 'Delivery workflows such as deployments, incidents, releases, environments, versions, or feature flags.',
    keywords: ['deployment', 'environment', 'feature flag', 'incident', 'release', 'rollback', 'version'],
    entities: [
      { id: 'release', name: 'Release', kind: 'workflow', keywords: ['release', 'version'] },
      { id: 'environment', name: 'Environment', kind: 'record', keywords: ['environment'] },
      { id: 'incident', name: 'Incident', kind: 'record', keywords: ['incident'] },
    ],
    personas: [
      {
        id: 'release_manager',
        title: 'Release Manager',
        goals: ['Promote releases', 'Validate deployment readiness'],
        rationale: 'Deployment and release evidence indicates release management workflows.',
      },
      {
        id: 'incident_responder',
        title: 'Incident Responder',
        goals: ['Review incidents', 'Protect production stability'],
        rationale: 'Incident and environment evidence implies operational response workflows.',
      },
    ],
    scenarios: [
      {
        id: 'promote_release',
        title: 'Promote release',
        rationale: 'Validates release promotion form and environment evidence.',
      },
      {
        id: 'review_incident',
        title: 'Review incident',
        rationale: 'Validates incident navigation and operational review evidence.',
      },
    ],
  },
]

const UNKNOWN_PROFILE: DomainProfile = {
  domain: 'unknown',
  label: 'Unknown',
  summary: 'The frontend has visible surfaces, but domain evidence is too weak for a specific classification.',
  keywords: [],
  entities: [{ id: 'visible_surface', name: 'Visible Surface', kind: 'unknown', keywords: [] }],
  personas: [{
    id: 'primary_user',
    title: 'Primary User',
    goals: ['Exercise the visible application flow'],
    rationale: 'Fallback persona used when domain evidence is weak.',
  }],
  scenarios: [{
    id: 'primary_user_smoke',
    title: 'Primary user smoke',
    rationale: 'Fallback scenario used until a domain-specific workflow is identified.',
  }],
}

export class DomainSpecialistService {
  infer(surfaceMap: FrontendSurfaceMap, options: DomainSpecialistOptions = {}): DomainDiscoveryBundle {
    return inferDomainDiscoveryBundle(surfaceMap, options)
  }
}

export function inferDomainDiscoveryBundle(
  surfaceMap: FrontendSurfaceMap,
  options: DomainSpecialistOptions = {},
): DomainDiscoveryBundle {
  const scored = scoreDomainProfiles(surfaceMap)
  const minDomainConfidence = options.minDomainConfidence ?? 0.42
  const selected = scored.confidence >= minDomainConfidence ? scored : fallbackScore(surfaceMap)
  const evidenceRefs = evidenceRefsFromItems(selected.matchedEvidence).slice(0, 20)
  const capabilities = buildCapabilities(surfaceMap, selected, options.maxCapabilities ?? DEFAULT_MAX_CAPABILITIES)
  const personas = buildPersonas(selected, capabilities)
  const scenarios = buildScenarios(surfaceMap, selected, personas, capabilities)
  const domain = buildDomainInference(selected, evidenceRefs)
  const audit = buildAudit(surfaceMap, selected, capabilities, scenarios)

  try {
    assertEvidenceRefsExist(surfaceMap, domain.evidenceRefs, `domain:${domain.domain}`)
    for (const candidate of [...personas, ...scenarios, ...capabilities, audit]) {
      assertEvidenceRefsExist(surfaceMap, candidate.evidenceRefs, candidate.id)
    }
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        assertEvidenceRefsExist(surfaceMap, step.evidenceRefs, step.id)
      }
    }

    return DomainDiscoveryBundleSchema.parse({
      surfaceMap,
      domain,
      personas,
      scenarios,
      capabilities,
      audit,
    })
  } catch (error) {
    if (error instanceof DiscoveryValidationError) throw error
    if (error instanceof ZodError || (error instanceof Error && error.message.includes('references missing evidence'))) {
      throw new DiscoveryValidationError()
    }
    throw error
  }
}

function scoreDomainProfiles(surfaceMap: FrontendSurfaceMap): ScoredDomainProfile {
  const evidence = collectEvidence(surfaceMap)
  const ranked = DOMAIN_PROFILES.map((profile) => {
    const matchedEvidence = evidence.filter((item) => profile.keywords.some((keyword) => evidenceMatches(item, keyword)))
    const uniqueKeywordHits = new Set(
      profile.keywords.filter((keyword) => matchedEvidence.some((item) => evidenceMatches(item, keyword))),
    ).size
    const confidence = Math.min(0.94, 0.22 + matchedEvidence.length * 0.065 + uniqueKeywordHits * 0.045)
    return { profile, matchedEvidence: uniqueByEvidence(matchedEvidence), confidence }
  }).sort((a, b) => b.confidence - a.confidence || b.matchedEvidence.length - a.matchedEvidence.length)

  return ranked[0] ?? fallbackScore(surfaceMap)
}

function fallbackScore(surfaceMap: FrontendSurfaceMap): ScoredDomainProfile {
  const matchedEvidence = collectEvidence(surfaceMap).slice(0, 8)
  return {
    profile: UNKNOWN_PROFILE,
    matchedEvidence,
    confidence: matchedEvidence.length > 0 ? 0.35 : 0.2,
  }
}

function buildDomainInference(selected: ScoredDomainProfile, evidenceRefs: EvidenceRef[]): DomainInference {
  const status = selected.profile.domain === 'unknown' ? 'needs_human_mapping' : 'draft'
  return {
    domain: selected.profile.domain,
    label: selected.profile.label,
    summary: selected.profile.summary,
    confidence: selected.confidence,
    evidenceRefs,
    status,
    risks: selected.profile.domain === 'unknown'
      ? [{ id: 'weak_domain_evidence', severity: 'medium', reason: 'Domain-specific evidence was below the configured confidence threshold.' }]
      : [],
    entities: selected.profile.entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      confidence: entity.keywords.length === 0
        ? selected.confidence
        : Math.min(0.9, 0.35 + selected.matchedEvidence.filter((item) => entity.keywords.some((keyword) => evidenceMatches(item, keyword))).length * 0.12),
      evidenceRefs: evidenceRefsFromItems(
        selected.matchedEvidence.filter((item) => entity.keywords.length === 0 || entity.keywords.some((keyword) => evidenceMatches(item, keyword))),
      ).slice(0, 5),
    })).filter((entity) => entity.evidenceRefs.length > 0),
  }
}

function buildPersonas(selected: ScoredDomainProfile, capabilities: CapabilityCandidate[]): PersonaCandidate[] {
  const evidenceRefs = evidenceRefsFromItems(selected.matchedEvidence).slice(0, 10)
  return selected.profile.personas.map((persona, index) => ({
    id: persona.id,
    title: persona.title,
    rationale: persona.rationale,
    goals: persona.goals,
    allowedCapabilityIds: selectPersonaCapabilities(persona, capabilities),
    confidence: Math.max(0.35, selected.confidence - index * 0.04),
    evidenceRefs,
    status: 'draft',
    risks: [],
  }))
}

function buildScenarios(
  surfaceMap: FrontendSurfaceMap,
  selected: ScoredDomainProfile,
  personas: PersonaCandidate[],
  capabilities: CapabilityCandidate[],
): ScenarioCandidate[] {
  return selected.profile.scenarios.map((scenario, index) => {
    const steps = buildScenarioSteps(surfaceMap, capabilities, scenario)
    const evidenceRefs = uniqueEvidenceRefs([
      ...evidenceRefsFromItems(selected.matchedEvidence).slice(0, 8),
      ...steps.flatMap((step) => step.evidenceRefs),
    ]).slice(0, 20)
    return {
      id: scenario.id,
      title: scenario.title,
      rationale: scenario.rationale,
      participatingPersonaIds: personas.map((persona) => persona.id).slice(0, 2),
      requiredCapabilityIds: capabilities.map((capability) => capability.id).slice(0, 8),
      steps,
      confidence: Math.max(0.35, selected.confidence - 0.08 - index * 0.04),
      evidenceRefs,
      status: 'needs_human_mapping',
      risks: [{
        id: 'selector_mapping_required',
        severity: 'medium',
        reason: 'Generated scenario is evidence-backed but still needs host-specific selector and auth mapping before it becomes runnable.',
      }],
    }
  })
}

function buildScenarioSteps(
  surfaceMap: FrontendSurfaceMap,
  capabilities: CapabilityCandidate[],
  scenario: DomainProfile['scenarios'][number],
): ScenarioStepCandidate[] {
  const navigationCapabilities = rankScenarioCapabilities(capabilities, scenario, 'navigation')
  const formCapabilities = rankScenarioCapabilities(capabilities, scenario, 'form_submit')
  const buttonCapabilities = rankScenarioCapabilities(capabilities, scenario, 'button_click')
  const assertionCapabilities = rankScenarioCapabilities(capabilities, scenario, 'assertion')
  const fillCapabilities = capabilities.filter((capability) => capability.kind === 'input_fill')
  const actionCandidates = [...formCapabilities, ...buttonCapabilities]
  const interactionCandidates = actionCandidates.length > 0
    ? actionCandidates
    : navigationCapabilities.slice(1)

  // Executable order: land on the page, fill required inputs, act, then assert.
  // Terminal actions (submit/checkout/confirm) go after preparatory ones such
  // as "add item", otherwise the terminal control is still disabled.
  const preferredCapabilities = uniqueCapabilities([
    navigationCapabilities[0],
    ...fillCapabilities,
    ...orderTerminalActionsLast(selectScenarioSequence(interactionCandidates, scenario)),
    assertionCapabilities[0],
  ].filter((capability): capability is CapabilityCandidate => Boolean(capability))).slice(0, MAX_SCENARIO_STEPS)

  if (preferredCapabilities.length > 0) {
    return preferredCapabilities.map((capability, index) => ({
      id: `step_${index + 1}_${capability.id}`.slice(0, 120),
      title: capability.title,
      intent: capability.purpose,
      capabilityId: capability.id,
      evidenceRefs: capability.evidenceRefs.slice(0, 5),
    }))
  }

  const fallbackEvidence = evidenceRefsFromItems(collectEvidence(surfaceMap)).slice(0, 5)
  return [{
    id: 'step_1_inspect_visible_surface',
    title: 'Inspect visible surface',
    intent: 'Open and inspect the primary visible application surface.',
    capabilityId: undefined,
    evidenceRefs: fallbackEvidence,
  }]
}

const TERMINAL_ACTION_PATTERN = /\b(submit|checkout|confirm|confirmar|place order|finish|finalizar|enviar|send|pay|pagar|encerrar)\b/

function orderTerminalActionsLast(capabilities: CapabilityCandidate[]) {
  const isTerminal = (capability: CapabilityCandidate) =>
    TERMINAL_ACTION_PATTERN.test(normalizeScenarioCapabilityText(capability))
  return [
    ...capabilities.filter((capability) => !isTerminal(capability)),
    ...capabilities.filter(isTerminal),
  ]
}

function rankScenarioCapabilities(
  capabilities: CapabilityCandidate[],
  scenario: DomainProfile['scenarios'][number],
  kind: CapabilityCandidate['kind'],
) {
  return capabilities
    .filter((capability) => capability.kind === kind)
    .sort((left, right) => scoreScenarioCapability(right, scenario) - scoreScenarioCapability(left, scenario))
}

function selectScenarioSequence(
  interactionCandidates: CapabilityCandidate[],
  scenario: DomainProfile['scenarios'][number],
) {
  const selected: CapabilityCandidate[] = []
  const scenarioText = normalize([scenario.id, scenario.title, scenario.rationale].join(' '))

  if (scenarioText.includes('create shipment')) {
    pushFirstMatch(selected, interactionCandidates, /\b(start|begin|open)\b/)
    pushFirstMatch(selected, interactionCandidates, /\b(generate|report|label)\b/)
    pushFirstMatch(selected, interactionCandidates, /\b(finish|end|close)\b/)
  }

  if (scenarioText.includes('report')) {
    pushFirstMatch(selected, interactionCandidates, /\b(generate|report)\b/)
    pushFirstMatch(selected, interactionCandidates, /\b(summary|copy|clipboard)\b/)
    pushFirstMatch(selected, interactionCandidates, /\b(review|validate|verif|assert)\b/)
  }

  for (const capability of interactionCandidates) {
    if (selected.length >= 3) break
    if (selected.some((item) => item.id === capability.id)) continue
    if (isScenarioCapabilityOutOfBand(capability, scenario)) continue
    selected.push(capability)
  }

  return selected
}

function pushFirstMatch(
  selected: CapabilityCandidate[],
  candidates: CapabilityCandidate[],
  pattern: RegExp,
) {
  const match = candidates.find((capability) => {
    if (selected.some((item) => item.id === capability.id)) return false
    return pattern.test(normalizeScenarioCapabilityText(capability))
  })
  if (match) selected.push(match)
}

function isScenarioCapabilityOutOfBand(
  capability: CapabilityCandidate,
  scenario: DomainProfile['scenarios'][number],
) {
  const scenarioText = normalize([scenario.id, scenario.title, scenario.rationale].join(' '))
  const capabilityText = normalizeScenarioCapabilityText(capability)

  if (scenarioText.includes('create shipment')) {
    return /\b(copy|clipboard)\b/.test(capabilityText)
  }

  if (scenarioText.includes('report')) {
    return /\b(start|begin|end|finish|new)\b/.test(capabilityText)
  }

  return false
}

function normalizeScenarioCapabilityText(capability: CapabilityCandidate) {
  return normalize([
    capability.id,
    capability.title,
    capability.purpose,
    ...(capability.selectorHints ?? []),
  ].join(' '))
}

function buildCapabilities(
  surfaceMap: FrontendSurfaceMap,
  selected: ScoredDomainProfile,
  maxCapabilities: number,
): CapabilityCandidate[] {
  const capabilities: CapabilityCandidate[] = []
  const matchedRefs = evidenceRefsFromItems(selected.matchedEvidence).slice(0, 8)

  for (const route of surfaceMap.routes.slice(0, 4)) {
    capabilities.push({
      id: makeId('open', route.path),
      title: `Open ${route.label ?? route.path}`,
      purpose: `Navigate to ${route.path}.`,
      kind: 'navigation',
      mappedSurfaceIds: [route.id],
      selectorHints: [route.path],
      confidence: 0.68,
      evidenceRefs: [{ evidenceId: route.id, kind: 'route' }],
      status: 'needs_human_mapping',
      risks: [],
    })
  }

  const prioritizedNavigation = [...surfaceMap.navigation]
    .sort((left, right) => scoreNavigationSurface(right) - scoreNavigationSurface(left))
    .slice(0, 4)

  for (const nav of prioritizedNavigation) {
    if (scoreNavigationSurface(nav) < 0) continue
    capabilities.push({
      id: makeId('navigate', nav.targetPath ?? nav.extractedText),
      title: `Navigate ${nav.extractedText || nav.targetPath || 'link'}`,
      purpose: `Use navigation evidence pointing to ${nav.targetPath ?? nav.extractedText}.`,
      kind: 'navigation',
      mappedSurfaceIds: [nav.id],
      selectorHints: [nav.extractedText, nav.targetPath].filter((value): value is string => Boolean(value)),
      confidence: 0.65,
      evidenceRefs: [{ evidenceId: nav.id, kind: 'navigation' }],
      status: 'needs_human_mapping',
      risks: [],
    })
  }

  const fillableFields = surfaceMap.forms
    .slice(0, 4)
    .flatMap((form) => form.fields.map((field) => ({ form, field })))
    .filter(({ field }) => !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(field))
    .slice(0, MAX_FILL_CAPABILITIES)

  for (const { form, field } of fillableFields) {
    capabilities.push({
      id: makeId('fill', field),
      title: `Fill ${field}`,
      purpose: `Fill the visible "${field}" field.`,
      kind: 'input_fill',
      mappedSurfaceIds: [form.id],
      selectorHints: [field],
      confidence: 0.66,
      evidenceRefs: [{ evidenceId: form.id, kind: 'form' }],
      status: 'needs_human_mapping',
      risks: [],
    })
  }

  for (const form of surfaceMap.forms.slice(0, 4)) {
    if (form.metadata?.['implicit'] === true) continue
    capabilities.push({
      id: makeId('submit', selected.profile.domain, form.actionName ?? form.id),
      title: `Submit ${selected.profile.label} form`,
      purpose: `Fill and submit a form with fields: ${form.fields.slice(0, 5).join(', ') || 'detected fields'}.`,
      kind: 'form_submit',
      mappedSurfaceIds: [form.id],
      selectorHints: form.fields,
      confidence: 0.72,
      evidenceRefs: [{ evidenceId: form.id, kind: 'form' }],
      status: 'needs_human_mapping',
      risks: [],
    })
  }

  const prioritizedButtons = [...surfaceMap.buttons]
    .sort((left, right) => scoreButtonSurface(right, selected) - scoreButtonSurface(left, selected))
    .slice(0, 6)

  for (const button of prioritizedButtons) {
    if (scoreButtonSurface(button, selected) < 0) continue
    capabilities.push({
      id: makeId('click', button.buttonText),
      title: `Click ${button.buttonText}`,
      purpose: `Activate the visible "${button.buttonText}" action.`,
      kind: 'button_click',
      mappedSurfaceIds: [button.id],
      selectorHints: [button.buttonText],
      confidence: 0.62,
      evidenceRefs: [{ evidenceId: button.id, kind: 'button' }],
      status: 'needs_human_mapping',
      risks: [],
    })
  }

  const assertionRef = matchedRefs[0] ?? evidenceRefsFromItems(collectEvidence(surfaceMap))[0]
  if (assertionRef) {
    capabilities.push({
      id: makeId('assert', selected.profile.domain, 'visible_state'),
      title: `Assert ${selected.profile.label} visible state`,
      purpose: 'Verify that the expected domain-specific UI state is visible after interaction.',
      kind: 'assertion',
      mappedSurfaceIds: [assertionRef.evidenceId],
      selectorHints: selected.profile.keywords.slice(0, 5),
      confidence: 0.58,
      evidenceRefs: [assertionRef],
      status: 'needs_human_mapping',
      risks: [],
    })
  }

  const unique = uniqueCapabilities(capabilities)
  const limited = unique.slice(0, maxCapabilities)
  // Scenarios need a closing assertion; never let the cap drop it.
  const assertion = unique.find((capability) => capability.kind === 'assertion')
  if (assertion && limited.length > 0 && !limited.includes(assertion)) limited[limited.length - 1] = assertion
  return limited
}

function buildAudit(
  surfaceMap: FrontendSurfaceMap,
  selected: ScoredDomainProfile,
  capabilities: CapabilityCandidate[],
  scenarios: ScenarioCandidate[],
): DiscoveryAudit {
  const evidenceRefs = evidenceRefsFromItems(selected.matchedEvidence).slice(0, 12)
  const findings = []

  if (selected.profile.domain === 'unknown') {
    findings.push({
      id: 'domain_not_confirmed',
      severity: 'warning' as const,
      message: 'Domain classification is weak; generated personas and scenarios should remain generic until reviewed.',
      candidateIds: [selected.profile.domain],
      evidenceRefs,
    })
  }

  if (surfaceMap.tests.length === 0) {
    findings.push({
      id: 'no_existing_tests_detected',
      severity: 'warning' as const,
      message: 'No frontend test evidence was detected, so generated scenarios lack corroborating automation examples.',
      candidateIds: scenarios.map((scenario) => scenario.id),
      evidenceRefs,
    })
  }

  findings.push({
    id: 'human_mapping_required',
    severity: 'info' as const,
    message: 'Candidates are evidence-backed drafts; host auth, selectors, data setup, and assertions still require mapping before runnable certification.',
    candidateIds: [...capabilities.map((capability) => capability.id), ...scenarios.map((scenario) => scenario.id)].slice(0, 20),
    evidenceRefs,
  })

  return {
    id: `audit_${selected.profile.domain}`,
    summary: `Domain specialist generated ${selected.profile.label} candidates from static frontend evidence.`,
    confidence: selected.confidence,
    evidenceRefs,
    status: selected.profile.domain === 'unknown' ? 'restricted' : 'needs_human_mapping',
    findings,
    downgradedCandidateIds: scenarios.map((scenario) => scenario.id),
    risks: [],
  }
}

function selectPersonaCapabilities(
  persona: DomainProfile['personas'][number],
  capabilities: CapabilityCandidate[],
) {
  const ranked = [...capabilities]
    .filter((capability) => isCapabilitySuitableForPersona(capability, persona))
    .sort((left, right) => scoreCapabilityForPersona(right, persona) - scoreCapabilityForPersona(left, persona))
  const selected = ranked
    .filter((capability, index) => scoreCapabilityForPersona(capability, persona) > -4 || index < 2)
    .slice(0, 5)

  return uniqueCapabilities(selected).map((capability) => capability.id)
}

function isCapabilitySuitableForPersona(
  capability: CapabilityCandidate,
  persona: DomainProfile['personas'][number],
) {
  const personaText = normalize([persona.title, persona.rationale, ...persona.goals].join(' '))
  const capabilityText = normalize([
    capability.id,
    capability.title,
    capability.purpose,
    ...(capability.selectorHints ?? []),
  ].join(' '))

  if (personaText.includes('reviewer')) {
    return !/\b(start|begin|end|finish|new)\b/.test(capabilityText)
      || /\b(report|summary|assert|verify|review|copy|clipboard)\b/.test(capabilityText)
  }

  return true
}

function scoreCapabilityForPersona(
  capability: CapabilityCandidate,
  persona: DomainProfile['personas'][number],
) {
  const personaText = normalize([persona.title, persona.rationale, ...persona.goals].join(' '))
  const capabilityText = normalize([
    capability.title,
    capability.purpose,
    ...(capability.selectorHints ?? []),
  ].join(' '))

  let score = capabilityStepPriority(capability)

  if (personaText.includes('reviewer')) {
    if (/\b(assert|verify|review|report|summary|copy|clipboard)\b/.test(capabilityText)) {
      score += 8
    }
    if (/\b(start|begin|end|finish|new)\b/.test(capabilityText)) {
      score -= 2
    }
  }

  return score
}

function scoreScenarioCapability(
  capability: CapabilityCandidate,
  scenario: DomainProfile['scenarios'][number],
) {
  const scenarioText = normalize([scenario.id, scenario.title, scenario.rationale].join(' '))
  const capabilityText = normalize([
    capability.title,
    capability.purpose,
    ...(capability.selectorHints ?? []),
  ].join(' '))

  let score = capabilityStepPriority(capability)

  if (scenarioText.includes('create shipment')) {
    if (/\b(start|shipment|finish|end)\b/.test(capabilityText)) score += 8
    if (/\b(report|label|copy|clipboard)\b/.test(capabilityText)) score += 2
  }

  if (scenarioText.includes('report')) {
    if (/\b(report|summary|copy|clipboard|review|assert|verify)\b/.test(capabilityText)) score += 8
    if (/\b(start|begin|end|finish|new)\b/.test(capabilityText)) score -= 6
  }

  return score
}

function capabilityStepPriority(capability: CapabilityCandidate) {
  const text = normalize([
    capability.title,
    capability.purpose,
    ...(capability.selectorHints ?? []),
  ].join(' '))

  let score = 0

  if (capability.kind === 'form_submit') score += 8
  if (capability.kind === 'button_click') score += 6
  if (capability.kind === 'assertion') score += 4
  if (capability.kind === 'navigation') score += 2

  if (/\b(start|begin|open|create|new|generate|finish|end|review|schedule)\b/.test(text)) {
    score += 6
  }

  if (/\b(settings|config|configuration|api key|google ai studio|reload|try again|dismiss|feedback|language|copy|download|print)\b/.test(text)) {
    score -= 6
  }

  return score
}

function scoreNavigationSurface(item: FrontendSurfaceMap['navigation'][number]) {
  const text = normalize([item.extractedText, item.targetPath].filter(Boolean).join(' '))
  let score = 0

  if (item.targetPath?.startsWith('/')) score += 4
  if (/^https?:\/\//.test(item.targetPath ?? '')) score -= 2
  if (/\b(settings|config|configuration|api key|google ai studio|docs|documentation|help)\b/.test(text)) score -= 6

  return score
}

function scoreButtonSurface(item: FrontendSurfaceMap['buttons'][number], selected: ScoredDomainProfile) {
  const text = normalize(item.buttonText)
  let score = 0

  if (isUtilityButtonSurface(text)) return -10

  for (const keyword of selected.profile.keywords) {
    if (text.includes(normalize(keyword))) score += 4
  }

  if (/\b(start|begin|new|generate|end|finish|review|schedule|report|summary)\b/.test(text)) {
    score += 6
  }

  if (/\b(settings|config|configuration|reload|dismiss|feedback|language|copy|download|print|close|cancel|entendido)\b/.test(text)) {
    score -= 5
  }

  return score
}

function isUtilityButtonSurface(text: string) {
  return /\b(settings|config|configuration|reload|dismiss|feedback|language|download|print|close|cancel|entendido|try again|help|docs|documentation)\b/.test(text)
}

function collectEvidence(surfaceMap: FrontendSurfaceMap): EvidenceItem[] {
  return [
    ...surfaceMap.routes.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, label: item.label, path: item.path })),
    ...surfaceMap.components.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, name: item.componentName })),
    ...surfaceMap.forms.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, name: item.actionName, fields: item.fields })),
    ...surfaceMap.buttons.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, label: item.buttonText })),
    ...surfaceMap.texts.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, label: item.label })),
    ...surfaceMap.navigation.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, path: item.targetPath })),
    ...surfaceMap.packages.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, name: item.packageName })),
    ...surfaceMap.frameworks.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, name: item.frameworkName })),
    ...surfaceMap.tests.map((item) => ({ id: item.id, kind: item.kind, extractedText: item.extractedText, name: item.testName })),
  ]
}

function evidenceMatches(item: EvidenceItem, keyword: string) {
  const text = normalize([
    item.extractedText ?? '',
    item.label ?? '',
    item.path ?? '',
    item.name ?? '',
    ...(item.fields ?? []),
  ].join(' '))
  return text.includes(normalize(keyword))
}

function evidenceRefsFromItems(items: EvidenceItem[]): EvidenceRef[] {
  return uniqueEvidenceRefs(items.map((item) => ({ evidenceId: item.id, kind: item.kind })))
}

function uniqueByEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>()
  const unique: EvidenceItem[] = []
  for (const item of items) {
    const key = `${item.kind}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

function uniqueEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>()
  const unique: EvidenceRef[] = []
  for (const ref of refs) {
    const key = `${ref.kind ?? 'unknown'}:${ref.evidenceId}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(ref)
  }
  return unique
}

function uniqueCapabilities(capabilities: CapabilityCandidate[]): CapabilityCandidate[] {
  const seen = new Set<string>()
  const unique: CapabilityCandidate[] = []
  for (const capability of capabilities) {
    if (seen.has(capability.id)) continue
    seen.add(capability.id)
    unique.push(capability)
  }
  return unique
}

function makeId(...parts: Array<string | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part))
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'candidate'
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')
}
