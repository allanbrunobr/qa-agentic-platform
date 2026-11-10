import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { domainDiscoveryRoutes } from '../domain-discovery.js';
import { setSessionService } from '../../phase2/routes/sessions.js';
import { SessionService } from '../../phase2/services/session-service.js';

let tempDir = '';
let bundleFile = '';
let codeGraphFile = '';

async function createApp() {
  const app = Fastify();
  await app.register(domainDiscoveryRoutes);
  await app.ready();
  return app;
}

describe('/api/p2/domain-discovery', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domain-discovery-route-'));
    bundleFile = path.join(tempDir, 'adapter', 'config', 'domain-discovery-bundle.generated.json');
    codeGraphFile = path.join(tempDir, 'adapter', 'config', 'code-graph.generated.json');
    process.env['PERSONA_QA_DOMAIN_DISCOVERY_FILE'] = bundleFile;
    process.env['PERSONA_QA_CODE_GRAPH_FILE'] = codeGraphFile;
    setSessionService(new SessionService(':memory:'));
  });

  afterEach(async () => {
    delete process.env['PERSONA_QA_DOMAIN_DISCOVERY_FILE'];
    delete process.env['PERSONA_QA_CODE_GRAPH_FILE'];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns unavailable when domain discovery has not been generated', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/p2/domain-discovery' });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      available: false,
      filePath: null,
      summary: null,
      bundle: null,
    });
  });

  it('returns summarized domain candidates with evidence counts', async () => {
    await fs.mkdir(path.dirname(bundleFile), { recursive: true });
    await fs.writeFile(bundleFile, JSON.stringify(domainBundle()), 'utf-8');

    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/p2/domain-discovery' });
    await app.close();

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.available, true);
    assert.equal(body.filePath, bundleFile);
    assert.equal(body.summary.domain, 'commerce');
    assert.equal(body.summary.personas, 1);
    assert.equal(body.summary.scenarios, 1);
    assert.equal(body.summary.capabilities, 1);
    assert.equal(body.summary.evidenceItems, 3);
    assert.equal(body.summary.mappingRequired, 1);
    assert.equal(body.bundle.personas[0].id, 'shopper');
  });

  it('rejects malformed generated bundles', async () => {
    await fs.mkdir(path.dirname(bundleFile), { recursive: true });
    await fs.writeFile(bundleFile, JSON.stringify({ domain: { domain: 'broken' } }), 'utf-8');

    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/p2/domain-discovery' });
    await app.close();

    assert.equal(res.statusCode, 422);
    assert.equal(JSON.parse(res.body).error, 'Invalid domain discovery bundle');
  });

  it('creates a pending scenario draft from a domain discovery scenario candidate', async () => {
    await fs.mkdir(path.dirname(bundleFile), { recursive: true });
    await fs.writeFile(bundleFile, JSON.stringify(domainBundle()), 'utf-8');
    await fs.writeFile(codeGraphFile, JSON.stringify(codeGraphWithReadiness()), 'utf-8');

    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/p2/domain-discovery/scenarios/place_order/drafts',
    });
    await app.close();

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.draft.status, 'pending');
    assert.equal(body.draft.scenarioId, 'domain_commerce_place_order');
    assert.equal(body.draft.name, 'Domain draft: Place order');
    assert.equal(body.draft.gapType, 'domain_discovery_mapping');
    assert.equal(body.source.domain, 'commerce');
    assert.equal(body.source.mappingRequired, true);
    assert.equal(body.source.graphReadiness.status, 'partially_mapped');
    assert.equal(body.draft.contract.domainDiscovery.sourceScenarioId, 'place_order');
    assert.equal(body.draft.contract.domainDiscovery.mappingRequired, true);
    assert.equal(body.draft.contract.domainDiscovery.graphReadiness.status, 'partially_mapped');
    assert.deepEqual(body.draft.contract.domainDiscovery.graphReadiness.missingCapabilityIds, ['submit_order']);
    assert.deepEqual(body.draft.contract.roles, ['shopper']);
    assert.equal(body.draft.contract.steps[0].capabilityId, 'submit_order');
    assert.equal(body.draft.contract.workflowContract.steps[0].capabilityId, 'submit_order');
    assert.match(body.warnings[0], /Review selectors/);
  });

  it('blocks restricted domain discovery scenario candidates from draft creation', async () => {
    const bundle = domainBundle();
    bundle.scenarios[0]!.status = 'restricted';
    await fs.mkdir(path.dirname(bundleFile), { recursive: true });
    await fs.writeFile(bundleFile, JSON.stringify(bundle), 'utf-8');

    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/p2/domain-discovery/scenarios/place_order/drafts',
    });
    await app.close();

    assert.equal(res.statusCode, 409);
    assert.equal(
      JSON.parse(res.body).error,
      'Restricted domain discovery candidates cannot be promoted to scenario drafts',
    );
  });
});

function domainBundle() {
  const evidenceRef = { evidenceId: 'button_submit_order', kind: 'button' };

  return {
    surfaceMap: {
      targetId: 'commerce_fixture',
      routes: [{ id: 'route_root' }],
      components: [],
      forms: [],
      buttons: [{ id: 'button_submit_order' }],
      texts: [{ id: 'text_checkout' }],
      navigation: [],
      packages: [],
      frameworks: [],
      tests: [],
    },
    domain: {
      domain: 'commerce',
      label: 'Commerce',
      summary: 'Checkout workflow.',
      confidence: 0.82,
      status: 'draft',
      evidenceRefs: [evidenceRef],
      risks: [],
      entities: [],
    },
    personas: [{
      id: 'shopper',
      title: 'Shopper',
      rationale: 'Checkout evidence exists.',
      goals: ['Place order'],
      allowedCapabilityIds: ['submit_order'],
      confidence: 0.8,
      status: 'draft',
      evidenceRefs: [evidenceRef],
      risks: [],
    }],
    scenarios: [{
      id: 'place_order',
      title: 'Place order',
      rationale: 'Order button exists.',
      participatingPersonaIds: ['shopper'],
      requiredCapabilityIds: ['submit_order'],
      steps: [{ id: 'submit_order', title: 'Submit order', intent: 'Submit order', evidenceRefs: [evidenceRef] }],
      confidence: 0.74,
      status: 'needs_human_mapping',
      evidenceRefs: [evidenceRef],
      risks: [],
    }],
    capabilities: [{
      id: 'submit_order',
      title: 'Submit order',
      purpose: 'Click the visible order submission action.',
      kind: 'button_click',
      mappedSurfaceIds: ['button_submit_order'],
      selectorHints: ['Submit order'],
      confidence: 0.7,
      status: 'needs_human_mapping',
      evidenceRefs: [evidenceRef],
      risks: [],
    }],
    audit: {
      id: 'audit_commerce',
      summary: 'Human mapping required.',
      findings: [{
        id: 'human_mapping_required',
        severity: 'info',
        message: 'Selectors and auth still require mapping.',
        candidateIds: ['place_order'],
        evidenceRefs: [evidenceRef],
      }],
      downgradedCandidateIds: ['place_order'],
      confidence: 0.82,
      status: 'needs_human_mapping',
      evidenceRefs: [evidenceRef],
      risks: [],
    },
  };
}

function codeGraphWithReadiness() {
  return {
    schemaVersion: 'code-graph/v1',
    targetId: 'commerce_fixture',
    repositoryKind: 'frontend',
    generatedAt: '2026-01-01T00:00:00.000Z',
    nodes: [{
      id: 'scenario_candidate:place_order',
      type: 'scenario_candidate',
      label: 'Place order',
      metadata: {
        scenarioId: 'place_order',
        graphReadiness: {
          status: 'partially_mapped',
          confidence: 0.42,
          requiredCapabilityCount: 1,
          mappedCapabilityCount: 0,
          mappedCapabilityIds: [],
          missingCapabilityIds: ['submit_order'],
          supportSourceTypes: ['http_call'],
        },
      },
    }],
    edges: [],
    stats: {
      nodeCount: 1,
      edgeCount: 0,
      evidenceNodeCount: 0,
      candidateNodeCount: 1,
    },
  };
}
