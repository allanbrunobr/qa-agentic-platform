import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { loadScenario, listScenarios } from '../scenarios/index.js';
import { Orchestrator } from '../services/orchestrator.js';
import { SessionService } from '../services/session-service.js';
import { AgentRuntime } from '../services/agent-runtime.js';

const previousReferenceScenarioFlag = process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'];

beforeAll(() => {
  process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'] = '1';
});

afterAll(() => {
  if (previousReferenceScenarioFlag === undefined) {
    delete process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'];
  } else {
    process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'] = previousReferenceScenarioFlag;
  }
});

describe('Scenario Loading', () => {
  it('should load first_order scenario', () => {
    const scenario = loadScenario('first_order');

    expect(scenario.id).toBe('first_order');
    expect(scenario.name).toBe('First Order');
    expect(scenario.steps).toHaveLength(2);
    expect(scenario.steps[0]!.id).toBe('register_customer');
    expect(scenario.steps[1]!.id).toBe('create_order');
  });

  it('should validate scenario contract with Zod', () => {
    const scenario = loadScenario('first_order');

    expect(scenario.requiredArtifacts).toContain('customerId');
    expect(scenario.requiredArtifacts).toContain('orderId');
    expect(scenario.roles).toContain('sales_associate');
    expect(scenario.allowedTools).toEqual(['registerCustomer', 'createOrder']);
    expect(scenario.workflowContract).toEqual({
      version: '1.0',
      deterministic: true,
      steps: [
        {
          id: 'register_customer',
          order: 0,
          agentId: 'sales_associate',
          capabilityId: 'registerCustomer',
          requiredArtifacts: [],
          producedArtifacts: ['customerId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
        },
        {
          id: 'create_order',
          order: 1,
          agentId: 'sales_associate',
          capabilityId: 'createOrder',
          requiredArtifacts: ['customerId'],
          producedArtifacts: ['orderId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
        },
      ],
    });
  });

  it('should throw on unknown scenario', () => {
    expect(() => loadScenario('nonexistent')).toThrow('Scenario "nonexistent" not found');
  });

  it('should list available scenarios', () => {
    const list = listScenarios();
    expect(list).toContain('first_order');
    expect(list).toContain('first_order_multi_role');
    expect(list).toContain('quarterly_reorder_multi_role');
  });

  it('should synthesize handoff contracts for generated multi-agent scenarios', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'generated-scenarios-'));
    const scenariosFile = path.join(fixtureRoot, 'scenarios.generated.json');
    await writeFile(scenariosFile, JSON.stringify([{
      id: 'generated_multi_agent',
      title: 'Generated Multi Agent',
      roles: ['operator', 'reviewer'],
      steps: ['step_1', 'step_2'],
      expectedArtifacts: ['commandResult', 'verificationResult'],
      stepDefinitions: [
        {
          id: 'step_1',
          roleId: 'operator',
          capabilityId: 'click_start_session',
          producesArtifacts: ['commandResult'],
        },
        {
          id: 'step_2',
          roleId: 'reviewer',
          capabilityId: 'assert_primary_visible_state',
          producesArtifacts: ['verificationResult'],
        },
      ],
    }]));

    const previousGeneratedScenarios = process.env['PERSONA_QA_SCENARIOS_FILE'];
    const previousReferenceFlag = process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'];
    process.env['PERSONA_QA_SCENARIOS_FILE'] = scenariosFile;
    process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'] = '0';

    try {
      const scenario = loadScenario('generated_multi_agent');
      expect(scenario.steps[0]!.handoff).toEqual({
        nextAgentId: 'reviewer',
        reason: 'Generated handoff from operator to reviewer after step_1.',
        requiredArtifacts: ['commandResult'],
        expectedOutput: 'Continue execution with capability assert_primary_visible_state.',
      });
    } finally {
      if (previousGeneratedScenarios === undefined) {
        delete process.env['PERSONA_QA_SCENARIOS_FILE'];
      } else {
        process.env['PERSONA_QA_SCENARIOS_FILE'] = previousGeneratedScenarios;
      }

      if (previousReferenceFlag === undefined) {
        delete process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'];
      } else {
        process.env['PERSONA_QA_USE_REFERENCE_SCENARIOS'] = previousReferenceFlag;
      }
    }
  });

  it('should have correct step ordering', () => {
    const scenario = loadScenario('first_order');
    for (let i = 0; i < scenario.steps.length; i += 1) {
      expect(scenario.steps[i]!.order).toBe(i);
    }
  });

  it('should define required/produced artifacts per step', () => {
    const scenario = loadScenario('first_order');
    const step1 = scenario.steps[0]!;
    const step2 = scenario.steps[1]!;

    expect(step1.requiredArtifacts).toEqual([]);
    expect(step1.producedArtifacts).toContain('customerId');
    expect(step2.requiredArtifacts).toContain('customerId');
    expect(step2.producedArtifacts).toContain('orderId');
  });

  it('should load first_order_multi_role scenario with handoff to fulfillment_agent', () => {
    const scenario = loadScenario('first_order_multi_role');

    expect(scenario.roles).toEqual(['sales_associate', 'fulfillment_agent']);
    expect(scenario.steps).toHaveLength(3);
    expect(scenario.steps[1]!.handoff).toEqual({
      nextAgentId: 'fulfillment_agent',
      reason: expect.any(String),
      requiredArtifacts: ['customerId', 'orderId'],
      expectedOutput: expect.any(String),
    });
    expect(scenario.steps[2]!.agentId).toBe('fulfillment_agent');
    expect(scenario.allowedTools).toContain('fulfillOrder');
    expect(scenario.workflowContract).toEqual({
      version: '1.0',
      deterministic: true,
      steps: [
        {
          id: 'register_customer',
          order: 0,
          agentId: 'sales_associate',
          capabilityId: 'registerCustomer',
          requiredArtifacts: [],
          producedArtifacts: ['customerId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'create_order',
          order: 1,
          agentId: 'sales_associate',
          capabilityId: 'createOrder',
          requiredArtifacts: ['customerId'],
          producedArtifacts: ['orderId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'fulfill_order',
          order: 2,
          agentId: 'fulfillment_agent',
          capabilityId: 'fulfillOrder',
          requiredArtifacts: ['customerId', 'orderId'],
          producedArtifacts: ['orderFulfilled'],
          timeoutMs: 180000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
    });
  });

  it('should load quarterly_reorder_multi_role scenario with fulfillment_agent -> billing_clerk handoff', () => {
    const scenario = loadScenario('quarterly_reorder_multi_role');

    expect(scenario.roles).toEqual(['sales_associate', 'fulfillment_agent', 'billing_clerk']);
    expect(scenario.steps).toHaveLength(4);
    expect(scenario.steps[2]!.handoff).toEqual({
      nextAgentId: 'billing_clerk',
      reason: expect.any(String),
      requiredArtifacts: ['customerId', 'orderId', 'orderFulfilled'],
      expectedOutput: expect.any(String),
    });
    expect(scenario.steps[3]!.agentId).toBe('billing_clerk');
    expect(scenario.allowedTools).toContain('findInvoiceByOrderId');
    expect(scenario.workflowContract).toEqual({
      version: '1.0',
      deterministic: true,
      steps: [
        {
          id: 'register_customer',
          order: 0,
          agentId: 'sales_associate',
          capabilityId: 'registerCustomer',
          requiredArtifacts: [],
          producedArtifacts: ['customerId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'create_reorder',
          order: 1,
          agentId: 'sales_associate',
          capabilityId: 'createOrder',
          requiredArtifacts: ['customerId'],
          producedArtifacts: ['orderId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'fulfill_reorder',
          order: 2,
          agentId: 'fulfillment_agent',
          capabilityId: 'fulfillOrder',
          requiredArtifacts: ['customerId', 'orderId'],
          producedArtifacts: ['orderFulfilled'],
          timeoutMs: 180000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'review_invoice',
          order: 3,
          agentId: 'billing_clerk',
          capabilityId: 'findInvoiceByOrderId',
          requiredArtifacts: ['orderId', 'orderFulfilled'],
          producedArtifacts: ['invoiceReviewed'],
          timeoutMs: 120000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
    });
  });

  it('should load quarterly_reorder_closure_multi_role scenario with billing_clerk -> store_manager handoff', () => {
    const scenario = loadScenario('quarterly_reorder_closure_multi_role');

    expect(scenario.roles).toEqual(['sales_associate', 'fulfillment_agent', 'billing_clerk', 'store_manager']);
    expect(scenario.steps).toHaveLength(5);
    expect(scenario.steps[3]!.handoff).toEqual({
      nextAgentId: 'store_manager',
      reason: expect.any(String),
      requiredArtifacts: ['orderId', 'orderFulfilled', 'invoiceReviewed'],
      expectedOutput: expect.any(String),
    });
    expect(scenario.steps[4]!.agentId).toBe('store_manager');
    expect(scenario.allowedTools).toContain('verifyFinanceDashboard');
    expect(scenario.allowedTools).toContain('verifyReportsPage');
    expect(scenario.workflowContract).toEqual({
      version: '1.0',
      deterministic: true,
      steps: [
        {
          id: 'register_customer',
          order: 0,
          agentId: 'sales_associate',
          capabilityId: 'registerCustomer',
          requiredArtifacts: [],
          producedArtifacts: ['customerId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'create_reorder',
          order: 1,
          agentId: 'sales_associate',
          capabilityId: 'createOrder',
          requiredArtifacts: ['customerId'],
          producedArtifacts: ['orderId'],
          timeoutMs: 90000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'fulfill_reorder',
          order: 2,
          agentId: 'fulfillment_agent',
          capabilityId: 'fulfillOrder',
          requiredArtifacts: ['customerId', 'orderId'],
          producedArtifacts: ['orderFulfilled'],
          timeoutMs: 180000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'review_invoice',
          order: 3,
          agentId: 'billing_clerk',
          capabilityId: 'findInvoiceByOrderId',
          requiredArtifacts: ['orderId', 'orderFulfilled'],
          producedArtifacts: ['invoiceReviewed'],
          timeoutMs: 120000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'validate_management_closure',
          order: 4,
          agentId: 'store_manager',
          capabilityId: 'validateManagementClosure',
          requiredArtifacts: ['orderId', 'invoiceReviewed'],
          producedArtifacts: ['financeValidated', 'reportsValidated'],
          timeoutMs: 120000,
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
    });
  });
});

describe('Run Resume', () => {
  let sessionService: SessionService;
  let agentRuntime: AgentRuntime;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    sessionService = new SessionService();
    agentRuntime = new AgentRuntime();
    orchestrator = new Orchestrator(agentRuntime, sessionService);
  });

  it('should resume from checkpoint after first step completed', async () => {
    const scenario = loadScenario('first_order');

    const session = sessionService.createSession(scenario.id);
    sessionService.updateStatus(session.id, 'running');
    sessionService.saveCheckpoint(session.id, 0);

    vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue({
      stepIndex: 1,
      agentId: 'sales_associate',
      output: { orderId: '789' },
      toolCalls: [],
      findings: [],
      durationMs: 100,
      success: true,
    });

    const result = await orchestrator.resumeRun(session.id, scenario);

    expect(result.status).toBe('complete');
    expect(agentRuntime.executeStep).toHaveBeenCalledTimes(1);
  });

  it('should throw if session not found', async () => {
    const scenario = loadScenario('first_order');
    await expect(orchestrator.resumeRun('nonexistent', scenario)).rejects.toThrow('Session nonexistent not found');
  });

  it('should resume from beginning if no checkpoint', async () => {
    const scenario = loadScenario('first_order');
    const session = sessionService.createSession(scenario.id);

    vi.spyOn(agentRuntime, 'executeStep').mockResolvedValue({
      stepIndex: 0,
      agentId: 'sales_associate',
      output: { customerId: '123', orderId: '456' },
      toolCalls: [],
      findings: [],
      durationMs: 50,
      success: true,
    });

    const result = await orchestrator.resumeRun(session.id, scenario);

    expect(result.status).toBe('complete');
    expect(agentRuntime.executeStep).toHaveBeenCalledTimes(2);
  });
});
