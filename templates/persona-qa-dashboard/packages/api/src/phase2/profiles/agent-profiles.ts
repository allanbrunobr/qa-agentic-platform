import fs from 'node:fs'
import path from 'node:path'
import type { AgentProfile, AgentRole } from '../types/agent-types.js'
import { isGeneratedNonFrontendRuntime } from '../services/generated-adapter-runtime.js'

interface AdapterPersonaModel {
  id: string
  title: string
  goal?: string
  allowedCapabilities?: string[]
}

const ORCHESTRATOR_PROFILE: AgentProfile = {
  role: 'orchestrator',
  name: 'Agentic QA Orchestrator',
  model: 'claude-sonnet-4-6',
  timeoutMs: 120_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  toolPolicy: {
    browserAccess: false,
    deniedTools: ['captureScreenshot', 'collectDomSnippet'],
  },
  evidencePolicy: {
    requireScreenshotForFinding: false,
    requireDomSnippetForFinding: false,
  },
  canBlockRun: true,
  systemPrompt: [
    'You coordinate adapter-generated QA personas for the current target application.',
    'Use only the scenario, contract, capability and artifact context supplied by the runtime.',
    'Do not assume product-specific roles unless they exist in the generated adapter model.',
  ].join('\n'),
}

const REFERENCE_PROFILES: Record<string, AgentProfile> = {
  sales_associate: buildStaticProfile('sales_associate', 'Sales Associate', ['registerCustomer', 'createOrder'], {
    model: 'claude-haiku-4-5-20251001',
    timeoutMs: 90_000,
  }),
  fulfillment_agent: buildStaticProfile('fulfillment_agent', 'Fulfillment Agent', ['openOrderDetails', 'fulfillOrder'], {
    timeoutMs: 180_000,
  }),
  billing_clerk: buildStaticProfile('billing_clerk', 'Billing Clerk', ['findInvoiceByOrderId']),
  store_manager: buildStaticProfile('store_manager', 'Store Manager', [
    'verifyFinanceDashboard',
    'verifyReportsPage',
  ]),
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    retryPolicy: { ...profile.retryPolicy },
    toolPolicy: {
      ...profile.toolPolicy,
      allowedTools: profile.toolPolicy.allowedTools ? [...profile.toolPolicy.allowedTools] : undefined,
      deniedTools: profile.toolPolicy.deniedTools ? [...profile.toolPolicy.deniedTools] : undefined,
    },
    evidencePolicy: { ...profile.evidencePolicy },
    riskPolicy: profile.riskPolicy
      ? {
          allowedRiskLevels: [...profile.riskPolicy.allowedRiskLevels],
          requireApprovalFor: [...profile.riskPolicy.requireApprovalFor],
          denyRiskLevels: [...profile.riskPolicy.denyRiskLevels],
        }
      : undefined,
  }
}

function buildStaticProfile(
  role: string,
  name: string,
  allowedTools: string[],
  overrides: Partial<Pick<AgentProfile, 'model' | 'timeoutMs'>> = {},
): AgentProfile {
  return {
    role,
    name,
    model: overrides.model ?? 'claude-sonnet-4-6',
    timeoutMs: overrides.timeoutMs ?? 120_000,
    retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
    toolPolicy: {
      browserAccess: true,
      allowedTools,
    },
    evidencePolicy: {
      requireScreenshotForFinding: true,
      requireDomSnippetForFinding: false,
    },
    canBlockRun: false,
    systemPrompt: buildGeneratedPersonaPrompt({ id: role, title: name, allowedCapabilities: allowedTools }),
  }
}

function buildGeneratedPersonaPrompt(persona: AdapterPersonaModel): string {
  const capabilities = persona.allowedCapabilities?.length
    ? persona.allowedCapabilities.join(', ')
    : 'the capabilities assigned by the current scenario'

  return [
    `You are the generated QA persona "${persona.title}" for this target application.`,
    `Role id: ${persona.id}.`,
    persona.goal ? `Goal: ${persona.goal}` : 'Goal: validate the assigned workflow from the target user role.',
    `Allowed capabilities: ${capabilities}.`,
    'Follow the runtime scenario contract exactly and return only findings, artifacts, and tool requests grounded in the current target.',
  ].join('\n')
}

function getGeneratedPersonasCandidates(): string[] {
  return [
    process.env['PERSONA_QA_PERSONAS_FILE'],
    path.resolve(process.cwd(), 'adapter', 'personas', 'personas.generated.json'),
    path.resolve(process.cwd(), '..', '..', 'adapter', 'personas', 'personas.generated.json'),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

function readGeneratedPersonas(): AdapterPersonaModel[] {
  for (const candidate of getGeneratedPersonasCandidates()) {
    if (!fs.existsSync(candidate)) continue

    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []

      return parsed
        .filter((persona): persona is AdapterPersonaModel => {
          return (
            typeof persona === 'object'
            && persona !== null
            && typeof (persona as AdapterPersonaModel).id === 'string'
            && typeof (persona as AdapterPersonaModel).title === 'string'
          )
        })
        .map((persona) => ({
          id: persona.id,
          title: persona.title,
          goal: persona.goal,
          allowedCapabilities: Array.isArray(persona.allowedCapabilities) ? persona.allowedCapabilities : [],
        }))
    } catch {
      return []
    }
  }

  return []
}

function profileFromGeneratedPersona(persona: AdapterPersonaModel): AgentProfile {
  const nonFrontendRuntime = isGeneratedNonFrontendRuntime()

  return {
    role: persona.id,
    name: persona.title,
    model: 'claude-sonnet-4-6',
    timeoutMs: 120_000,
    retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
    toolPolicy: {
      browserAccess: !nonFrontendRuntime,
      api: nonFrontendRuntime || undefined,
      file: nonFrontendRuntime || undefined,
      // S-05: no declared capabilities means no tools, not every tool.
      allowedTools: persona.allowedCapabilities ?? [],
    },
    evidencePolicy: {
      requireScreenshotForFinding: !nonFrontendRuntime,
      requireDomSnippetForFinding: false,
    },
    canBlockRun: false,
    systemPrompt: buildGeneratedPersonaPrompt(persona),
  }
}

function referenceProfilesEnabled(): boolean {
  return process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'] === '1'
}

function generatedProfilesByRole(): Map<string, AgentProfile> {
  return new Map(readGeneratedPersonas().map((persona) => [persona.id, profileFromGeneratedPersona(persona)]))
}

export function getProfile(role: AgentRole | string): AgentProfile {
  if (role === 'orchestrator') return cloneProfile(ORCHESTRATOR_PROFILE)

  const generated = generatedProfilesByRole().get(role)
  if (generated) return cloneProfile(generated)

  const reference = referenceProfilesEnabled() ? REFERENCE_PROFILES[role] : undefined
  if (reference) return cloneProfile(reference)

  const generatedRoles = [...generatedProfilesByRole().keys()]
  const available = ['orchestrator', ...generatedRoles, ...(referenceProfilesEnabled() ? Object.keys(REFERENCE_PROFILES) : [])]
  throw new Error(`Unknown agent profile: "${role}". Available: ${available.join(', ')}`)
}

export function listProfiles(): AgentProfile[] {
  const generated = [...generatedProfilesByRole().values()]
  const targetProfiles = generated.length > 0
    ? generated
    : referenceProfilesEnabled()
      ? Object.values(REFERENCE_PROFILES)
      : []

  return [
    cloneProfile(ORCHESTRATOR_PROFILE),
    ...targetProfiles.map(cloneProfile),
  ]
}
