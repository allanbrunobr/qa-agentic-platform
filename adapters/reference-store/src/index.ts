import { randomUUID } from 'node:crypto'
import type { AdapterExecutionDraft, AdapterExecutionInit, AdapterModelBundle } from '../../../packages/host-sdk/src/adapter-model.ts'
import type { AdapterRuntimeHooks, AdapterStepExecutionContext, AdapterStepExecutionResult } from '../../../packages/host-sdk/src/runtime-hooks.ts'
import { referenceStoreAuthModel } from './model/auth.ts'
import { referenceStoreCapabilitiesModel } from './model/capabilities.ts'
import { referenceStoreAdapterManifestModel } from './model/manifest.ts'
import { referenceStorePersonasModel } from './model/personas.ts'
import { referenceStoreRoutesModel } from './model/routes.ts'
import { referenceStoreScenariosModel } from './model/scenarios.ts'

export const referenceStoreAdapterModel: AdapterModelBundle = {
  manifest: referenceStoreAdapterManifestModel,
  auth: referenceStoreAuthModel,
  routes: referenceStoreRoutesModel,
  capabilities: referenceStoreCapabilitiesModel,
  personas: referenceStorePersonasModel,
  scenarios: referenceStoreScenariosModel,
}

export const referenceStoreAdapterScaffold = {
  id: 'reference-store',
  owns: ['auth', 'capabilities', 'role-mapping', 'scenario-pack', 'host-routes'],
}

function buildStepArtifacts(context: AdapterStepExecutionContext): AdapterStepExecutionResult {
  const definition = context.stepDefinition
  const nextArtifacts: Record<string, unknown> = {}
  for (const artifactId of definition?.producesArtifacts ?? []) {
    if (artifactId === 'customerId') nextArtifacts.customerId = `customer-${context.execution.executionId.slice(0, 8)}`
    if (artifactId === 'orderId') nextArtifacts.orderId = `order-${context.execution.executionId.slice(0, 8)}`
    if (artifactId === 'orderFulfilled') nextArtifacts.orderFulfilled = true
    if (artifactId === 'invoiceValidated') nextArtifacts.invoiceValidated = true
    if (artifactId === 'financeValidated') nextArtifacts.financeValidated = true
    if (artifactId === 'reportsValidated') nextArtifacts.reportsValidated = true
  }

  return {
    summary: `${definition?.roleId ?? 'agent'} executed ${context.stepId}`,
    // The reference adapter simulates exactly the declared capability, so that is what it reports (B-11).
    executedCapabilities: definition?.capabilityId ? [definition.capabilityId] : [],
    producedArtifacts: nextArtifacts,
    artifacts: [
      {
        id: randomUUID(),
        type: 'domain_artifact',
        description: `Capability ${definition?.capabilityId ?? context.stepId} completed`,
        metadata: {
          stepId: context.stepId,
          roleId: definition?.roleId,
          capabilityId: definition?.capabilityId,
        },
        content: JSON.stringify({
          stepId: context.stepId,
          roleId: definition?.roleId,
          capabilityId: definition?.capabilityId,
          producedArtifacts: nextArtifacts,
        }),
      },
    ],
  }
}

export const referenceStoreRuntimeHooks: AdapterRuntimeHooks = {
  shouldCancelExecution: ({ execution }) => execution.runtimeFlags?.cancelExecution === true,
  executeStep: async (context) => {
    if (
      context.execution.runtimeFlags?.simulateRetryStep === context.stepId &&
      context.attempt === 0
    ) {
      return {
        status: 'failed',
        retryable: true,
        maxRetries: 1,
        errorMessage: `Simulated retry for ${context.stepId}`,
        findings: [
          {
            severity: 'medium',
            title: `Retry requested at ${context.stepId}`,
            description: 'Adapter hook forced a single retry for validation.',
          },
        ],
      }
    }

    return buildStepArtifacts(context)
  },
}

export function initializeReferenceStoreExecution(input: AdapterExecutionInit): AdapterExecutionDraft {
  const scenario = referenceStoreScenariosModel.find((item) => item.id === input.scenarioId)
  if (!scenario) {
    throw new Error(`Unknown Reference Store scenario: ${input.scenarioId}`)
  }

  return {
    executionId: randomUUID(),
    adapterId: input.adapterId,
    scenarioId: input.scenarioId,
    hostProjectPath: input.repoPath,
    status: 'initialized',
    personas: scenario.roles,
    steps: scenario.steps,
    runtimeFlags: input.runtimeFlags,
    notes: [
      `Host repo: ${input.repoPath}`,
      'Execution draft derived from certified Reference Store adapter model',
      `Expected artifacts: ${scenario.expectedArtifacts.join(', ')}`,
    ],
  }
}
