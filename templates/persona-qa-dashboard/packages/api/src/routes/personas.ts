import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const AdapterPersonaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().default(''),
  allowedCapabilities: z.array(z.string()).default([]),
});

type AdapterPersona = z.infer<typeof AdapterPersonaSchema>;

interface PersonaData {
  slug: string;
  name: string;
  role: string;
  description: string;
  modules: string[];
  color: string | null;
  filePath: string;
  source: 'adapter';
}

function getAdapterPersonasCandidates(): string[] {
  return [
    process.env['PERSONA_QA_PERSONAS_FILE'],
    path.resolve(process.cwd(), 'adapter', 'personas', 'personas.generated.json'),
    path.resolve(process.cwd(), '..', '..', 'adapter', 'personas', 'personas.generated.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function getWritableAdapterPersonasFile(): string {
  return (
    process.env['PERSONA_QA_PERSONAS_FILE'] ??
    path.resolve(process.cwd(), 'adapter', 'personas', 'personas.generated.json')
  );
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function readAdapterPersonas(): Promise<{ filePath: string | null; personas: AdapterPersona[] }> {
  const filePath = await firstExistingFile(getAdapterPersonasCandidates());
  if (!filePath) {
    return { filePath: null, personas: [] };
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = z.array(AdapterPersonaSchema).safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`Invalid generated personas file: ${filePath}`);
  }

  return { filePath, personas: parsed.data };
}

function toPersonaData(persona: AdapterPersona, filePath: string): PersonaData {
  return {
    slug: persona.id,
    name: persona.title,
    role: persona.id,
    description: persona.goal,
    modules: persona.allowedCapabilities,
    color: null,
    filePath,
    source: 'adapter',
  };
}

function normalizeId(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const CreatePersonaBody = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  description: z.string().min(1),
  modules: z.array(z.string()).min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  context: z.string().optional().default(''),
});

export async function personasRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/personas', async (_request, reply) => {
    const { filePath, personas } = await readAdapterPersonas();
    if (!filePath) return reply.send([]);

    return reply.send(personas.map((persona) => toPersonaData(persona, filePath)));
  });

  app.post('/api/personas', async (request, reply) => {
    const parseResult = CreatePersonaBody.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parseResult.error.issues,
      });
    }

    const { name, role, description, modules } = parseResult.data;
    const id = normalizeId(role || name);
    const filePath = (await firstExistingFile(getAdapterPersonasCandidates())) ?? getWritableAdapterPersonasFile();
    // S-14: an unreadable or invalid personas file used to read as "no personas", and the write below
    // then replaced every existing persona with the new one. Refuse instead of overwriting.
    let existing: AdapterPersona[];
    try {
      existing = (await readAdapterPersonas()).personas;
    } catch (error) {
      return reply.status(409).send({
        error: 'personas_file_unreadable',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (existing.some((persona) => persona.id === id)) {
      return reply.status(409).send({ error: `Persona "${id}" already exists` });
    }

    const persona: AdapterPersona = {
      id,
      title: name,
      goal: description,
      allowedCapabilities: modules,
    };
    const nextPersonas = [...existing, persona];

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(nextPersonas, null, 2), 'utf-8');

    return reply.status(201).send(toPersonaData(persona, filePath));
  });
}
