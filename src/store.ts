import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decayedMass } from './mass.ts';

export interface ObjectHint {
  type: string;
  key: string;
  name?: string;
}

export interface ObjectRow {
  id: string;
  type: string;
  key: string;
  name: string;
  mass: number;
}

export interface AtomRow {
  id: string;
  verb: string;
  who: string | null;
  at: string | null;
  evidence: string | null;
  objectKeys: { type: string; key: string }[];
}

export class AtomicStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
    this.db.exec(readFileSync(schemaPath, 'utf8'));
  }

  close() {
    this.db.close();
  }

  recordExperience(input: {
    conversationId?: string;
    agentId?: string;
    promptSummary?: string;
    responseSummary?: string;
    objectHints?: ObjectHint[];
  }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO experience (id, conversation_id, agent_id, prompt_summary, response_summary, created_on)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.conversationId ?? null, input.agentId ?? null, input.promptSummary ?? null,
      input.responseSummary ?? null, new Date().toISOString());
    for (const hint of input.objectHints ?? []) {
      this.upsertObject(hint);
    }
    return { experienceId: id };
  }

  upsertObject(hint: ObjectHint) {
    const existing = this.db.prepare('SELECT id FROM object WHERE type = ? AND key = ?').get(hint.type, hint.key) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    if (!existing) {
      this.db.prepare('INSERT INTO object (id, type, key, name) VALUES (?, ?, ?, ?)').run(
        id, hint.type, hint.key, hint.name ?? hint.key);
    } else if (hint.name) {
      this.db.prepare('UPDATE object SET name = ? WHERE id = ?').run(hint.name, id);
    }
    this.bump(id);
    const row = this.objectById(id);
    return { objectId: id, mass: row?.mass ?? 0 };
  }

  recordAtom(input: {
    experienceId?: string;
    who?: string;
    verb: string;
    objectKeys?: { type: string; key: string }[];
    when?: string;
    product?: string;
    taskId?: string;
    resultJson?: string;
    evidence?: string;
  }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO atom (id, experience_id, who, verb, at, product, task_id, result_json, evidence, created_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.experienceId ?? null, input.who ?? null, input.verb, input.when ?? null,
      input.product ?? null, input.taskId ?? null, input.resultJson ?? null, input.evidence ?? null,
      new Date().toISOString());
    for (const ref of input.objectKeys ?? []) {
      const upserted = this.upsertObject(ref);
      this.db.prepare('INSERT OR IGNORE INTO atom_object (atom_id, object_id) VALUES (?, ?)').run(id, upserted.objectId);
    }
    return { atomId: id };
  }

  recall(query: string, objectKeys: { type: string; key: string }[], limit: number) {
    const now = new Date();
    const objects = this.db.prepare('SELECT id, type, key, name FROM object').all() as {
      id: string; type: string; key: string; name: string;
    }[];
    const needle = query.toLowerCase();
    const matched: ObjectRow[] = [];
    for (const object of objects) {
      const mass = this.readMass(object.id, now);
      const named = object.name.toLowerCase().includes(needle) || object.key.toLowerCase().includes(needle);
      const hinted = objectKeys.some((item) => item.type === object.type && item.key === object.key);
      if ((needle && named) || hinted) {
        matched.push({ ...object, mass });
      }
    }
    matched.sort((left, right) => right.mass - left.mass);
    const kept = matched.slice(0, limit);
    const ids = new Set(kept.map((item) => item.id));
    const atoms: AtomRow[] = [];
    if (ids.size > 0) {
      const rows = this.db.prepare(`
        SELECT a.id, a.verb, a.who, a.at, a.evidence, o.type, o.key
        FROM atom a
        JOIN atom_object link ON link.atom_id = a.id
        JOIN object o ON o.id = link.object_id
      `).all() as { id: string; verb: string; who: string | null; at: string | null; evidence: string | null; type: string; key: string }[];
      const grouped = new Map<string, AtomRow>();
      for (const row of rows) {
        const object = objects.find((item) => item.type === row.type && item.key === row.key);
        if (!object || !ids.has(object.id)) continue;
        const current = grouped.get(row.id) ?? { id: row.id, verb: row.verb, who: row.who, at: row.at, evidence: row.evidence, objectKeys: [] };
        current.objectKeys.push({ type: row.type, key: row.key });
        grouped.set(row.id, current);
      }
      atoms.push(...grouped.values());
    }
    return { objects: kept, atoms };
  }

  private bump(objectId: string) {
    const now = new Date().toISOString();
    const current = this.db.prepare('SELECT value, last_ref_on FROM mass WHERE object_id = ?').get(objectId) as
      | { value: number; last_ref_on: string }
      | undefined;
    const value = (current?.value ?? 0) + 1;
    this.db.prepare(`
      INSERT INTO mass (object_id, value, last_ref_on) VALUES (?, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET value = excluded.value, last_ref_on = excluded.last_ref_on
    `).run(objectId, value, now);
  }

  private readMass(objectId: string, now: Date) {
    const current = this.db.prepare('SELECT value, last_ref_on FROM mass WHERE object_id = ?').get(objectId) as
      | { value: number; last_ref_on: string }
      | undefined;
    if (!current) return 0;
    const value = decayedMass(current.value, current.last_ref_on, now);
    this.db.prepare('UPDATE mass SET value = ?, last_ref_on = ? WHERE object_id = ?').run(value, now.toISOString(), objectId);
    return value;
  }

  private objectById(id: string) {
    const row = this.db.prepare('SELECT id, type, key, name FROM object WHERE id = ?').get(id) as
      | { id: string; type: string; key: string; name: string }
      | undefined;
    if (!row) return undefined;
    const mass = this.db.prepare('SELECT value FROM mass WHERE object_id = ?').get(id) as { value: number } | undefined;
    return { ...row, mass: mass?.value ?? 0 };
  }
}
