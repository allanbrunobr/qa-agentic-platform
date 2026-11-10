import { randomUUID } from 'node:crypto'
import type { SessionArtifact, SessionEvent, SessionFinding } from '../contracts/session-types.ts'
import type { SessionStore } from './core-runtime-contracts.ts'
import type { AdapterExecutionDraft, AdapterModelBundle } from '../../../host-sdk/src/adapter-model.ts'
import type { AdapterRuntimeHooks } from '../../../host-sdk/src/runtime-hooks.ts'
import { buildStepInstructionEnvelope, getGlobalAgenticInstructions } from './instruction-layer.ts'

export interface AdapterExecutionEngineInput {
  sessionStore: SessionStore
  sessionId: string
  execution: AdapterExecutionDraft
  model: AdapterModelBundle
  hooks: AdapterRuntimeHooks
  stepDelayMs?: number
  onExecutionStarted?: () => Promise<void> | void
  onStepStarted?: (stepId: string, index: number) => Promise<void> | void
  onStepCompleted?: (stepId: string, index: number) => Promise<void> | void
  onStepFailed?: (stepId: string, index: number, errorMessage: string, attempt: number) => Promise<void> | void
  onExecutionFailed?: (stepId: string, index: number, errorMessage: string) => Promise<void> | void
  onExecutionCancelled?: () => Promise<void> | void
  onExecutionCompleted?: (completedAt: string) => Promise<void> | void
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Hard ceiling on retries a hook may request, so a buggy hook cannot loop forever. */
const MAX_RETRIES_CEILING = 10
const DEFAULT_MAX_RETRIES = 1

/**
 * Runs an execution. If any hook throws, the session is closed as failed (with a run_failed event)
 * before the error reaches the caller: it never stays "running" (B-07).
 */
export async function runAdapterExecutionEngine(input: AdapterExecutionEngineInput) {
  try {
    await runEngine(input)
  } catch (error) {
    const failedAt = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    try {
      const current = await input.sessionStore.getSession(input.sessionId)
      if (current && current.status !== 'complete' && current.status !== 'failed') {
        await input.sessionStore.updateSession(input.sessionId, { status: 'failed', completedAt: failedAt })
        await input.sessionStore.appendEvent({
          id: randomUUID(),
          sessionId: input.sessionId,
          type: 'run_failed',
          timestamp: failedAt,
          data: { executionId: input.execution.executionId, errorMessage: message, reason: 'execution_error' },
        } satisfies SessionEvent)
      }
    } catch {
      // The store itself failed: nothing more can be recorded; the original error still propagates.
    }
    throw error
  }
}

async function runEngine(input: AdapterExecutionEngineInput) {
  const { execution, hooks, model, sessionId, sessionStore } = input
  const stepDelayMs = input.stepDelayMs ?? 100
  const scenario = model.scenarios.find((item) => item.id === execution.scenarioId)
  const producedArtifacts: Record<string, unknown> = {}
  const startedAt = new Date().toISOString()
  const globalInstructions = getGlobalAgenticInstructions()

  await sessionStore.updateSession(sessionId, { status: 'running' })
  await sessionStore.appendEvent({
    id: randomUUID(),
    sessionId,
    type: 'info',
    timestamp: startedAt,
    data: {
        message: 'Execution started',
        executionId: execution.executionId,
        adapterId: execution.adapterId,
        globalInstructionsPresent: Boolean(globalInstructions),
      },
    } satisfies SessionEvent)
  await input.onExecutionStarted?.()
  await hooks.onExecutionStarted?.({ execution, sessionId, model })

  for (let index = 0; index < execution.steps.length; index += 1) {
    if (await hooks.shouldCancelExecution?.({ execution, sessionId, model, producedArtifacts })) {
      const cancelledAt = new Date().toISOString()
      await sessionStore.updateSession(sessionId, { status: 'failed', completedAt: cancelledAt })
      await sessionStore.appendEvent({
        id: randomUUID(),
        sessionId,
        type: 'error',
        timestamp: cancelledAt,
        data: {
          message: 'Execution cancelled by adapter hook',
          executionId: execution.executionId,
        },
      } satisfies SessionEvent)
      await hooks.onExecutionCancelled?.({ execution, sessionId, model, producedArtifacts })
      await input.onExecutionCancelled?.()
      return
    }

    const stepId = execution.steps[index]
    const stepDefinition = scenario?.stepDefinitions?.find((item) => item.id === stepId)
    const stepInstructions = buildStepInstructionEnvelope(stepId, stepDefinition, producedArtifacts)
    await sessionStore.appendEvent({
      id: randomUUID(),
      sessionId,
      type: 'step_started',
      timestamp: new Date().toISOString(),
      agentRole: stepDefinition?.roleId,
      data: {
        stepId,
        index,
        capabilityId: stepDefinition?.capabilityId,
        instructions: stepInstructions,
      },
    } satisfies SessionEvent)
    await input.onStepStarted?.(stepId, index)
    await sleep(stepDelayMs)

    let attempt = 0
    let result
    let failureMessage: string | null = null

    // B-08: the loop used to stop at a hard-coded 1 retry while the give-up check below used the step's
    // own maxRetries, so a step still failing fell out of the loop and was recorded as completed. The
    // loop now ends only by success, cancellation, or the give-up check.
    for (;;) {
      await sessionStore.appendEvent({
        id: randomUUID(),
        sessionId,
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        agentRole: stepDefinition?.roleId,
        // B-11: this is the dispatch. It records the DECLARED capability, not a tool used: recording
        // the declaration as the tool made the contract's capability check compare it with itself.
        data: {
          stepId,
          index,
          declaredCapability: stepDefinition?.capabilityId ?? stepId,
          attempt,
        },
      } satisfies SessionEvent)

      result = await hooks.executeStep({
        execution,
        sessionId,
        model,
        stepId,
        stepIndex: index,
        attempt,
        stepDefinition,
        producedArtifacts,
      })

      // What the adapter reports it actually executed is what the contract compares.
      for (const capability of result.executedCapabilities ?? []) {
        await sessionStore.appendEvent({
          id: randomUUID(),
          sessionId,
          type: 'tool_call',
          timestamp: new Date().toISOString(),
          agentRole: stepDefinition?.roleId,
          data: { stepId, index, toolName: capability, attempt, source: 'adapter_report' },
        } satisfies SessionEvent)
      }

      if ((result.status ?? 'completed') === 'completed') break

      failureMessage = result.errorMessage ?? `Step failed: ${stepId}`
      await sessionStore.appendEvent({
        id: randomUUID(),
        sessionId,
        type: 'step_failed',
        timestamp: new Date().toISOString(),
        agentRole: stepDefinition?.roleId,
        data: {
          stepId,
          index,
          attempt,
          errorMessage: failureMessage,
          retryable: result.retryable ?? false,
        },
      } satisfies SessionEvent)
      await input.onStepFailed?.(stepId, index, failureMessage, attempt)
      await hooks.onStepFailed?.({
        execution,
        sessionId,
        model,
        stepId,
        stepIndex: index,
        attempt,
        stepDefinition,
        producedArtifacts,
        errorMessage: failureMessage,
      })

      if ((result.status ?? 'completed') === 'cancelled') {
        const cancelledAt = new Date().toISOString()
        await sessionStore.updateSession(sessionId, { status: 'failed', completedAt: cancelledAt })
        await hooks.onExecutionCancelled?.({ execution, sessionId, model, producedArtifacts })
        await input.onExecutionCancelled?.()
        return
      }

      const allowedRetries = Math.min(result.maxRetries ?? DEFAULT_MAX_RETRIES, MAX_RETRIES_CEILING)
      if (!(result.retryable ?? false) || attempt >= allowedRetries) {
        const failedAt = new Date().toISOString()
        await sessionStore.updateSession(sessionId, { status: 'failed', completedAt: failedAt })
        await sessionStore.appendEvent({
          id: randomUUID(),
          sessionId,
          type: 'run_failed',
          timestamp: failedAt,
          data: {
            executionId: execution.executionId,
            stepId,
            index,
            errorMessage: failureMessage,
          },
        } satisfies SessionEvent)
        await hooks.onExecutionFailed?.({ execution, sessionId, model, stepId, stepIndex: index, errorMessage: failureMessage, producedArtifacts })
        await input.onExecutionFailed?.(stepId, index, failureMessage)
        return
      }

      attempt += 1
    }

    if (!result) {
      const failedAt = new Date().toISOString()
      const errorMessage = `Step produced no result: ${stepId}`
      await sessionStore.updateSession(sessionId, { status: 'failed', completedAt: failedAt })
      await hooks.onExecutionFailed?.({ execution, sessionId, model, stepId, stepIndex: index, errorMessage, producedArtifacts })
      await input.onExecutionFailed?.(stepId, index, errorMessage)
      return
    }

    if (result.producedArtifacts) Object.assign(producedArtifacts, result.producedArtifacts)

    for (const artifact of result.artifacts ?? []) {
      const sessionArtifact: SessionArtifact = {
        id: artifact.id,
        sessionId,
        type: artifact.type ?? 'domain_artifact',
        agentRole: stepDefinition?.roleId ?? 'unknown',
        description: artifact.description,
        content: artifact.content,
        metadata: artifact.metadata,
        timestamp: new Date().toISOString(),
      }
      await sessionStore.appendArtifact(sessionArtifact)
    }

    for (const finding of result.findings ?? []) {
      const sessionFinding: SessionFinding = {
        id: randomUUID(),
        sessionId,
        agentRole: stepDefinition?.roleId,
        stepId,
        severity: finding.severity ?? 'info',
        title: finding.title,
        description: finding.description,
        timestamp: new Date().toISOString(),
      }
      await sessionStore.appendFinding(sessionFinding)
    }

    await sessionStore.appendEvent({
      id: randomUUID(),
      sessionId,
      type: 'step_completed',
      timestamp: new Date().toISOString(),
      agentRole: stepDefinition?.roleId,
      data: {
        stepId,
        index,
        capabilityId: stepDefinition?.capabilityId,
        producedArtifacts: result.producedArtifacts ?? {},
        summary: result.summary,
      },
    } satisfies SessionEvent)
    await input.onStepCompleted?.(stepId, index)
    await sessionStore.updateSession(sessionId, {
      checkpoint: {
        lastCompletedStep: index,
        cursor: index + 1,
      },
    })
  }

  const completedAt = new Date().toISOString()
  await sessionStore.updateSession(sessionId, { status: 'complete', completedAt })
  await sessionStore.appendEvent({
    id: randomUUID(),
    sessionId,
    type: 'run_completed',
    timestamp: completedAt,
    data: {
      executionId: execution.executionId,
      stepsCompleted: execution.steps.length,
      producedArtifacts,
    },
  } satisfies SessionEvent)
  await hooks.onExecutionCompleted?.({ execution, sessionId, model, producedArtifacts })
  await input.onExecutionCompleted?.(completedAt)
}
