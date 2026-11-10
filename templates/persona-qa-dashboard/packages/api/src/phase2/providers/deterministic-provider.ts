import type {
  ModelMessage,
  ModelProvider,
  ModelProviderOptions,
  ModelResponse,
  ToolDefinition,
} from '../types/agent-types.js'
import { parseStepEnvelope } from '../services/step-envelope.js'

const STEP_TOOL_MAP: Record<string, string> = {
  open_primary_route: 'openPrimaryRoute',
  fill_customer_email: 'fillCustomerEmail',
  add_cart_item: 'addCartItem',
  submit_order: 'submitOrder',
  capture_screenshot: 'captureScreenshot',
  interact_with_primary_action: 'interactWithPrimaryAction',
  verify_primary_feedback: 'verifyPrimaryFeedback',
  start_api_service: 'startApiService',
  call_health_endpoint: 'callHealthEndpoint',
  call_primary_endpoint: 'callPrimaryEndpoint',
  verify_api_response: 'verifyApiResponse',
  run_cli_help: 'runCliHelp',
  verify_cli_output: 'verifyCliOutput',
  inspect_package_exports: 'inspectPackageExports',
  verify_public_api_docs: 'verifyPublicApiDocs',
  inspect_repository_structure: 'inspectRepositoryStructure',
  identify_test_entrypoints: 'identifyTestEntrypoints',
}

interface StepEnvelope {
  scenarioStep?: string
  producedArtifacts?: unknown
  requiredArtifacts?: unknown
}

export function createDeterministicProvider(): ModelProvider {
  return {
    async chat(messages: ModelMessage[], tools: ToolDefinition[], _options?: ModelProviderOptions): Promise<ModelResponse> {
      if (hasToolResult(messages)) {
        return {
          text: 'Deterministic adapter step completed from tool output.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      }

      const selectedTool = selectTool(messages, tools)
      if (!selectedTool) {
        return {
          text: 'No deterministic tool was available for this generated adapter step.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      }

      return {
        text: `Calling deterministic tool ${selectedTool.name}.`,
        toolCalls: [{
          id: `deterministic-${selectedTool.name}-${Date.now()}`,
          name: selectedTool.name,
          input: buildToolInput(selectedTool.name),
        }],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    },
  }
}

function hasToolResult(messages: ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'user' && message.content.includes('[Tool result for '))
}

function selectTool(messages: ModelMessage[], tools: ToolDefinition[]): ToolDefinition | undefined {
  const step = extractStepEnvelope(messages)
  const stepId = typeof step?.scenarioStep === 'string' ? step.scenarioStep : undefined
  if (stepId) {
    const exactTool = tools.find((item) => item.name === stepId)
    if (exactTool) return exactTool
  }
  const mappedTool = stepId ? STEP_TOOL_MAP[stepId] : undefined
  if (mappedTool) {
    const tool = tools.find((item) => item.name === mappedTool)
    if (tool) return tool
  }

  const artifactTool = selectToolByProducedArtifact(step, tools)
  if (artifactTool) return artifactTool

  const content = messages.map((message) => message.content).join('\n').toLowerCase()
  return tools.find((tool) => content.includes(tool.name.toLowerCase())) ?? tools[0]
}

function selectToolByProducedArtifact(step: StepEnvelope | undefined, tools: ToolDefinition[]): ToolDefinition | undefined {
  const artifacts = Array.isArray(step?.producedArtifacts)
    ? step.producedArtifacts
    : Array.isArray(step?.requiredArtifacts)
      ? step.requiredArtifacts
      : []
  const artifactNames = new Set(artifacts.filter((artifact): artifact is string => typeof artifact === 'string'))
  const candidates: Record<string, string> = {
    serviceStarted: 'startApiService',
    routeLoaded: 'openPrimaryRoute',
    pageLoaded: 'openPrimaryRoute',
    customerEmail: 'fillCustomerEmail',
    cartItemId: 'addCartItem',
    orderSubmitted: 'submitOrder',
    primaryActionCompleted: 'interactWithPrimaryAction',
    primaryFeedbackVisible: 'verifyPrimaryFeedback',
    screenshotCaptured: 'captureScreenshot',
    browserEvidence: 'captureScreenshot',
    interactionResult: 'interactWithPrimaryAction',
    verificationResult: 'verifyPrimaryFeedback',
    apiResponse: 'callHealthEndpoint',
    apiContractVerified: 'verifyApiResponse',
    cliHelpOutput: 'runCliHelp',
    cliOutputVerified: 'verifyCliOutput',
    packageExports: 'inspectPackageExports',
    publicApiDocsVerified: 'verifyPublicApiDocs',
    repositoryStructure: 'inspectRepositoryStructure',
    testEntrypoints: 'identifyTestEntrypoints',
  }

  for (const [artifact, toolName] of Object.entries(candidates)) {
    if (!artifactNames.has(artifact)) continue
    const tool = tools.find((item) => item.name === toolName)
    if (tool) return tool
  }

  return undefined
}

function extractStepEnvelope(messages: ModelMessage[]): StepEnvelope | undefined {
  for (const message of messages) {
    if (message.role !== 'user') continue

    const parsed = parseStepEnvelope(message.content)
    if (parsed) return parsed as StepEnvelope
  }

  return undefined
}

function buildToolInput(toolName: string): Record<string, unknown> {
  if (toolName === 'callHealthEndpoint') return { path: '/health' }
  if (toolName === 'callPrimaryEndpoint') return {}
  if (toolName === 'runCliHelp') return { args: ['--help'] }
  return {}
}
