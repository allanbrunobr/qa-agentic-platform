import type {
  ToolHandler,
  ToolMetadata,
  ToolPolicy,
  ToolResult,
  ToolContext,
  ToolRiskLevel,
} from '../types/tool-types.js'
import { SENSITIVE_PATTERNS, ToolMetadataSchema } from '../types/tool-types.js'

interface RegisteredTool {
  handler: ToolHandler
  metadata: ToolMetadata
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(name: string, handler: ToolHandler, metadata: ToolMetadata): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`)
    }
    const storedMetadata = freezeMetadata(ToolMetadataSchema.parse(metadata))
    this.tools.set(name, { handler, metadata: storedMetadata })
  }

  async execute(
    name: string,
    input: unknown,
    agentPolicy?: ToolPolicy,
    context: ToolContext = {},
  ): Promise<ToolResult> {
    // Check if tool exists
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, error: { code: 'tool_not_found', message: `Tool "${name}" is not registered`, retryable: false } }
    }

    // Check policy
    if (agentPolicy) {
      if (!this.isPolicyAllowed(name, tool.metadata, agentPolicy)) {
        return { ok: false, error: { code: 'tool_not_allowed', message: `Agent policy does not allow tool "${name}"`, retryable: false } }
      }
    }

    // Execute
    try {
      const result = await tool.handler(input, context)
      return result.ok
        ? { ok: true, output: sanitizeOutput(result.output) }
        : { ok: false, error: sanitizeOutput(result.error) as typeof result.error }
    } catch (err) {
      const message = sanitizeString(err instanceof Error ? err.message : String(err))
      // A handler may throw a coded, deliberate refusal (for example route_outside_target): keep its
      // code and do not mark it retryable, since retrying cannot change the answer.
      const coded = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : null
      return { ok: false, error: { code: coded ?? 'tool_execution_error', message, retryable: coded === null } }
    }
  }

  listTools(): ToolMetadata[] {
    return Array.from(this.tools.values()).map((t) => t.metadata)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getMetadata(name: string): ToolMetadata | undefined {
    return this.tools.get(name)?.metadata
  }

  getRiskLevel(name: string): ToolRiskLevel | undefined {
    const metadata = this.tools.get(name)?.metadata
    if (!metadata) return undefined
    return metadata.riskLevel ?? 'read'
  }

  getByRiskLevel(riskLevel: ToolRiskLevel): ToolMetadata[] {
    return this.listTools().filter((metadata) => (metadata.riskLevel ?? 'read') === riskLevel)
  }

  private isPolicyAllowed(name: string, metadata: ToolMetadata, policy: ToolPolicy): boolean {
    // Browser access check
    if (metadata.requiresBrowser && !policy.browserAccess) {
      return false
    }

    // Denied list takes precedence
    if (policy.deniedTools?.includes(name)) {
      return false
    }

    // If allowedTools is defined, tool must be in it
    if (policy.allowedTools && !policy.allowedTools.includes(name)) {
      return false
    }

    return true
  }
}

function freezeMetadata(metadata: ToolMetadata): ToolMetadata {
  return Object.freeze({
    ...metadata,
    tags: Object.freeze([...(metadata.tags ?? [])]) as unknown as string[],
  }) as ToolMetadata
}

function sanitizeOutput(output: unknown): unknown {
  if (output == null) return output
  if (typeof output === 'string') return sanitizeString(output)
  if (Array.isArray(output)) return output.map(sanitizeOutput)
  if (typeof output === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED]'
      } else {
        result[key] = sanitizeOutput(value)
      }
    }
    return result
  }
  return output
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key))
}

// Secret shapes recognized by value, not only by key name (S-06): text from a CLI, an API body or a
// page can carry a key under any label.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+\S+/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

/** Literal values of secret-looking environment variables, read at call time. */
function secretEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
}

function sanitizeString(value: string): string {
  let result = value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
  for (const pattern of SECRET_VALUE_PATTERNS.slice(1)) result = result.replace(pattern, '[REDACTED]')
  for (const secret of secretEnvValues()) {
    if (result.includes(secret)) result = result.split(secret).join('[REDACTED]')
  }
  return result
}

/** Redacts secrets by key name and by value. Applied to tool output and to recorded tool input. */
export function redactSecrets(value: unknown): unknown {
  return sanitizeOutput(value)
}
