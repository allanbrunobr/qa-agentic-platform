import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../services/agent-runtime.js'
import { createSessionServiceStub } from '../services/session-service.js'
import { ToolRegistry, redactSecrets } from '../services/tool-registry.js'
import { registerGeneratedAdapterTools } from '../tools/generated-adapter-tools.js'
import type { ModelProvider, ModelResponse } from '../types/agent-types.js'

// S-03 and S-06 (docs/analise-20261109.md): the target repository's CLI received the runtime's whole
// environment (provider keys included) and arbitrary model-chosen args, and redaction only knew key
// names and "Bearer", so secrets printed by a CLI or API reached the model and the session events.

const FAKE_ANTHROPIC = 'sk-ant-api03-SECRETVALUE1234567890abcdef'
const FAKE_PASSWORD = 'hunter2-correct-horse'
const SAVED = ['ANTHROPIC_API_KEY', 'TEST_PASSWORD', 'MY_SERVICE_TOKEN', 'AGENTIC_QA_REPOSITORY_KIND'] as const
const saved: Record<string, string | undefined> = {}
let repo = ''

beforeAll(async () => {
  for (const key of SAVED) saved[key] = process.env[key]
  process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC
  process.env.TEST_PASSWORD = FAKE_PASSWORD
  process.env.MY_SERVICE_TOKEN = 'literal-service-token-value-42'
  process.env.AGENTIC_QA_REPOSITORY_KIND = 'cli'
  repo = await mkdtemp(path.join(tmpdir(), 'secrets-cli-'))
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'fake-cli', bin: 'cli.js' }))
  await writeFile(path.join(repo, 'cli.js'), [
    'console.log(JSON.stringify({',
    '  key: typeof process.env.ANTHROPIC_API_KEY,',
    '  password: typeof process.env.TEST_PASSWORD,',
    '  hasPath: Boolean(process.env.PATH),',
    '  args: process.argv.slice(2),',
    '}))',
  ].join('\n'))
})
afterAll(async () => {
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await rm(repo, { recursive: true, force: true })
})

async function runCli(args?: string[]) {
  const registry = new ToolRegistry()
  registerGeneratedAdapterTools(registry)
  return registry.execute('runCliHelp', args ? { args } : {}, { browserAccess: false }, {
    executionTarget: { targetRepoPath: repo },
  })
}

function cliReport(result: Awaited<ReturnType<typeof runCli>>) {
  if (!result.ok) throw new Error(`runCliHelp failed: ${JSON.stringify(result.error)}`)
  const output = (result.output as { cliHelpOutput: { stdoutPreview: string } }).cliHelpOutput
  return JSON.parse(output.stdoutPreview) as { key: string; password: string; hasPath: boolean; args: string[] }
}

describe('runCliHelp runs the target CLI without the runtime secrets', () => {
  it('does not pass provider keys or test credentials to the target process', async () => {
    const report = cliReport(await runCli())
    expect(report.key).toBe('undefined')
    expect(report.password).toBe('undefined')
    expect(report.hasPath).toBe(true)
    expect(report.args).toEqual(['--help'])
  })

  it.each([['--version'], ['build', '--help'], ['-h']])('accepts help and version style args %j', async (...args) => {
    expect(cliReport(await runCli(args)).args).toEqual(args)
  })

  it.each([['-e', 'process.exit(0)'], ['--eval=1'], ['$(id)'], ['--help', '../../etc/passwd'], ['a', 'b', 'c', 'd', 'e']])(
    'refuses arbitrary args %j',
    async (...args) => {
      const result = await runCli(args)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('cli_args_not_allowed')
    },
  )
})

describe('redaction by value', () => {
  it('redacts provider keys, tokens and env secret values inside strings', () => {
    const redacted = JSON.stringify(redactSecrets({
      stdoutPreview: `key=${FAKE_ANTHROPIC} gh=ghp_abcdefghijklmnopqrstuvwxyz0123456789 aws=AKIAIOSFODNN7EXAMPLE`,
      body: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl and openai sk-proj-abcdefghijklmnopqrstuvwx',
      note: `password ${FAKE_PASSWORD} and literal-service-token-value-42`,
    }))
    for (const secret of [FAKE_ANTHROPIC, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl', 'sk-proj-abcdefghijklmnopqrstuvwx',
      FAKE_PASSWORD, 'literal-service-token-value-42']) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted).toContain('[REDACTED]')
  })

  it('keeps ordinary text intact', () => {
    expect(redactSecrets({ text: 'Order submitted successfully for sku-123' })).toEqual({ text: 'Order submitted successfully for sku-123' })
  })

  it('redacts secrets returned by a tool before the model and the events see them', async () => {
    const registry = new ToolRegistry()
    registry.register('echoSecret', async () => ({ ok: true, output: { body: `leaked ${FAKE_ANTHROPIC}` } }), {
      name: 'echoSecret', description: 'echo', requiresBrowser: false, tags: [],
    })
    const result = await registry.execute('echoSecret', {}, { browserAccess: false })
    expect(JSON.stringify(result)).not.toContain(FAKE_ANTHROPIC)
  })

  it('redacts secrets in the tool_call input recorded in session events', async () => {
    const registry = new ToolRegistry()
    registry.register('fillPassword', async () => ({ ok: true, output: { filled: true } }), {
      name: 'fillPassword', description: 'fill', requiresBrowser: false, tags: [],
    })
    const responses: ModelResponse[] = [
      { text: '', toolCalls: [{ id: 't1', name: 'fillPassword', input: { value: FAKE_PASSWORD, apiKey: FAKE_ANTHROPIC } }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'end_turn' },
    ]
    let index = 0
    const provider: ModelProvider = { chat: vi.fn(async () => responses[index++]!) }
    const sessionService = createSessionServiceStub()
    const session = sessionService.createSession('secrets')
    await new AgentRuntime(provider, registry, sessionService).executeStep({
      role: 'probe', model: 'm', timeoutMs: 5000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      toolPolicy: { browserAccess: false },
      evidencePolicy: { requireScreenshotForFinding: false, requireDomSnippetForFinding: false },
      canBlockRun: false,
    }, { sessionId: session.id, messages: [{ role: 'user', content: 'go' }] })

    const events = JSON.stringify(sessionService.getSession(session.id)?.events ?? [])
    expect(events).toContain('fillPassword')
    expect(events).not.toContain(FAKE_PASSWORD)
    expect(events).not.toContain(FAKE_ANTHROPIC)
  })
})
