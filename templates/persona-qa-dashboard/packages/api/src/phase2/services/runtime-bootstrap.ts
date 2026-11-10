import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeterministicProvider } from '../providers/deterministic-provider.js'
import { createModelProvider } from '../providers/provider-factory.js'
import { listProfiles } from '../profiles/agent-profiles.js'
import { artifactSensor } from '../sensors/artifact-sensor.js'
import { outputSensor } from '../sensors/output-sensor.js'
import { schemaSensor } from '../sensors/schema-sensor.js'
import { timeoutSensor } from '../sensors/timeout-sensor.js'
import { toolPolicySensor } from '../sensors/tool-policy-sensor.js'
import { AgentRuntime } from './agent-runtime.js'
import { Orchestrator } from './orchestrator.js'
import { defaultRuntimeHookBus } from './runtime-hooks.js'
import { SensorRunner } from './sensor-runner.js'
import { SessionService } from './session-service.js'
import { getSessionService, setSessionService } from '../routes/sessions.js'
import { ToolRegistry } from './tool-registry.js'
import { registerEvidenceTools } from '../tools/evidence-tools.js'
import { registerFindingTools } from '../tools/finding-tools.js'
import { registerGeneratedAdapterTools } from '../tools/generated-adapter-tools.js'
import { registerWorkflowTools } from '../tools/workflow-tools.js'
import type { ModelProvider } from '../types/agent-types.js'
import type { RuntimeProvider } from '../../services/runtime-settings.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const API_PACKAGE_ROOT = path.resolve(__dirname, '../../..')

export interface Phase2RuntimeOptions {
  dbPath?: string
  model?: string
  provider?: ModelProvider
  providerName?: RuntimeProvider
  deterministic?: boolean
}

export function createPhase2Runtime(options: Phase2RuntimeOptions = {}) {
  const dbPath = options.dbPath ?? path.join(API_PACKAGE_ROOT, 'persona-qa.db')
  const sessionService = options.dbPath
    ? new SessionService(dbPath)
    : getSessionService()

  if (options.dbPath) {
    setSessionService(sessionService)
  }
  const toolRegistry = new ToolRegistry()

  // Reference-domain workflow tools are only used by the bundled reference
  // scenarios (and deterministic fake verification); generic runtimes skip them.
  if (process.env.PERSONA_QA_USE_REFERENCE_SCENARIOS === '1' || process.env.AGENTIC_QA_FAKE_WORKFLOW_TOOLS === '1') {
    registerWorkflowTools(toolRegistry)
  }
  registerEvidenceTools(toolRegistry, sessionService)
  registerFindingTools(toolRegistry)
  registerGeneratedAdapterTools(toolRegistry)

  const profiles = listProfiles()
  const primaryPersona = profiles.find((profile) => profile.role !== 'orchestrator')
  const providerSelection = options.provider
    ? null
    : (options.deterministic
      ? null
      : createModelProvider({
          provider: options.providerName,
          model: options.model ?? primaryPersona?.model ?? 'claude-sonnet-4-6',
        }))
  const provider = options.provider
    ?? (options.deterministic
      ? createDeterministicProvider()
      : providerSelection!.provider)
  const providerName = options.deterministic ? undefined : (options.providerName ?? providerSelection?.providerName)
  const agentRuntime = new AgentRuntime(provider, toolRegistry, sessionService, defaultRuntimeHookBus, providerName)
  const sensorRunner = new SensorRunner()

  sensorRunner.registerSensor('schema', schemaSensor)
  sensorRunner.registerSensor('tool_policy', toolPolicySensor)
  sensorRunner.registerSensor('artifact_completeness', artifactSensor)
  sensorRunner.registerSensor('output', outputSensor)
  sensorRunner.registerSensor('timeout', timeoutSensor)

  for (const profile of profiles) {
    agentRuntime.registerAgent(profile)
  }

  const orchestrator = new Orchestrator(agentRuntime, sessionService, sensorRunner)

  return {
    dbPath,
    providerName,
    providerModel: providerSelection?.model,
    sessionService,
    toolRegistry,
    agentRuntime,
    sensorRunner,
    orchestrator,
  }
}
