import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Querier } from "./db";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "ids are kebab-case");
const email = z.string().email();

const RouteeSchema = z.object({ id, name: z.string().min(1), email, description: z.string().min(1) });
const CategorySchema = z.object({ id, description: z.string().min(1), route: id.nullable() });

export const OfficeConfigSchema = z.object({
  version: z.literal(1),
  office: z.object({ name: z.string().min(1), mailbox: email }),
  routees: z.array(RouteeSchema).min(1),
  categories: z.array(CategorySchema).default([]),
  review: z.object({ recipient: email }),
  llm: z.object({
    model: z.string().regex(/^[a-z0-9_]+:.+$/i, "llm.model must be a provider:model string"),
    apiKeyEnv: z.string().min(1),
  }),
  mining: z.object({ months: z.number().int().min(1).max(24).default(6), maxThreads: z.number().int().min(100).max(50000).default(5000) }).default({}),
});

export type Routee = z.infer<typeof RouteeSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type OfficeConfig = z.infer<typeof OfficeConfigSchema>;

const BUILTIN_JUNK: Category = { id: "junk", description: "Newsletters, marketing, spam, out-of-office and automated notices needing no action", route: null };

export function parseOfficeConfig(value: unknown): OfficeConfig {
  const cfg = OfficeConfigSchema.parse(value);
  if (!cfg.categories.some((c) => c.id === "junk")) cfg.categories.push({ ...BUILTIN_JUNK });
  const ids = [...cfg.routees.map((r) => r.id), ...cfg.categories.map((c) => c.id)];
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ids in config: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(", ")}`);
  const routeeIds = new Set(cfg.routees.map((r) => r.id));
  for (const c of cfg.categories)
    if (c.route && !routeeIds.has(c.route)) throw new Error(`category "${c.id}" routes to unknown routee "${c.route}"`);
  return cfg;
}

export function loadOfficeConfig(path: string): OfficeConfig {
  return parseOfficeConfig(JSON.parse(readFileSync(path, "utf8")));
}

export interface Vocabulary {
  categoryIds: string[];
  labelFor(id: string): string;
  routeFor(id: string): string | null;
  describe(id: string): string;
}

export function deriveVocabulary(cfg: OfficeConfig): Vocabulary {
  const emailByRoutee = new Map(cfg.routees.map((r) => [r.id, r.email]));
  const desc = new Map<string, string>([
    ...cfg.routees.map((r): [string, string] => [r.id, r.description]),
    ...cfg.categories.map((c): [string, string] => [c.id, c.description]),
  ]);
  const route = new Map<string, string | null>([
    ...cfg.routees.map((r): [string, string | null] => [r.id, r.email]),
    ...cfg.categories.map((c): [string, string | null] => [c.id, c.route ? emailByRoutee.get(c.route)! : null]),
  ]);
  return {
    categoryIds: [...route.keys()],
    labelFor: (i) => `triage/${i}`,
    routeFor: (i) => { if (!route.has(i)) throw new Error(`unknown category: ${i}`); return route.get(i)!; },
    describe: (i) => desc.get(i) ?? "",
  };
}

export function assertVocabularyCompatible(prev: OfficeConfig, next: OfficeConfig): void {
  const nextIds = new Set(deriveVocabulary(next).categoryIds);
  for (const i of deriveVocabulary(prev).categoryIds)
    if (!nextIds.has(i)) throw new Error(`vocabulary lock: id "${i}" was removed or renamed; run an explicit migration instead`);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

export function configHash(cfg: OfficeConfig): string {
  const sortedRoutees = [...cfg.routees].sort((a, b) => a.id.localeCompare(b.id));
  const sortedCats = [...cfg.categories].sort((a, b) => a.id.localeCompare(b.id));
  const body = JSON.stringify(canonical({ ...cfg, routees: sortedRoutees, categories: sortedCats }));
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

// DB storage lands in Task 2 (needs migration); declared here so the interface is one place:
export async function getOfficeConfig(db: Querier): Promise<OfficeConfig | null> {
  const { rows } = await db.query(`select value from app_config where key = 'office_config'`);
  return rows.length ? parseOfficeConfig(rows[0].value) : null;
}

export async function setOfficeConfig(db: Querier, cfg: OfficeConfig): Promise<void> {
  const prev = await getOfficeConfig(db);
  if (prev) assertVocabularyCompatible(prev, cfg);
  await db.query(
    `insert into app_config (key, value) values ('office_config', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(cfg)]
  );
}
