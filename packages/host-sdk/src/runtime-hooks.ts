import type { AdapterExecutionDraft, AdapterModelBundle, AdapterScenarioStepModel } from './adapter-model.ts'

export interface AdapterExecutionContext {
  execution: AdapterExecutionDraft
  sessionId: string
  model: AdapterModelBundle
}

export interface AdapterStepExecutionContext extends AdapterExecutionContext {
  stepId: string
  stepIndex: number
  attempt: number
  stepDefinition?: AdapterScenarioStepModel
  producedArtifacts: Record<string, unknown>
}

export interface AdapterStepArtifactRecord {
  id: string
  type?: 'screenshot' | 'dom_snippet' | 'domain_artifact'
  description: string
  content?: string
  metadata?: Record<string, unknown>
}

export interface AdapterStepExecutionResult {
  status?: 'completed' | 'failed' | 'cancelled'
  summary?: string
  errorMessage?: string
  retryable?: boolean
  maxRetries?: number
  /**
   * Capabilities (tools) the step actually performed. The contract's capability check compares these
   * with the declared one; when the adapter reports none, nothing is recorded as used (B-11).
   */
  executedCapabilities?: string[]
  artifacts?: AdapterStepArtifactRecord[]
  producedArtifacts?: Record<string, unknown>
  findings?: Array<{
    severity?: 'low' | 'medium' | 'high' | 'critical' | 'info'
    title: string
    description?: string
  }>
}

export interface AdapterRuntimeHooks {
  onExecutionStarted?: (context: AdapterExecutionContext) => Promise<void> | void
  shouldCancelExecution?: (context: AdapterExecutionContext & { producedArtifacts: Record<string, unknown> }) => Promise<boolean> | boolean
  executeStep: (context: AdapterStepExecutionContext) => Promise<AdapterStepExecutionResult> | AdapterStepExecutionResult
  onStepFailed?: (
    context: AdapterStepExecutionContext & { errorMessage: string; attempt: number }
  ) => Promise<void> | void
  onExecutionFailed?: (
    context: AdapterExecutionContext & { stepId: string; stepIndex: number; errorMessage: string; producedArtifacts: Record<string, unknown> }
  ) => Promise<void> | void
  onExecutionCancelled?: (
    context: AdapterExecutionContext & { producedArtifacts: Record<string, unknown> }
  ) => Promise<void> | void
  onExecutionCompleted?: (context: AdapterExecutionContext & { producedArtifacts: Record<string, unknown> }) => Promise<void> | void
}
