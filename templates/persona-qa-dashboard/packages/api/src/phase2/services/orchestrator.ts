import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentStepOutput } from '../types/agent-types.js';
import type { ScenarioContract, RunResult, OrchestratorDecision, StepExecutionStatus } from '../types/scenario-types.js';
import type { AgentRuntime } from './agent-runtime.js';
import { AdaptiveDecisionEngine } from './adaptive-decision-engine.js';
import { resolvePhase2ArtifactPath, type SessionService } from './session-service.js';
import type { SensorRunner } from './sensor-runner.js';
import { hasRenderablePageContent, getEvidencePageUrl, type EvidencePage } from '../tools/browser-page-evidence.js';
import { IndependentAuditorService } from './independent-auditor-service.js';

export class Orchestrator {
  private readonly adaptiveDecisionEngine: AdaptiveDecisionEngine;

  constructor(
    private agentRuntime: AgentRuntime,
    private sessionService: SessionService,
    private sensorRunner?: SensorRunner,
  ) {
    this.adaptiveDecisionEngine = new AdaptiveDecisionEngine(sessionService);
  }

  async executeRun(
    scenario: ScenarioContract,
    runtimeContext: Record<string, unknown> = {},
  ): Promise<RunResult> {
    const session = this.sessionService.createSession(scenario.id);
    return this.executeRunInSession(session.id, scenario, runtimeContext);
  }

  async executeRunInSession(
    sessionId: string,
    scenario: ScenarioContract,
    runtimeContext: Record<string, unknown> = {},
  ): Promise<RunResult> {
    this.assertWorkflowContractConsistency(scenario);
    const executableSteps = this.resolveExecutableSteps(scenario);
    const startTime = Date.now();
    const decisions: OrchestratorDecision[] = [];

    this.sessionService.updateStatus(sessionId, 'running');
    this.sessionService.addEvent(sessionId, 'session_started', {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      totalSteps: executableSteps.length,
    });

    let stepsCompleted = 0;

    for (const step of executableSteps) {
      const retryPolicy = step.retryPolicy ?? { maxAttempts: 1, backoffMs: 1000 };
      let stepSucceeded = false;
      let previousError: string | undefined;

      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
        const decision = this.makeDecision(scenario.id, sessionId, step, attempt, retryPolicy.maxAttempts, previousError);
        const adaptedStep = this.applyStepAdaptations(step, decision);
        decisions.push(decision);
        const attemptStartedAt = new Date().toISOString();
        const attemptStartedMs = Date.now();

        this.sessionService.addEvent(sessionId, 'orchestrator_decision', {
          stepId: step.id,
          decision: decision.decision,
          reason: decision.reason,
          attempt,
          adaptations: decision.adaptations ?? [],
          historicalContext: decision.historicalContext,
          recovery: decision.recovery,
        });

        this.sessionService.addEvent(sessionId, 'step_started', {
          stepId: step.id,
          agentId: step.agentId,
          attempt,
        });

        try {
          const artifacts = this.sessionService.getSession(sessionId)?.artifacts ?? {};
          const result = await this.executeAgentStepWithLifecycle(sessionId, adaptedStep, {
            ...artifacts,
            ...runtimeContext,
            sessionId,
          }, attempt);

          let hasCriticalSensorFailure = false;
          if (this.sensorRunner) {
            const sensorResults = await this.sensorRunner.runAll({
              sessionId,
              step: adaptedStep,
              agentId: adaptedStep.agentId,
              stepOutput: result,
              session: this.sessionService.getSession(sessionId)!,
              scenario,
            });

            for (const sr of sensorResults) {
              this.sessionService.addEvent(sessionId, 'sensor_result', {
                sensor: sr.sensor,
                status: sr.status,
                details: sr.details,
              });
            }

            hasCriticalSensorFailure = sensorResults.some((sr) => sr.status === 'fail');
          }

          if (result.success && !hasCriticalSensorFailure) {
            const completedAt = new Date().toISOString();
            this.sessionService.addEvent(sessionId, 'step_completed', {
              stepId: step.id,
              agentId: step.agentId,
              durationMs: result.durationMs,
            });
            this.sessionService.recordStepPerformance({
              sessionId,
              scenarioId: scenario.id,
              stepId: step.id,
              agentId: step.agentId,
              status: 'completed',
              success: true,
              attempt,
              durationMs: result.durationMs,
              startedAt: attemptStartedAt,
              completedAt,
            });

            for (const [artifact, value] of Object.entries(result.output)) {
              if (value !== undefined) {
                this.sessionService.setArtifact(sessionId, artifact, value);
              }
            }

            await this.captureStepScreenshot(sessionId, step.id, step.agentId, runtimeContext);

            const handoffError = this.handleStepHandoff(sessionId, executableSteps, step.order);
            if (handoffError) {
              this.sessionService.addEvent(sessionId, 'step_failed', {
                stepId: step.id,
                agentId: step.agentId,
                error: handoffError,
                attempt,
              });
              this.sessionService.updateStatus(sessionId, 'failed');
              this.sessionService.addEvent(sessionId, 'session_failed', {
                scenarioId: scenario.id,
                failedStep: step.id,
                stepsCompleted,
                reason: handoffError,
              });
              this.recordIndependentSessionAudit(sessionId, 'handoff_failure');
              this.sessionService.addEvent(sessionId, 'run_failed', {
                scenarioId: scenario.id,
                failedStep: step.id,
                stepsCompleted,
              });

              return {
                sessionId,
                scenarioId: scenario.id,
                status: 'failed',
                stepsCompleted,
                totalSteps: executableSteps.length,
                decisions,
                durationMs: Date.now() - startTime,
                error: handoffError,
              };
            }

            this.sessionService.saveCheckpoint(sessionId, step.order);
            stepSucceeded = true;
            stepsCompleted++;
            break;
          }

          // Step failed
          const failedStatus: StepExecutionStatus = attempt < retryPolicy.maxAttempts ? 'recoverable_failed' : 'failed';
          const errorMessage = result.error ?? 'Critical sensor validation failed';
          previousError = errorMessage;
          this.sessionService.addEvent(sessionId, 'step_failed', {
            stepId: step.id,
            agentId: step.agentId,
            error: errorMessage,
            attempt,
          });
          this.sessionService.recordStepPerformance({
            sessionId,
            scenarioId: scenario.id,
            stepId: step.id,
            agentId: step.agentId,
            status: failedStatus,
            success: false,
            attempt,
            durationMs: result.durationMs || Date.now() - attemptStartedMs,
            errorMessage,
            startedAt: attemptStartedAt,
            completedAt: new Date().toISOString(),
          });

          if (attempt < retryPolicy.maxAttempts) {
            const retryDecision: OrchestratorDecision = {
              stepId: step.id,
              decision: 'retry',
              reason: `Step failed (attempt ${attempt}/${retryPolicy.maxAttempts}), retrying`,
              attempt: attempt + 1,
              timestamp: new Date().toISOString(),
              adaptations: [],
            };
            decisions.push(retryDecision);
            this.sessionService.addEvent(sessionId, 'orchestrator_decision', {
              stepId: step.id,
              decision: 'retry',
              reason: retryDecision.reason,
              attempt: attempt + 1,
            });

            await this.delay(retryPolicy.backoffMs * attempt);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          previousError = errorMessage;
          const failedStatus: StepExecutionStatus = attempt < retryPolicy.maxAttempts ? 'recoverable_failed' : 'failed';
          this.sessionService.addEvent(sessionId, 'step_failed', {
            stepId: step.id,
            agentId: step.agentId,
            error: errorMessage,
            attempt,
          });
          this.sessionService.recordStepPerformance({
            sessionId,
            scenarioId: scenario.id,
            stepId: step.id,
            agentId: step.agentId,
            status: failedStatus,
            success: false,
            attempt,
            durationMs: Date.now() - attemptStartedMs,
            errorMessage,
            startedAt: attemptStartedAt,
            completedAt: new Date().toISOString(),
          });

          if (attempt >= retryPolicy.maxAttempts) break;
          await this.delay(retryPolicy.backoffMs * attempt);
        }
      }

      if (!stepSucceeded) {
        const failDecision: OrchestratorDecision = {
          stepId: step.id,
          decision: 'fail',
          reason: `Step ${step.id} failed after all attempts`,
          attempt: retryPolicy.maxAttempts,
          timestamp: new Date().toISOString(),
          adaptations: [],
        };
        decisions.push(failDecision);
        this.sessionService.addEvent(sessionId, 'orchestrator_decision', {
          stepId: step.id,
          decision: 'fail',
          reason: failDecision.reason,
        });

        this.sessionService.updateStatus(sessionId, 'failed');
        this.sessionService.addEvent(sessionId, 'session_failed', {
          scenarioId: scenario.id,
          failedStep: step.id,
          stepsCompleted,
          reason: failDecision.reason,
        });
        this.recordIndependentSessionAudit(sessionId, 'step_failure');
        this.sessionService.addEvent(sessionId, 'run_failed', {
          scenarioId: scenario.id,
          failedStep: step.id,
          stepsCompleted,
        });

        return {
          sessionId,
          scenarioId: scenario.id,
          status: 'failed',
          stepsCompleted,
          totalSteps: executableSteps.length,
          decisions,
          durationMs: Date.now() - startTime,
          error: `Step ${step.id} failed after ${retryPolicy.maxAttempts} attempt(s)`,
        };
      }
    }

    this.sessionService.updateStatus(sessionId, 'complete');
    this.sessionService.addEvent(sessionId, 'session_completed', {
      scenarioId: scenario.id,
      stepsCompleted,
      totalSteps: executableSteps.length,
    });
    this.recordIndependentSessionAudit(sessionId, 'run_completed');
    this.sessionService.addEvent(sessionId, 'run_completed', {
      scenarioId: scenario.id,
      stepsCompleted,
    });

    return {
      sessionId,
      scenarioId: scenario.id,
      status: 'complete',
      stepsCompleted,
      totalSteps: executableSteps.length,
      decisions,
      durationMs: Date.now() - startTime,
    };
  }

  async resumeRun(
    sessionId: string,
    scenario: ScenarioContract,
    runtimeContext: Record<string, unknown> = {},
  ): Promise<RunResult> {
    this.assertWorkflowContractConsistency(scenario);
    const executableSteps = this.resolveExecutableSteps(scenario);
    const session = this.sessionService.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const startStepIndex = session.checkpoint.lastCompletedStep + 1;
    const remainingSteps = executableSteps.filter(s => s.order >= startStepIndex);

    const resumeScenario: ScenarioContract = {
      ...scenario,
      steps: remainingSteps,
    };

    this.sessionService.updateStatus(sessionId, 'running');
    this.sessionService.addEvent(sessionId, 'session_started', {
      scenarioId: scenario.id,
      resumed: true,
      fromStep: startStepIndex,
    });

    // Re-execute from the incomplete step
    const startTime = Date.now();
    const decisions: OrchestratorDecision[] = [];
    let stepsCompleted = startStepIndex;

    for (const step of resumeScenario.steps) {
      const retryPolicy = step.retryPolicy ?? { maxAttempts: 1, backoffMs: 1000 };
      let stepSucceeded = false;
      let previousError: string | undefined;

      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
        const decision = this.makeDecision(scenario.id, sessionId, step, attempt, retryPolicy.maxAttempts, previousError);
        const adaptedStep = this.applyStepAdaptations(step, decision);
        decisions.push(decision);
        this.sessionService.addEvent(sessionId, 'orchestrator_decision', {
          stepId: step.id,
          decision: decision.decision,
          reason: decision.reason,
          attempt,
          adaptations: decision.adaptations ?? [],
          historicalContext: decision.historicalContext,
          recovery: decision.recovery,
        });

        this.sessionService.addEvent(sessionId, 'step_started', {
          stepId: step.id,
          agentId: step.agentId,
          attempt,
        });

        try {
          const artifacts = this.sessionService.getSession(sessionId)?.artifacts ?? {};
          const result = await this.executeAgentStepWithLifecycle(sessionId, adaptedStep, {
            ...artifacts,
            ...runtimeContext,
            sessionId,
          }, attempt);

          let hasCriticalSensorFailure = false;
          if (this.sensorRunner) {
            const sensorResults = await this.sensorRunner.runAll({
              sessionId,
              step: adaptedStep,
              agentId: adaptedStep.agentId,
              stepOutput: result,
              session: this.sessionService.getSession(sessionId)!,
              scenario,
            });

            for (const sr of sensorResults) {
              this.sessionService.addEvent(sessionId, 'sensor_result', {
                sensor: sr.sensor,
                status: sr.status,
                details: sr.details,
              });
            }

            hasCriticalSensorFailure = sensorResults.some((sr) => sr.status === 'fail');
          }

          if (result.success && !hasCriticalSensorFailure) {
            this.sessionService.addEvent(sessionId, 'step_completed', {
              stepId: step.id,
              agentId: step.agentId,
              durationMs: result.durationMs,
            });
            for (const [artifact, value] of Object.entries(result.output)) {
              if (value !== undefined) {
                this.sessionService.setArtifact(sessionId, artifact, value);
              }
            }
            await this.captureStepScreenshot(sessionId, step.id, step.agentId, runtimeContext);
            const handoffError = this.handleStepHandoff(sessionId, executableSteps, step.order);
            if (handoffError) {
              this.sessionService.addEvent(sessionId, 'step_failed', {
                stepId: step.id,
                agentId: step.agentId,
                error: handoffError,
                attempt,
              });
              this.sessionService.updateStatus(sessionId, 'failed');
              this.sessionService.addEvent(sessionId, 'session_failed', {
                scenarioId: scenario.id,
                failedStep: step.id,
                stepsCompleted,
                reason: handoffError,
              });
              this.recordIndependentSessionAudit(sessionId, 'handoff_failure');
              this.sessionService.addEvent(sessionId, 'run_failed', {
                failedStep: step.id,
                stepsCompleted,
              });
              return {
                sessionId,
                scenarioId: scenario.id,
                status: 'failed',
                stepsCompleted,
                totalSteps: scenario.steps.length,
                decisions,
                durationMs: Date.now() - startTime,
                error: handoffError,
              };
            }
            this.sessionService.saveCheckpoint(sessionId, step.order);
            stepSucceeded = true;
            stepsCompleted++;
            break;
          }

          const errorMessage = result.error ?? 'Critical sensor validation failed';
          previousError = errorMessage;
          this.sessionService.addEvent(sessionId, 'step_failed', {
            stepId: step.id,
            error: errorMessage,
            attempt,
          });

          if (attempt < retryPolicy.maxAttempts) {
            await this.delay(retryPolicy.backoffMs * attempt);
          }
        } catch (error) {
          previousError = error instanceof Error ? error.message : String(error);
          this.sessionService.addEvent(sessionId, 'step_failed', {
            stepId: step.id,
            error: previousError,
            attempt,
          });
          if (attempt >= retryPolicy.maxAttempts) break;
          await this.delay(retryPolicy.backoffMs * attempt);
        }
      }

      if (!stepSucceeded) {
        this.sessionService.updateStatus(sessionId, 'failed');
        this.sessionService.addEvent(sessionId, 'session_failed', {
          scenarioId: scenario.id,
          failedStep: step.id,
          stepsCompleted,
          reason: `Step ${step.id} failed after ${retryPolicy.maxAttempts} attempt(s)`,
        });
        this.recordIndependentSessionAudit(sessionId, 'step_failure');
        this.sessionService.addEvent(sessionId, 'run_failed', {
          failedStep: step.id,
          stepsCompleted,
        });

        return {
          sessionId,
          scenarioId: scenario.id,
          status: 'failed',
          stepsCompleted,
          totalSteps: executableSteps.length,
          decisions,
          durationMs: Date.now() - startTime,
          error: `Step ${step.id} failed after ${retryPolicy.maxAttempts} attempt(s)`,
        };
      }
    }

    this.sessionService.updateStatus(sessionId, 'complete');
    this.sessionService.addEvent(sessionId, 'session_completed', {
      scenarioId: scenario.id,
      stepsCompleted,
      totalSteps: executableSteps.length,
      resumed: true,
    });
    this.recordIndependentSessionAudit(sessionId, 'run_completed');
    this.sessionService.addEvent(sessionId, 'run_completed', {
      scenarioId: scenario.id,
      stepsCompleted,
    });

    return {
      sessionId,
      scenarioId: scenario.id,
      status: 'complete',
      stepsCompleted,
      totalSteps: executableSteps.length,
      decisions,
      durationMs: Date.now() - startTime,
    };
  }

  private makeDecision(
    scenarioId: string,
    sessionId: string,
    step: ScenarioContract['steps'][number],
    attempt: number,
    maxAttempts: number,
    previousError?: string,
  ): OrchestratorDecision {
    return this.adaptiveDecisionEngine.makeDecision({
      scenarioId,
      sessionId,
      step,
      attempt,
      maxAttempts,
      previousError,
    });
  }

  private applyStepAdaptations(
    step: ScenarioContract['steps'][number],
    decision: OrchestratorDecision,
  ): ScenarioContract['steps'][number] {
    let adaptedStep = step;

    for (const adaptation of decision.adaptations ?? []) {
      if (adaptation.applied && adaptation.type === 'timeout' && typeof adaptation.newValue === 'number') {
        adaptedStep = {
          ...adaptedStep,
          timeoutMs: adaptation.newValue,
        };
      }
    }

    return adaptedStep;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async executeAgentStepWithLifecycle(
    sessionId: string,
    step: ScenarioContract['steps'][number],
    context: Record<string, unknown>,
    attempt: number,
  ): Promise<AgentStepOutput> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    this.sessionService.addEvent(sessionId, 'agent_started', {
      agentId: step.agentId,
      agentRole: step.agentId,
      stepId: step.id,
      capabilityId: step.capabilityId,
      attempt,
      timeoutMs: step.timeoutMs,
      startedAt,
    });

    try {
      const result = await this.agentRuntime.executeStep(step.agentId, step, context);
      this.sessionService.addEvent(sessionId, 'agent_stopped', {
        agentId: step.agentId,
        agentRole: step.agentId,
        stepId: step.id,
        capabilityId: step.capabilityId,
        attempt,
        status: result.success ? 'completed' : result.status ?? 'failed',
        durationMs: result.durationMs || Date.now() - startedMs,
        error: result.error,
        startedAt,
        stoppedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.sessionService.addEvent(sessionId, 'agent_stopped', {
        agentId: step.agentId,
        agentRole: step.agentId,
        stepId: step.id,
        capabilityId: step.capabilityId,
        attempt,
        status: 'error',
        durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        stoppedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private recordIndependentSessionAudit(sessionId: string, trigger: string): void {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return;

    const evaluation = new IndependentAuditorService().evaluateSession(session);
    this.sessionService.addEvent(sessionId, 'auditor_evaluation', {
      agentRole: 'auditor',
      auditorRole: 'auditor',
      source: 'terminal_session_audit',
      trigger,
      sessionId,
      verdict: evaluation.verdict,
      checkedAt: evaluation.checkedAt,
      summary: evaluation.summary,
      findings: evaluation.findings,
    });
  }

  private async captureStepScreenshot(
    sessionId: string,
    stepId: string,
    agentId: string,
    runtimeContext: Record<string, unknown>,
  ): Promise<void> {
    const maybePage = runtimeContext.page as EvidencePage | undefined;
    if (!maybePage?.screenshot) return;

    try {
      if (!(await hasRenderablePageContent(maybePage))) {
        this.sessionService.addEvent(sessionId, 'info', {
          event: 'step_screenshot_skipped',
          stepId,
          agentRole: agentId,
          reason: 'blank_page',
          pageUrl: getEvidencePageUrl(maybePage),
        });
        return;
      }

      const buffer = await maybePage.screenshot({ fullPage: false });
      const relativePath = `screenshots/${sessionId}/${Date.now()}-${stepId}.png`;
      const absolutePath = resolvePhase2ArtifactPath(relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, buffer);

      const artifact = this.sessionService.storeArtifact(sessionId, {
        type: 'screenshot',
        agentRole: agentId,
        description: `Automatic screenshot after successful step ${stepId}`,
        filePath: relativePath,
        metadata: {
          source: 'orchestrator_auto',
          stepId,
          sizeBytes: buffer.length,
        },
      });

      this.sessionService.addEvent(sessionId, 'info', {
        event: 'step_screenshot_captured',
        stepId,
        agentRole: agentId,
        artifactId: artifact.id,
        filePath: relativePath,
      });
    } catch {
      // Best-effort evidence capture; do not fail the run for screenshot issues.
    }
  }

  private handleStepHandoff(
    sessionId: string,
    executableSteps: ScenarioContract['steps'],
    stepOrder: number,
  ): string | null {
    const currentStep = executableSteps[stepOrder]
    const nextStep = executableSteps[stepOrder + 1]
    if (!currentStep || !nextStep) return null

    if (currentStep.agentId === nextStep.agentId) {
      return null
    }

    if (!currentStep.handoff) {
      this.sessionService.addEvent(sessionId, 'handoff_rejected', {
        fromAgentId: currentStep.agentId,
        toAgentId: nextStep.agentId,
        stepId: currentStep.id,
        nextStepId: nextStep.id,
        reason: 'Missing handoff contract for multi-agent transition',
      })
      return `Missing handoff contract between ${currentStep.agentId} and ${nextStep.agentId}`
    }

    this.sessionService.addEvent(sessionId, 'handoff_emitted', {
      fromAgentId: currentStep.agentId,
      toAgentId: currentStep.handoff.nextAgentId,
      stepId: currentStep.id,
      nextStepId: nextStep.id,
      reason: currentStep.handoff.reason,
      requiredArtifacts: currentStep.handoff.requiredArtifacts,
      expectedOutput: currentStep.handoff.expectedOutput,
    })

    if (currentStep.handoff.nextAgentId !== nextStep.agentId) {
      this.sessionService.addEvent(sessionId, 'handoff_rejected', {
        fromAgentId: currentStep.agentId,
        toAgentId: currentStep.handoff.nextAgentId,
        stepId: currentStep.id,
        nextStepId: nextStep.id,
        reason: 'Handoff nextAgentId does not match next step agentId',
      })
      return `Handoff nextAgentId "${currentStep.handoff.nextAgentId}" does not match next step agent "${nextStep.agentId}"`
    }

    const session = this.sessionService.getSession(sessionId)
    const missingArtifacts = currentStep.handoff.requiredArtifacts.filter(
      (artifact) => session?.artifacts?.[artifact] === undefined,
    )

    if (missingArtifacts.length > 0) {
      this.sessionService.addEvent(sessionId, 'handoff_rejected', {
        fromAgentId: currentStep.agentId,
        toAgentId: currentStep.handoff.nextAgentId,
        stepId: currentStep.id,
        nextStepId: nextStep.id,
        reason: 'Missing artifacts required by handoff contract',
        missingArtifacts,
      })
      return `Handoff from ${currentStep.agentId} to ${nextStep.agentId} is missing artifacts: ${missingArtifacts.join(', ')}`
    }

    const handoffPayload = Object.fromEntries(
      currentStep.handoff.requiredArtifacts.map((artifact) => [artifact, session?.artifacts?.[artifact]]),
    )

    this.sessionService.addEvent(sessionId, 'handoff_accepted', {
      fromAgentId: currentStep.agentId,
      toAgentId: currentStep.handoff.nextAgentId,
      stepId: currentStep.id,
      nextStepId: nextStep.id,
      handoffPayload,
    })

    return null
  }

  private assertWorkflowContractConsistency(scenario: ScenarioContract): void {
    const contract = scenario.workflowContract;
    if (!contract) return;

    if (!contract.deterministic) {
      throw new Error(`Scenario ${scenario.id} must declare deterministic workflowContract=true`);
    }

    if (contract.steps.length !== scenario.steps.length) {
      throw new Error(`Scenario ${scenario.id} workflowContract step count does not match scenario.steps`);
    }

    for (const step of scenario.steps) {
      const contractStep = contract.steps.find((item) => item.id === step.id);
      if (!contractStep) {
        throw new Error(`Scenario ${scenario.id} workflowContract is missing step ${step.id}`);
      }

      if (contractStep.order !== step.order) {
        throw new Error(`Scenario ${scenario.id} workflowContract order mismatch for step ${step.id}`);
      }

      if (contractStep.agentId !== step.agentId) {
        throw new Error(`Scenario ${scenario.id} workflowContract agent mismatch for step ${step.id}`);
      }

      if (step.capabilityId && contractStep.capabilityId !== step.capabilityId) {
        throw new Error(`Scenario ${scenario.id} workflowContract capability mismatch for step ${step.id}`);
      }

      if (JSON.stringify(contractStep.requiredArtifacts) !== JSON.stringify(step.requiredArtifacts)) {
        throw new Error(`Scenario ${scenario.id} workflowContract requiredArtifacts mismatch for step ${step.id}`);
      }

      if (JSON.stringify(contractStep.producedArtifacts) !== JSON.stringify(step.producedArtifacts)) {
        throw new Error(`Scenario ${scenario.id} workflowContract producedArtifacts mismatch for step ${step.id}`);
      }
    }
  }

  private resolveExecutableSteps(scenario: ScenarioContract): ScenarioContract['steps'] {
    const contract = scenario.workflowContract;
    if (!contract) {
      return [...scenario.steps].sort((left, right) => left.order - right.order);
    }

    return [...contract.steps]
      .sort((left, right) => left.order - right.order)
      .map((contractStep) => {
        const scenarioStep = scenario.steps.find((step) => step.id === contractStep.id);
        if (!scenarioStep) {
          throw new Error(`Scenario ${scenario.id} workflowContract is missing step ${contractStep.id}`);
        }

        return {
          ...scenarioStep,
          order: contractStep.order,
          agentId: contractStep.agentId,
          capabilityId: contractStep.capabilityId,
          requiredArtifacts: contractStep.requiredArtifacts,
          producedArtifacts: contractStep.producedArtifacts,
          timeoutMs: contractStep.timeoutMs ?? scenarioStep.timeoutMs,
          retryPolicy: contractStep.retryPolicy ?? scenarioStep.retryPolicy,
        };
      });
  }
}
