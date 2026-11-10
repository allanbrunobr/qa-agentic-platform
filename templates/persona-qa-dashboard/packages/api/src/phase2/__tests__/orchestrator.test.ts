import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../services/orchestrator.js';
import { SessionService } from '../services/session-service.js';
import { AgentRuntime } from '../services/agent-runtime.js';
import type { ScenarioContract } from '../types/scenario-types.js';
import type { AgentStepOutput } from '../types/agent-types.js';
import { SensorRunner } from '../services/sensor-runner.js';

function makeScenario(overrides?: Partial<ScenarioContract>): ScenarioContract {
  return {
    id: 'test_scenario',
    name: 'Test Scenario',
    steps: [
      {
        id: 'step_1',
        name: 'Create Customer',
        agentId: 'sales_associate',
        order: 0,
        requiredArtifacts: [],
        producedArtifacts: ['customerId'],
      },
      {
        id: 'step_2',
        name: 'Schedule Order',
        agentId: 'sales_associate',
        order: 1,
        requiredArtifacts: ['customerId'],
        producedArtifacts: ['orderId'],
      },
    ],
    roles: ['sales_associate'],
    requiredArtifacts: ['customerId', 'orderId'],
    allowedTools: ['registerCustomer', 'createOrder'],
    ...overrides,
  };
}

function makeSuccessOutput(stepIndex: number): AgentStepOutput {
  return {
    stepIndex,
    agentId: 'sales_associate',
    output: { customerId: '123', orderId: '456' },
    toolCalls: [],
    findings: [],
    durationMs: 100,
    success: true,
  };
}

function makeFailOutput(stepIndex: number, error?: string): AgentStepOutput {
  return {
    stepIndex,
    agentId: 'sales_associate',
    output: {},
    toolCalls: [],
    findings: [],
    durationMs: 50,
    success: false,
    error: error ?? 'Step failed',
  };
}

describe('Orchestrator', () => {
  let sessionService: SessionService;
  let agentRuntime: AgentRuntime;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    sessionService = new SessionService();
    agentRuntime = new AgentRuntime();
    orchestrator = new Orchestrator(agentRuntime, sessionService);
  });

  describe('executeRun', () => {
    it('should execute all steps sequentially and return complete', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockImplementation(async (_agentId, step) => {
        return makeSuccessOutput(step.order);
      });

      const result = await orchestrator.executeRun(scenario);

      expect(result.status).toBe('complete');
      expect(result.stepsCompleted).toBe(2);
      expect(result.totalSteps).toBe(2);
      expect(result.scenarioId).toBe('test_scenario');
      expect(result.sessionId).toBeDefined();
    });

    it('should create a session and set status to running', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId);

      expect(session).toBeDefined();
      expect(session!.status).toBe('complete');
    });

    it('should emit orchestrator_decision for each step delegation', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);

      expect(result.decisions.length).toBeGreaterThanOrEqual(2);
      expect(result.decisions[0]!.decision).toBe('delegate');
      expect(result.decisions[0]!.stepId).toBe('step_1');
      expect(result.decisions[1]!.decision).toBe('delegate');
      expect(result.decisions[1]!.stepId).toBe('step_2');
    });

    it('should log session events for step lifecycle', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId)!;
      const eventTypes = session.events.map((event) => event.type);

      expect(eventTypes).toContain('session_started');
      expect(eventTypes).toContain('agent_started');
      expect(eventTypes).toContain('agent_stopped');
      expect(eventTypes).toContain('orchestrator_decision');
      expect(eventTypes).toContain('step_started');
      expect(eventTypes).toContain('step_completed');
      expect(eventTypes).toContain('session_completed');
      expect(eventTypes).toContain('auditor_evaluation');
      expect(eventTypes).toContain('run_completed');
    });

    it('should emit balanced agent lifecycle events around runtime execution', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId)!;
      const agentStarted = session.events.filter((event) => event.type === 'agent_started');
      const agentStopped = session.events.filter((event) => event.type === 'agent_stopped');

      expect(agentStarted).toHaveLength(2);
      expect(agentStopped).toHaveLength(2);
      expect(agentStarted[0]?.payload).toMatchObject({
        agentId: 'sales_associate',
        stepId: 'step_1',
        attempt: 1,
      });
      expect(agentStopped[0]?.payload).toMatchObject({
        agentId: 'sales_associate',
        stepId: 'step_1',
        attempt: 1,
        status: 'completed',
      });
    });

    it('should record an independent auditor verdict after terminal session events', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId)!;
      const auditorEvent = session.events.find((event) => event.type === 'auditor_evaluation');

      expect(auditorEvent).toBeDefined();
      expect(auditorEvent?.agentRole).toBe('auditor');
      expect(auditorEvent?.payload).toMatchObject({
        source: 'terminal_session_audit',
        trigger: 'run_completed',
        sessionId: result.sessionId,
        verdict: 'passed',
        summary: {
          agentStarted: 2,
          agentStopped: 2,
          terminalEvents: 1,
        },
      });
    });

    it('should emit handoff events when control moves between agents with a valid contract', async () => {
      const scenario = makeScenario({
        steps: [
          {
            id: 'step_1',
            name: 'Order intake',
            agentId: 'sales_associate',
            order: 0,
            requiredArtifacts: [],
            producedArtifacts: ['customerId', 'orderId'],
            handoff: {
              nextAgentId: 'fulfillment_agent',
              reason: 'Transfer to fulfillment',
              requiredArtifacts: ['customerId', 'orderId'],
              expectedOutput: 'Order fulfilled',
            },
          },
          {
            id: 'step_2',
            name: 'Fulfill Order',
            agentId: 'fulfillment_agent',
            order: 1,
            requiredArtifacts: ['customerId', 'orderId'],
            producedArtifacts: ['orderFulfilled'],
          },
        ],
        roles: ['sales_associate', 'fulfillment_agent'],
        requiredArtifacts: ['customerId', 'orderId', 'orderFulfilled'],
        allowedTools: ['registerCustomer', 'fulfillOrder'],
      })

      vi.spyOn(agentRuntime, 'executeStep')
        .mockResolvedValueOnce({
          stepIndex: 0,
          agentId: 'sales_associate',
          output: { customerId: '123', orderId: '456' },
          toolCalls: [],
          findings: [],
          durationMs: 100,
          success: true,
        })
        .mockResolvedValueOnce({
          stepIndex: 1,
          agentId: 'fulfillment_agent',
          output: { orderFulfilled: true },
          toolCalls: [],
          findings: [],
          durationMs: 100,
          success: true,
        })

      const result = await orchestrator.executeRun(scenario)
      const session = sessionService.getSession(result.sessionId)!
      const eventTypes = session.events.map((event) => event.type)

      expect(result.status).toBe('complete')
      expect(eventTypes).toContain('handoff_emitted')
      expect(eventTypes).toContain('handoff_accepted')
    })

    it('should fail the run when a multi-agent transition has no handoff contract', async () => {
      const scenario = makeScenario({
        steps: [
          {
            id: 'step_1',
            name: 'Order intake',
            agentId: 'sales_associate',
            order: 0,
            requiredArtifacts: [],
            producedArtifacts: ['customerId', 'orderId'],
          },
          {
            id: 'step_2',
            name: 'Fulfill Order',
            agentId: 'fulfillment_agent',
            order: 1,
            requiredArtifacts: ['customerId', 'orderId'],
            producedArtifacts: ['orderFulfilled'],
          },
        ],
        roles: ['sales_associate', 'fulfillment_agent'],
      })

      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue({
        stepIndex: 0,
        agentId: 'sales_associate',
        output: { customerId: '123', orderId: '456' },
        toolCalls: [],
        findings: [],
        durationMs: 100,
        success: true,
      })

      const result = await orchestrator.executeRun(scenario)
      const session = sessionService.getSession(result.sessionId)!

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Missing handoff contract')
      expect(session.events.some((event) => event.type === 'handoff_rejected')).toBe(true)
    })

    it('should fail run when step fails with no retries', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeFailOutput(0));

      const result = await orchestrator.executeRun(scenario);

      expect(result.status).toBe('failed');
      expect(result.stepsCompleted).toBe(0);
      expect(result.error).toContain('step_1');
    });

    it('should retry step up to maxAttempts before failing', async () => {
      const scenario = makeScenario({
        steps: [
          {
            id: 'step_retry',
            name: 'Retry Step',
            agentId: 'sales_associate',
            order: 0,
            requiredArtifacts: [],
            producedArtifacts: [],
            retryPolicy: { maxAttempts: 3, backoffMs: 0 },
          },
        ],
      });

      const executeSpy = vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeFailOutput(0));

      const result = await orchestrator.executeRun(scenario);

      expect(result.status).toBe('failed');
      expect(executeSpy).toHaveBeenCalledTimes(3);
      const retryDecisions = result.decisions.filter((decision) => decision.decision === 'retry');
      expect(retryDecisions.length).toBeGreaterThanOrEqual(2);
    });

    it('should succeed on retry when step eventually passes', async () => {
      const scenario = makeScenario({
        steps: [
          {
            id: 'step_flaky',
            name: 'Flaky Step',
            agentId: 'sales_associate',
            order: 0,
            requiredArtifacts: [],
            producedArtifacts: [],
            retryPolicy: { maxAttempts: 3, backoffMs: 0 },
          },
        ],
      });

      let callCount = 0;
      vi.spyOn(agentRuntime, 'executeStep').mockImplementation(async () => {
        callCount += 1;
        if (callCount < 3) return makeFailOutput(0);
        return makeSuccessOutput(0);
      });

      const result = await orchestrator.executeRun(scenario);

      expect(result.status).toBe('complete');
      expect(result.stepsCompleted).toBe(1);
    });

    it('should emit run_completed event on success', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId)!;
      const runCompletedEvents = session.events.filter((event) => event.type === 'run_completed');

      expect(runCompletedEvents).toHaveLength(1);
      expect(runCompletedEvents[0]!.data?.scenarioId).toBe('test_scenario');
    });

    it('should emit run_failed event on failure', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeFailOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId)!;
      const runFailedEvents = session.events.filter((event) => event.type === 'run_failed');

      expect(runFailedEvents).toHaveLength(1);
      expect(runFailedEvents[0]!.data?.failedStep).toBe('step_1');
    });

    it('should handle agent runtime exceptions', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockRejectedValue(new Error('Agent crashed'));

      const result = await orchestrator.executeRun(scenario);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('step_1');
    });

    it('should fail the run when a sensor reports failure for a successful step', async () => {
      const sensorRunner = new SensorRunner();
      sensorRunner.registerSensor('output', async () => ({
        sensor: 'output',
        status: 'fail',
        details: { errors: ['missing customerId'] },
      }));

      orchestrator = new Orchestrator(agentRuntime, sessionService, sensorRunner);
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue({
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {},
        toolCalls: [],
        findings: [],
        durationMs: 100,
        success: true,
      });

      const result = await orchestrator.executeRun(makeScenario({ steps: [makeScenario().steps[0]!] }));

      expect(result.status).toBe('failed');
      expect(result.error).toContain('step_1');
      const session = sessionService.getSession(result.sessionId)!;
      expect(session.events.some((event) => event.type === 'sensor_result')).toBe(true);
      expect(session.events.some((event) => event.type === 'step_failed')).toBe(true);
    });

    it('should save checkpoints after each successful step', async () => {
      const scenario = makeScenario();
      vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);
      const session = sessionService.getSession(result.sessionId)!;

      expect(session.checkpoint.lastCompletedStep).toBe(1);
    });

    it('should pass runtime context and persist all output artifacts', async () => {
      const page = { marker: 'page' };
      const executeSpy = vi.spyOn(agentRuntime, 'executeStep').mockImplementation(async (_agentId, _step, context) => {
        expect(context).toMatchObject({
          page,
          sessionId: expect.any(String),
        });
        return {
          stepIndex: 0,
          agentId: 'sales_associate',
          output: { customerId: '123', customerName: 'Maria Teste' },
          toolCalls: [],
          findings: [],
          durationMs: 100,
          success: true,
        };
      });

      const result = await orchestrator.executeRun(makeScenario({ steps: [makeScenario().steps[0]!] }), { page });
      const session = sessionService.getSession(result.sessionId)!;

      expect(executeSpy).toHaveBeenCalled();
      expect(session.artifacts.customerId).toBe('123');
      expect(session.artifacts.customerName).toBe('Maria Teste');
    });

    it('should reject scenario when workflowContract diverges from scenario steps', async () => {
      const scenario = makeScenario({
        steps: [
          {
            id: 'step_1',
            name: 'Create Customer',
            agentId: 'sales_associate',
            capabilityId: 'registerCustomer',
            order: 0,
            requiredArtifacts: [],
            producedArtifacts: ['customerId'],
          },
          {
            id: 'step_2',
            name: 'Schedule Order',
            agentId: 'sales_associate',
            capabilityId: 'createOrder',
            order: 1,
            requiredArtifacts: ['customerId'],
            producedArtifacts: ['orderId'],
          },
        ],
        workflowContract: {
          version: '1.0',
          deterministic: true,
          steps: [
            {
              id: 'step_1',
              order: 0,
              agentId: 'sales_associate',
              capabilityId: 'wrongCapability',
              requiredArtifacts: [],
              producedArtifacts: ['customerId'],
            },
            {
              id: 'step_2',
              order: 1,
              agentId: 'sales_associate',
              capabilityId: 'createOrder',
              requiredArtifacts: ['customerId'],
              producedArtifacts: ['orderId'],
            },
          ],
        },
      });

      await expect(orchestrator.executeRun(scenario)).rejects.toThrow(
        'workflowContract capability mismatch for step step_1',
      );
    });

    it('should execute using workflowContract step data as canonical source', async () => {
      const scenario = makeScenario({
        steps: [
          {
            id: 'step_1',
            name: 'Create Customer',
            agentId: 'sales_associate',
            order: 0,
            requiredArtifacts: [],
            producedArtifacts: ['customerId'],
          },
        ],
        workflowContract: {
          version: '1.0',
          deterministic: true,
          steps: [
            {
              id: 'step_1',
              order: 0,
              agentId: 'sales_associate',
              capabilityId: 'registerCustomer',
              requiredArtifacts: [],
              producedArtifacts: ['customerId'],
              timeoutMs: 12345,
              retryPolicy: { maxAttempts: 1, backoffMs: 0 },
            },
          ],
        },
      });

      const executeSpy = vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue(makeSuccessOutput(0));

      const result = await orchestrator.executeRun(scenario);

      expect(result.status).toBe('complete');
      expect(executeSpy).toHaveBeenCalledWith(
        'sales_associate',
        expect.objectContaining({
          id: 'step_1',
          capabilityId: 'registerCustomer',
          timeoutMs: 12345,
          producedArtifacts: ['customerId'],
        }),
        expect.objectContaining({
          sessionId: expect.any(String),
        }),
      );
    });
  });
});
