import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AtomicStore } from './store.ts';

const PROTOCOL = 1;
const VERSION = '0.1.0';

interface Request {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function dataFile() {
  if (process.env.SURFACE_ATOMIC_DB) return process.env.SURFACE_ATOMIC_DB;
  const hash = createHash('sha256').update(String(process.env.USERNAME ?? process.env.USER ?? 'local')).digest('hex').slice(0, 16);
  const dir = join(process.env.APPDATA ?? homedir(), 'SurfaceAtomic', 'data', hash);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'atomic.sqlite');
}

const store = new AtomicStore(dataFile());
const input = createInterface({ input: process.stdin });

input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: Request;
  try {
    request = JSON.parse(trimmed) as Request;
  } catch {
    write({ id: null, error: { code: 'invalid_json', message: 'Each line must be a JSON object.' } });
    return;
  }
  try {
    write({ id: request.id ?? null, result: dispatch(request.method ?? '', request.params ?? {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    write({ id: request.id ?? null, error: { code: 'rejected', message } });
  }
});

input.on('close', () => {
  store.close();
});

function dispatch(method: string, params: Record<string, unknown>) {
  switch (method) {
    case 'hello': {
      if (params.protocolVersion !== PROTOCOL) {
        throw new Error(`protocol ${String(params.protocolVersion)} is not supported`);
      }
      return { version: VERSION, protocolVersion: PROTOCOL };
    }
    case 'recordExperience':
      return store.recordExperience({
        conversationId: stringOrUndefined(params.conversationId),
        agentId: stringOrUndefined(params.agentId),
        promptSummary: stringOrUndefined(params.promptSummary),
        responseSummary: stringOrUndefined(params.responseSummary),
        objectHints: arrayOf(params.objectHints),
      });
    case 'upsertObject':
      return store.upsertObject({
        type: String(params.type ?? ''),
        key: String(params.key ?? ''),
        name: stringOrUndefined(params.name),
      });
    case 'recordAtom':
      return store.recordAtom({
        experienceId: stringOrUndefined(params.experienceId),
        who: stringOrUndefined(params.who),
        verb: String(params.verb ?? 'ask'),
        objectKeys: arrayOf(params.objectKeys),
        when: stringOrUndefined(params.when),
        product: stringOrUndefined(params.product),
        taskId: stringOrUndefined(params.taskId),
        resultJson: stringOrUndefined(params.resultJson),
        evidence: stringOrUndefined(params.evidence),
      });
    case 'recall':
      return store.recall(
        String(params.query ?? ''),
        arrayOf(params.objectKeys),
        Number(params.limit ?? 8) || 8,
      );
    case 'shutdown':
      store.close();
      process.exit(0);
      return {};
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function arrayOf(value: unknown): { type: string; key: string; name?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object') as { type: string; key: string; name?: string }[];
}

function write(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
