/**
 * Anthropic ModelProvider implementation.
 *
 * Translates the generic ModelProvider interface into Anthropic Claude API calls.
 */

import type {
  ModelProvider,
  ModelMessage,
  ModelResponse,
  ModelProviderOptions,
  ToolDefinition,
  ToolCall,
} from '../types/agent-types.js'

export interface AnthropicProviderConfig {
  apiKey: string
  model: string
  defaultMaxTokens?: number
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicResponse {
  content: AnthropicContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string
  usage: { input_tokens: number; output_tokens: number }
}

export class AnthropicProvider implements ModelProvider {
  private readonly config: AnthropicProviderConfig
  // The SDK's create(params, options) accepts { signal } to cancel the HTTP request.
  private client: { messages: { create: (params: unknown, options?: { signal?: AbortSignal }) => Promise<AnthropicResponse> } } | null = null

  constructor(config: AnthropicProviderConfig) {
    this.config = config
  }

  private async getClient() {
    if (!this.client) {
      const anthropicModuleId = '@anthropic-ai/sdk'
      const { default: Anthropic } = await import(anthropicModuleId)
      this.client = new Anthropic({ apiKey: this.config.apiKey }) as unknown as typeof this.client
    }
    return this.client!
  }

  async chat(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    options?: ModelProviderOptions,
  ): Promise<ModelResponse> {
    const client = await this.getClient()

    // Separate system message from conversation
    const systemMessage = messages.find((m) => m.role === 'system')
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map(toAnthropicMessage)

    // Ensure conversation starts with user message (Anthropic requirement)
    if (conversationMessages.length === 0 || conversationMessages[0]!.role !== 'user') {
      conversationMessages.unshift({ role: 'user', content: 'Begin.' })
    }

    const anthropicTools = tools.map(toAnthropicTool)

    const params: Record<string, unknown> = {
      model: options?.model ?? this.config.model,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
      messages: conversationMessages,
    }

    if (systemMessage) {
      params.system = systemMessage.content
    }

    if (anthropicTools.length > 0) {
      params.tools = anthropicTools
    }

    if (options?.temperature !== undefined) {
      params.temperature = options.temperature
    }

    const response = options?.signal
      ? await client.messages.create(params, { signal: options.signal })
      : await client.messages.create(params)
    return fromAnthropicResponse(response)
  }
}

function toAnthropicMessage(msg: ModelMessage): AnthropicMessage {
  return {
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content,
  }
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

export function fromAnthropicResponse(response: AnthropicResponse): ModelResponse {
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []

  for (const block of response.content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text)
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input,
      })
    }
  }

  // Only a real end of turn maps to end_turn. A refusal or a stop reason this runtime does not know
  // (pause_turn, new values) must not read as "the model finished" (B-03).
  const stopReason: ModelResponse['stopReason'] =
    response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence' ? 'end_turn'
    : response.stop_reason === 'tool_use' ? 'tool_use'
    : response.stop_reason === 'max_tokens' ? 'max_tokens'
    : response.stop_reason === 'refusal' ? 'refusal'
    : 'incomplete'

  return {
    text: textParts.length > 0 ? textParts.join('\n') : undefined,
    toolCalls,
    stopReason,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}

/** Create provider from environment */
export function createAnthropicProvider(model: string): AnthropicProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY or ANTHROPIC_API environment variable is required')
  }
  return new AnthropicProvider({ apiKey, model })
}


export async function validateAnthropicApiKey(apiKey: string): Promise<{ ok: boolean; status?: number; message: string }> {
  if (!apiKey) {
    return { ok: false, message: 'ANTHROPIC_API_KEY is missing.' }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    })

    if (response.ok) {
      return { ok: true, status: response.status, message: 'Anthropic API key validated successfully.' }
    }

    const body = await response.text().catch(() => '')
    return {
      ok: false,
      status: response.status,
      message: body ? body.slice(0, 240) : 'Anthropic API key validation failed.',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
