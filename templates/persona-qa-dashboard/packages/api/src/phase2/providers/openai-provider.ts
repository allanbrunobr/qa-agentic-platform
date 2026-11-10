import type {
  ModelMessage,
  ModelProvider,
  ModelProviderOptions,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from '../types/agent-types.js'

export interface OpenAIProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  defaultMaxTokens?: number
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIChatCompletionResponse {
  choices: Array<{
    finish_reason: 'stop' | 'tool_calls' | 'length' | string
    message: {
      content?: string | null
      tool_calls?: OpenAIToolCall[]
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

export class OpenAIProvider implements ModelProvider {
  private readonly config: OpenAIProviderConfig

  constructor(config: OpenAIProviderConfig) {
    this.config = config
  }

  async chat(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    options?: ModelProviderOptions,
  ): Promise<ModelResponse> {
    const payload: Record<string, unknown> = {
      model: options?.model ?? this.config.model,
      messages: messages.map(toOpenAIMessage),
      max_completion_tokens: options?.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
    }

    if (tools.length > 0) {
      payload.tools = tools.map(toOpenAITool)
      payload.tool_choice = 'auto'
    }

    if (options?.temperature !== undefined) {
      payload.temperature = options.temperature
    }

    const response = await fetch(`${this.config.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      ...(options?.signal ? { signal: options.signal } : {}),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(body ? body.slice(0, 240) : `OpenAI request failed with status ${response.status}`)
    }

    const result = await response.json() as OpenAIChatCompletionResponse
    return fromOpenAIResponse(result)
  }
}

function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function toOpenAIMessage(message: ModelMessage): OpenAIMessage {
  return {
    role: message.role,
    content: message.content,
  }
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

export function fromOpenAIResponse(response: OpenAIChatCompletionResponse): ModelResponse {
  const choice = response.choices[0]
  const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    input: parseToolArguments(toolCall.function.arguments),
  }))

  const finishReason = choice?.finish_reason
  const stopReason: ModelResponse['stopReason'] =
    finishReason === 'tool_calls' || finishReason === 'function_call' ? 'tool_use'
    : finishReason === 'length' ? 'max_tokens'
    : finishReason === 'content_filter' ? 'refusal'
    : finishReason === 'stop' || finishReason === undefined || finishReason === null ? 'end_turn'
    : 'incomplete'

  return {
    text: choice?.message.content ?? undefined,
    toolCalls,
    stopReason,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  }
}

export function createOpenAIProvider(model: string): OpenAIProvider {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required')
  }

  return new OpenAIProvider({
    apiKey,
    model,
    baseUrl: process.env.OPENAI_BASE_URL,
  })
}

export async function validateOpenAIApiKey(apiKey: string): Promise<{ ok: boolean; status?: number; message: string }> {
  if (!apiKey) {
    return { ok: false, message: 'OPENAI_API_KEY is missing.' }
  }

  try {
    const response = await fetch(`${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (response.ok) {
      return { ok: true, status: response.status, message: 'OpenAI API key validated successfully.' }
    }

    const body = await response.text().catch(() => '')
    return {
      ok: false,
      status: response.status,
      message: body ? body.slice(0, 240) : 'OpenAI API key validation failed.',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

