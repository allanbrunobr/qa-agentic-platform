import { describe, it, expect } from 'vitest';
import { artifactSensor } from '../sensors/artifact-sensor.js';
import { toolPolicySensor, checkToolPolicy } from '../sensors/tool-policy-sensor.js';
import { timeoutSensor } from '../sensors/timeout-sensor.js';
import { SensorRunner, type SensorContext } from '../services/sensor-runner.js';
import { schemaSensor } from '../sensors/schema-sensor.js';
import { outputSensor } from '../sensors/output-sensor.js';
import type { ScenarioStep } from '../types/scenario-types.js';

function makeContext(overrides?: Partial<SensorContext>): SensorContext {
  const step: ScenarioStep = {
    id: 'step_1',
    name: 'Create Customer',
    agentId: 'sales_associate',
    order: 0,
    requiredArtifacts: [],
    producedArtifacts: ['customerId'],
    timeoutMs: 30000,
  };

  return {
    sessionId: 'session_1',
    step,
    agentId: 'sales_associate',
    stepOutput: {
      stepIndex: 0,
      agentId: 'sales_associate',
      output: { customerId: '123' },
      toolCalls: [],
      findings: [],
      durationMs: 100,
      success: true,
    },
    session: {
      id: 'session_1',
      scenarioId: 'test',
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      artifacts: { customerId: '123', orderId: '456' },
      findings: [],
      checkpoint: { lastCompletedStep: -1, cursor: 0 },
    },
    scenario: {
      id: 'test',
      name: 'Test',
      steps: [step],
      roles: [],
      requiredArtifacts: ['customerId', 'orderId'],
      allowedTools: [],
    },
    ...overrides,
  };
}

describe('ArtifactSensor', () => {
  it('should pass when the step required artifacts are present', async () => {
    const context = makeContext();
    const result = await artifactSensor(context);

    expect(result.sensor).toBe('artifact_completeness');
    expect(result.status).toBe('pass');
    expect(result.details['missing']).toEqual([]);
  });

  it('should pass when required artifacts are inside persisted artifact payloads', async () => {
    const context = makeContext({
      step: {
        id: 'step_2',
        name: 'Schedule Order',
        agentId: 'sales_associate',
        order: 1,
        requiredArtifacts: ['customerId'],
        producedArtifacts: ['orderId'],
        timeoutMs: 30000,
      },
      stepOutput: {
        stepIndex: 1,
        agentId: 'sales_associate',
        output: { orderId: '456' },
        toolCalls: [],
        findings: [],
        durationMs: 100,
        success: true,
      },
      session: {
        id: 'session_1',
        scenarioId: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
        events: [],
        artifacts: {
          generated_artifact: {
            type: 'customerId',
            payload: { customerId: '123' },
          },
        },
        findings: [],
        checkpoint: { lastCompletedStep: -1, cursor: 0 },
      },
    });

    const result = await artifactSensor(context);
    expect(result.status).toBe('pass');
    expect(result.details['missing']).toEqual([]);
  });

  it('should fail when the current step is missing its required artifacts', async () => {
    const context = makeContext({
      step: {
        id: 'step_2',
        name: 'Schedule Order',
        agentId: 'sales_associate',
        order: 1,
        requiredArtifacts: ['customerId', 'orderId'],
        producedArtifacts: [],
        timeoutMs: 30000,
      },
      session: {
        id: 'session_1',
        scenarioId: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
        events: [],
        artifacts: { customerId: '123' }, // missing orderId
        findings: [],
        checkpoint: { lastCompletedStep: -1, cursor: 0 },
      },
    });

    const result = await artifactSensor(context);
    expect(result.status).toBe('fail');
    expect(result.details['missing']).toContain('orderId');
  });

  it('should fail when no required step artifacts are available', async () => {
    const context = makeContext({
      step: {
        id: 'step_2',
        name: 'Schedule Order',
        agentId: 'sales_associate',
        order: 1,
        requiredArtifacts: ['customerId', 'orderId'],
        producedArtifacts: [],
        timeoutMs: 30000,
      },
      session: {
        id: 'session_1',
        scenarioId: 'test',
        status: 'running',
        startedAt: new Date().toISOString(),
        events: [],
        artifacts: {},
        findings: [],
        checkpoint: { lastCompletedStep: -1, cursor: 0 },
      },
    });

    const result = await artifactSensor(context);
    expect(result.status).toBe('fail');
    expect(result.details['missing']).toEqual(['orderId']);
  });
});

describe('ToolPolicySensor', () => {
  it('should pass when no tool calls exist', async () => {
    const context = makeContext();
    const result = await toolPolicySensor(context);

    expect(result.sensor).toBe('tool_policy');
    expect(result.status).toBe('pass');
  });

  it('should pass when tool calls are within policy', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: { customerId: '123' },
        toolCalls: [{ tool: 'registerCustomer', args: {} }],
        findings: [],
        durationMs: 100,
        success: true,
      },
    });

    const result = await toolPolicySensor(context);
    expect(result.status).toBe('pass');
  });

  // Pre-PR finding #8: the runtime offers the step's support tools (evidence, findings) next to its
  // capability (B-04), so the scenario policy must accept them; another tool still fails the step.
  it('accepts the support tools a step is offered, and still refuses any other tool', async () => {
    const stepOutput = (tools: string[]) => ({
      stepIndex: 0,
      agentId: 'sales_associate',
      output: { customerId: '123' },
      toolCalls: tools.map((tool) => ({ tool, args: {} })),
      findings: [],
      durationMs: 100,
      success: true,
    });

    const policy = { ...makeContext().scenario, allowedTools: ['registerCustomer'] };
    const supported = await toolPolicySensor(makeContext({ scenario: policy, stepOutput: stepOutput(['registerCustomer', 'captureScreenshot', 'collectDomSnippet', 'reportFinding']) }));
    expect(supported.status).toBe('pass');

    const outside = await toolPolicySensor(makeContext({ scenario: policy, stepOutput: stepOutput(['registerCustomer', 'deleteEverything']) }));
    expect(outside.status).toBe('fail');
  });
});

describe('checkToolPolicy', () => {
  it('should detect browser policy violation', () => {
    const violations = checkToolPolicy(
      [{ tool: 'navigate' }, { tool: 'click' }],
      { browser: false, api: true, database: true, file: true },
    );

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('browser');
  });

  it('should pass when all categories allowed', () => {
    const violations = checkToolPolicy(
      [{ tool: 'navigate' }, { tool: 'query' }],
      { browser: true, api: true, database: true, file: true },
    );

    expect(violations).toHaveLength(0);
  });

  it('should detect database policy violation', () => {
    const violations = checkToolPolicy(
      [{ tool: 'query' }],
      { browser: true, api: true, database: false, file: true },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('database');
  });

  it('should ignore unknown tools', () => {
    const violations = checkToolPolicy(
      [{ tool: 'customTool' }],
      { browser: false, api: false, database: false, file: false },
    );

    expect(violations).toHaveLength(0);
  });
});

describe('TimeoutSensor', () => {
  it('should pass when within timeout', async () => {
    const context = makeContext();
    const result = await timeoutSensor(context);

    expect(result.sensor).toBe('timeout');
    expect(result.status).toBe('pass');
    expect(result.details['elapsed']).toBe(100);
    expect(result.details['limit']).toBe(30000);
  });

  it('should fail when exceeding timeout', async () => {
    const context = makeContext({
      stepOutput: {
        stepIndex: 0,
        agentId: 'sales_associate',
        output: {},
        toolCalls: [],
        findings: [],
        durationMs: 35000,
        success: true,
      },
    });

    const result = await timeoutSensor(context);
    expect(result.status).toBe('fail');
    expect(result.details['overBy']).toBe(5000);
  });

  it('should pass when no timeout configured', async () => {
    const context = makeContext({
      step: {
        id: 'step_1',
        name: 'Test',
        agentId: 'sales_associate',
        order: 0,
        requiredArtifacts: [],
        producedArtifacts: [],
        // no timeoutMs
      },
    });

    const result = await timeoutSensor(context);
    expect(result.status).toBe('pass');
    expect(result.details['reason']).toContain('No timeout');
  });
});

describe('SensorRunner — all sensors registered', () => {
  it('should run all 5 sensors', async () => {
    const runner = new SensorRunner();
    runner.registerSensor('schema', schemaSensor);
    runner.registerSensor('output', outputSensor);
    runner.registerSensor('artifact_completeness', artifactSensor);
    runner.registerSensor('tool_policy', toolPolicySensor);
    runner.registerSensor('timeout', timeoutSensor);

    const context = makeContext();
    const results = await runner.runAll(context);

    expect(results).toHaveLength(5);
    const sensors = results.map(r => r.sensor);
    expect(sensors).toContain('schema');
    expect(sensors).toContain('output');
    expect(sensors).toContain('artifact_completeness');
    expect(sensors).toContain('tool_policy');
    expect(sensors).toContain('timeout');

    // All should pass with the default good context
    for (const r of results) {
      expect(r.status).toBe('pass');
    }
  });
});
