import process from 'node:process'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { dump } from 'js-yaml'
import { listScenarios, loadScenario } from '../scenarios/index.js'
import { buildScenarioQualityGateForSessions } from '../services/scenario-quality-gates.js'
import { createPhase2Runtime } from '../services/runtime-bootstrap.js'
import {
  parseExecutionContext,
  resolveExecutionBaseUrl,
  summarizeExecutionContext,
} from '../services/execution-context.js'
import {
  isGeneratedNonFrontendRuntime,
  resolveGeneratedTargetRepoPath,
} from '../services/generated-adapter-runtime.js'
import { getSessionService } from './sessions.js'
import { loadRuntimeSettings } from '../../services/runtime-settings.js'
import { validateProviderCredentials } from '../providers/provider-factory.js'

const StartAgenticRunBody = z.object({
  scenario_id: z.string(),
  seed_artifacts: z.record(z.string()).optional(),
  execution_context: z.unknown().optional(),
})

export async function phase2RunnerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/p2/scenarios', async (_request, reply) => {
    const sessions = getSessionService().getAllSessions()
    const scenarios = listScenarios().map((scenarioId) => {
      const scenario = loadScenario(scenarioId)
      const gate = buildScenarioQualityGateForSessions(scenario.id, sessions)
      return {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description ?? null,
        roles: scenario.roles,
        step_count: scenario.steps.length,
        quality_gate: gate,
      }
    })

    return reply.send(scenarios)
  })

  app.get('/api/p2/scenarios/:scenarioId/workflow-contract', async (request, reply) => {
    const params = z.object({ scenarioId: z.string() }).safeParse(request.params)
    if (!params.success) {
      return reply.status(400).send({
        error: 'invalid_params',
        details: params.error.flatten(),
      })
    }

    const scenario = loadScenario(params.data.scenarioId)
    if (!scenario.workflowContract) {
      return reply.status(404).send({
        error: 'workflow_contract_not_found',
        scenario_id: scenario.id,
      })
    }

    const yaml = dump(scenario.workflowContract, {
      noRefs: true,
      lineWidth: 120,
      quotingType: "'",
    })

    return reply.send({
      scenario_id: scenario.id,
      scenario_name: scenario.name,
      workflow_contract: scenario.workflowContract,
      workflow_contract_yaml: yaml,
    })
  })

  app.post('/api/p2/runs', async (request, reply) => {
    const parsed = StartAgenticRunBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_body',
        details: parsed.error.flatten(),
      })
    }

    const useGeneratedNonFrontendRuntime = isGeneratedNonFrontendRuntime()
    const useDeterministicProvider = useGeneratedNonFrontendRuntime || process.env.AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME === '1'
    const runtimeSettings = useDeterministicProvider ? null : loadRuntimeSettings()

    if (runtimeSettings) {
      const providerValidation = await validateProviderCredentials(runtimeSettings.provider)
      if (!providerValidation.ok) {
        return reply.status(503).send({
          error: 'invalid_runtime_provider_configuration',
          provider: runtimeSettings.provider,
          message: `The configured ${runtimeSettings.provider} provider is not ready for the local .agentic-qa runtime.`,
          details: providerValidation,
        })
      }
    }

    const scenario = loadScenario(parsed.data.scenario_id)
    const gate = buildScenarioQualityGateForSessions(scenario.id, getSessionService().getAllSessions())
    if (gate.status === 'restricted') {
      return reply.status(409).send({
        error: 'scenario_restricted_by_quality_gate',
        message: gate.reason,
        scenario_id: scenario.id,
        quality_gate: gate,
      })
    }

    const executionContext = parseExecutionContext(parsed.data.execution_context)
    const baseUrl = resolveExecutionBaseUrl(executionContext) ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3012'
    const seedArtifacts = parsed.data.seed_artifacts ?? {}

    const runtime = useDeterministicProvider
      ? createPhase2Runtime({ deterministic: true })
      : createPhase2Runtime({ providerName: runtimeSettings!.provider })
    const session = runtime.sessionService.createSession(scenario.id)
    if (executionContext) {
      runtime.sessionService.addEvent(session.id, 'info', {
        message: 'execution_context_initialized',
        executionContext: summarizeExecutionContext(executionContext),
        baseUrl,
      })
    }

    void (async () => {
      let browser: { close(): Promise<void>; newPage(options: { baseURL: string }): Promise<{ close(): Promise<void> }> } | null = null
      let page: { close(): Promise<void> } | null = null

      try {
        // executionTarget is what the tools resolve routes and repository paths against. It is set
        // after the seed artifacts so a client-supplied artifact cannot replace it, and the agent
        // runtime keeps it out of the model prompt.
        if (useGeneratedNonFrontendRuntime) {
          const targetRepoPath = executionContext?.targetRepoPath ?? resolveGeneratedTargetRepoPath()
          await runtime.orchestrator.executeRunInSession(session.id, scenario, {
            ...seedArtifacts,
            targetRepoPath,
            runtimeMode: 'generated_non_browser',
            executionTarget: { targetRepoPath },
          })
          return
        }

        const { chromium } = await import('@playwright/test')
        browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
        page = await browser.newPage({ baseURL: baseUrl })

        await runtime.orchestrator.executeRunInSession(session.id, scenario, {
          ...seedArtifacts,
          page,
          executionTarget: { baseUrl },
        })
      } catch (error) {
        runtime.sessionService.updateStatus(session.id, 'failed')
        runtime.sessionService.addEvent(session.id, 'run_failed', {
          scenarioId: scenario.id,
          error: error instanceof Error ? error.message : String(error),
          executionContext: summarizeExecutionContext(executionContext),
        })
      } finally {
        await page?.close().catch(() => {})
        await browser?.close().catch(() => {})
      }
    })()

    return reply.status(202).send({
      session_id: session.id,
      scenario_id: scenario.id,
      status: 'pending',
      started_at: session.startedAt,
      execution_context: summarizeExecutionContext(executionContext),
    })
  })
}
