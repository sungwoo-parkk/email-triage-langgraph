# M1 — Small-Office Triage: Config-Core Refactor + Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-tenant AGY triage service into the M1 product: any small office runs `npm run triage -- init` to connect a Gmail inbox, mine its history into rules + a personalized classifier, see its own accuracy in an HTML report, and deploy to shadow mode — per spec `docs/superpowers/specs/2026-08-07-small-office-triage-design.md`.

**Architecture:** The existing LangGraph pipeline (`rules → classify → decide → record → act`) stays; everything office-specific moves into `triage.config.json`, with the classifier prompt and zod output schema generated from config at runtime. New subsystems: history mining (gold forwards + silver LLM labels → purity-mined rules), a sent-mail observer (passive corrections → learned rules), an email-native review flow with daily digest, an onboarding eval with a self-contained HTML report, and the CLI that orchestrates onboarding.

**Tech Stack:** TypeScript (strict), Next.js, `@langchain/langgraph`, `langchain` (for `initChatModel` — provider-agnostic LLM), `googleapis`, `zod`, `pg` / `@electric-sql/pglite` (tests), Vitest, `node:util` `parseArgs` + `node:readline` for the CLI (no new CLI deps).

## Global Constraints

- **Fail toward humans, never fail-open.** Any classification failure routes to `needs_review`; a wrong automated action is the failure the design prevents.
- **Record-before-act is structural.** No code path may touch the mailbox before the decision row exists.
- **Vocabulary is verbatim-locked once written** (spec §5): config updates that remove or rename a category/routee id must throw unless explicitly migrated. Applied label names are `triage/<categoryId>`.
- **Forwards go only to routee emails or `review.recipient`** — enforced by the runtime zod schema and the config-derived routing map, never free-typed by the model.
- **Stages:** `shadow` = record only; `assisted` = apply categories + review-forwards (internal recipient only); `autonomous` = + routee forwards with context. Default `shadow`.
- **Model may only pick category ids.** Routing (label name, forward target) is config lookup — an intentional simplification from the AGY build where the model chose forward targets. Multi-task per email stays (one category per task).
- **Zero-credential tests:** `npx vitest run` and `npm run demo` must pass with no keys, no network (PGlite + injected fakes).
- **Office LLM via `initChatModel(cfg.llm.model)`** (`provider:model` string); the office's key comes from `cfg.llm.apiKeyEnv`.
- Mining defaults (spec §4): 6 months / 5,000 threads cap; purity thresholds — domain ≥0.9 support ≥10, exact ≥0.95 support ≥5 (LLM tier); gold tier support floor halves (domain ≥5, exact ≥3). Holdout: 20% of labeled threads, min 30, cap 200, gold-preferred, excluded from mining. Eval floor 70%; strong category = F1 ≥ 0.86 with support ≥ 5.
- `phase0/data/` and `phase0/analysis/` contain insured PII and stay gitignored.
- All new code in `src/`; tests in `tests/` mirroring module names; run with `npx vitest run`.
- Existing case-study behavior that tests pin (e.g. `Cancelllation` spelling) moves with the AGY artifacts to `examples/agency/` — the tests change owners, they don't disappear.

## File Structure (target)

```
triage.config.json            # per-office, created by init (examples/ has two)
examples/hartley/             # simple example office: config + synthetic history fixtures
examples/agency/                 # case-study office: config capturing the AGY taxonomy
src/lib/officeConfig.ts       # config schema, vocabulary derivation, lock, hash, DB store
src/lib/mail/types.ts         # MailClient + ThreadSnapshot (moves from gmail.ts/normalize.ts)
src/lib/mail/gmail.ts         # Gmail MailClient (refactor of src/lib/gmail.ts)
src/lib/mail/fake.ts          # FakeMailClient for tests/demo/integration
src/lib/forwardDetect.ts      # gold ground truth from sent-mail forwards
src/lib/mining.ts             # sampling, silver labeling, holdout, purity mining, seeding
src/lib/promptgen.ts          # system prompt + few-shot exemplars from config/history
src/lib/classify.ts           # (refactor) runtime schema + initChatModel classifier
src/lib/decide.ts             # (refactor) category-id tasks -> label/forward actions via config
src/lib/act.ts                # (refactor) stage gating incl. review-forwards; context bodies
src/lib/review.ts             # context-body + digest composition
src/lib/observer.ts           # sent-mail observer: corrections + learned-rule promotion
src/lib/onboardEval.ts        # holdout eval, strong-category seeding
src/lib/report.ts             # self-contained triage-report.html
src/cli/main.ts               # triage init / status / promote / pause
src/cli/steps/*.ts            # one file per init step
src/app/api/cron/digest/route.ts
migrations/004_product.sql
docs/case-study/              # relocated AGY spec + results
```

---

### Task 1: Office config module and example configs

**Files:**
- Create: `src/lib/officeConfig.ts`, `examples/hartley/triage.config.json`, `examples/agency/triage.config.json`
- Test: `tests/officeConfig.test.ts`

**Interfaces:**
- Consumes: nothing (pure module + zod).
- Produces (used by every later task):
  - `interface Routee { id: string; name: string; email: string; description: string }`
  - `interface Category { id: string; description: string; route: string | null }` (`route` = routee id)
  - `interface OfficeConfig { version: 1; office: { name: string; mailbox: string }; routees: Routee[]; categories: Category[]; review: { recipient: string }; llm: { model: string; apiKeyEnv: string }; mining: { months: number; maxThreads: number } }`
  - `parseOfficeConfig(value: unknown): OfficeConfig` (validates; injects builtin `junk` category if absent)
  - `loadOfficeConfig(path: string): OfficeConfig`
  - `interface Vocabulary { categoryIds: string[]; labelFor(id: string): string; routeFor(id: string): string | null; describe(id: string): string }`
  - `deriveVocabulary(cfg: OfficeConfig): Vocabulary` — every routee is a category (`routeFor` = its email); extra categories route to their routee's email or null; label = `triage/<id>`
  - `assertVocabularyCompatible(prev: OfficeConfig, next: OfficeConfig): void` — throws if any category/routee id present in `prev` is missing in `next`
  - `configHash(cfg: OfficeConfig): string` — 12-hex sha256 of canonical JSON

- [ ] **Step 1: Write the failing test**

Create `tests/officeConfig.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseOfficeConfig, loadOfficeConfig, deriveVocabulary, assertVocabularyCompatible, configHash } from "@/lib/officeConfig";

const base = {
  version: 1,
  office: { name: "Hartley & Sons", mailbox: "info@hartleysons.example" },
  routees: [
    { id: "jo", name: "Jo Hartley", email: "jo@hartleysons.example", description: "Billing, invoices, refunds" },
    { id: "sales", name: "Sales desk", email: "sales@hartleysons.example", description: "Quotes, new orders" },
  ],
  categories: [],
  review: { recipient: "jo@hartleysons.example" },
  llm: { model: "anthropic:claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
  mining: { months: 6, maxThreads: 5000 },
};

describe("parseOfficeConfig", () => {
  it("accepts a valid config and injects the builtin junk category", () => {
    const cfg = parseOfficeConfig(base);
    expect(cfg.categories.some((c) => c.id === "junk")).toBe(true);
  });
  it("rejects duplicate ids across routees and categories", () => {
    expect(() => parseOfficeConfig({ ...base, categories: [{ id: "jo", description: "dupe", route: null }] })).toThrow(/duplicate/i);
  });
  it("rejects an llm model without a provider prefix", () => {
    expect(() => parseOfficeConfig({ ...base, llm: { model: "gpt-4o", apiKeyEnv: "X" } })).toThrow(/provider:model/i);
  });
  it("rejects a category routing to an unknown routee", () => {
    expect(() => parseOfficeConfig({ ...base, categories: [{ id: "legal", description: "x", route: "nobody" }] })).toThrow(/unknown routee/i);
  });
});

describe("deriveVocabulary", () => {
  const vocab = deriveVocabulary(parseOfficeConfig(base));
  it("makes every routee a category plus builtins", () => {
    expect(vocab.categoryIds.sort()).toEqual(["jo", "junk", "sales"]);
  });
  it("namespaces label names", () => {
    expect(vocab.labelFor("jo")).toBe("triage/jo");
  });
  it("routes routee categories to their email and junk to null", () => {
    expect(vocab.routeFor("sales")).toBe("sales@hartleysons.example");
    expect(vocab.routeFor("junk")).toBeNull();
  });
});

describe("vocabulary lock and hash", () => {
  it("throws when an id disappears", () => {
    const next = { ...base, routees: base.routees.slice(0, 1) };
    expect(() => assertVocabularyCompatible(parseOfficeConfig(base), parseOfficeConfig(next))).toThrow(/sales/);
  });
  it("allows additions and is order-insensitive for hashing", () => {
    const reordered = { ...base, routees: [...base.routees].reverse() };
    expect(configHash(parseOfficeConfig(base))).toBe(configHash(parseOfficeConfig(reordered)));
  });
});

describe("example configs", () => {
  it("both example office configs parse", () => {
    expect(() => loadOfficeConfig("examples/hartley/triage.config.json")).not.toThrow();
    expect(() => loadOfficeConfig("examples/agency/triage.config.json")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/officeConfig.test.ts` — Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

Create `src/lib/officeConfig.ts`:

```ts
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
```

- [ ] **Step 4: Create the example configs**

Create `examples/hartley/triage.config.json`:

```json
{
  "version": 1,
  "office": { "name": "Hartley & Sons", "mailbox": "info@hartleysons.example" },
  "routees": [
    { "id": "jo", "name": "Jo Hartley", "email": "jo@hartleysons.example", "description": "Billing, invoices, payment and refund questions" },
    { "id": "sales", "name": "Sales desk", "email": "sales@hartleysons.example", "description": "Quotes, new orders, product availability" },
    { "id": "support", "name": "Support", "email": "support@hartleysons.example", "description": "Order status, returns, product problems, complaints" }
  ],
  "categories": [],
  "review": { "recipient": "jo@hartleysons.example" },
  "llm": { "model": "google_genai:gemini-3.6-flash", "apiKeyEnv": "GEMINI_API_KEY" },
  "mining": { "months": 6, "maxThreads": 5000 }
}
```

Create `examples/agency/triage.config.json` (the case-study taxonomy expressed in the product's model — desk aliases as routees, core queue families as categories):

```json
{
  "version": 1,
  "office": { "name": "Case-Study Agency", "mailbox": "pro@agency.example" },
  "routees": [
    { "id": "invoice-desk", "name": "Invoice desk", "email": "invoice@agency.example", "description": "Carrier invoices, commission and account-current statements" },
    { "id": "accounting-desk", "name": "Accounting desk", "email": "accounting@agency.example", "description": "Broker/insured payment matters, refunds, payment plans" },
    { "id": "express-desk", "name": "Express desk", "email": "express@agency.example", "description": "NHO homeowners endorsements and quotes" }
  ],
  "categories": [
    { "id": "carrier-docs", "description": "Machine-generated carrier document deliveries for filing (policy prints, dec pages, audit statements)", "route": null },
    { "id": "carrier-cancellation", "description": "Carrier-issued cancellation notice, warning, or endorsement (misspelled 'Cancelllation' in the historical Gmail labels)", "route": null },
    { "id": "cancel-request", "description": "Retail broker asks to cancel a policy, usually with a signed LPR/ACORD", "route": null },
    { "id": "loss-run-request", "description": "Broker requests loss runs / claims history", "route": null },
    { "id": "wc-certificate", "description": "NY Workers Comp C-105.2 / wall poster / WC certificate requests", "route": null },
    { "id": "policy-doc-request", "description": "Broker asks for a copy of an existing document (dec page, full policy, binder)", "route": null },
    { "id": "commercial-endorsement", "description": "Broker asks to change a commercial policy (mortgagee, address, AI, limits, payment plan)", "route": null },
    { "id": "nho-endorsement", "description": "Homeowners-book endorsement", "route": "express-desk" },
    { "id": "recommendation", "description": "Loss-control recommendation compliance: premises photos, signed rec letters, enforcement replies", "route": null },
    { "id": "usli-renewal-quote", "description": "USLI renewal quote deliveries and reminders", "route": null },
    { "id": "carrier-invoice", "description": "Carrier invoices and statements", "route": "invoice-desk" },
    { "id": "payment-matter", "description": "Broker or insured payment matters", "route": "accounting-desk" },
    { "id": "front-office", "description": "Front-office judgment work: new business quoting, underwriter correspondence", "route": null },
    { "id": "undelivered", "description": "Bounces/NDRs of the agency's own outbound notices", "route": null }
  ],
  "review": { "recipient": "pro@agency.example" },
  "llm": { "model": "google_genai:gemini-3.6-flash", "apiKeyEnv": "GEMINI_API_KEY" },
  "mining": { "months": 6, "maxThreads": 5000 }
}
```

- [ ] **Step 5: Run tests to verify they pass, commit**

Run: `npx vitest run tests/officeConfig.test.ts` — Expected: PASS (10 tests). (The example-config test exercises `loadOfficeConfig` against both files.)

```bash
git add src/lib/officeConfig.ts examples/ tests/officeConfig.test.ts
git commit -m "feat: office config schema, vocabulary derivation, lock, and example offices"
```

---

### Task 2: Migration 004 — corrections, exemplars, config storage plumbing

**Files:**
- Create: `migrations/004_product.sql`
- Test: `tests/officeStore.test.ts`

**Interfaces:**
- Consumes: `Querier`/`getDb`/`setDb` (existing `src/lib/db.ts`), `runMigrations` (existing), `getOfficeConfig`/`setOfficeConfig` (Task 1).
- Produces: tables `corrections(id, thread_id, decision_id?, category_id, observed_from, sent_message_id?, created_at)`, `exemplars(id, category_id, from_addr, subject, body_excerpt, tier, created_at)`; `decisions.config_hash text` column; `ingest_state` row `id=2` (sent-mail checkpoint). Later tasks rely on these exact table/column names.

- [ ] **Step 1: Write the failing test**

Create `tests/officeStore.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { getOfficeConfig, setOfficeConfig, loadOfficeConfig } from "@/lib/officeConfig";

function pgliteAdapter(p: PGlite): Querier {
  return {
    query: async (sql, params) => {
      if (!params || params.length === 0) {
        const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT") || t.startsWith("ALTER")) { await p.exec(sql); return { rows: [] }; }
      }
      return p.query(sql, params as any[]) as any;
    },
  };
}

describe("migration 004", () => {
  beforeAll(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("creates corrections and exemplars and the sent checkpoint row", async () => {
    const { rows } = await getDb().query(
      `select table_name from information_schema.tables where table_schema='public'`);
    const names = rows.map((r: any) => r.table_name);
    expect(names).toContain("corrections");
    expect(names).toContain("exemplars");
    const cp = await getDb().query(`select checkpoint_ms from ingest_state where id = 2`);
    expect(cp.rows.length).toBe(1);
  });

  it("decisions has config_hash", async () => {
    const { rows } = await getDb().query(
      `select column_name from information_schema.columns where table_name='decisions'`);
    expect(rows.map((r: any) => r.column_name)).toContain("config_hash");
  });

  it("round-trips the office config and enforces the vocabulary lock", async () => {
    const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
    await setOfficeConfig(getDb(), cfg);
    const back = await getOfficeConfig(getDb());
    expect(back?.office.name).toBe("Hartley & Sons");
    const shrunk = { ...cfg, routees: cfg.routees.slice(0, 1) };
    await expect(setOfficeConfig(getDb(), shrunk as any)).rejects.toThrow(/vocabulary lock/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/officeStore.test.ts` — Expected: FAIL (tables missing).

- [ ] **Step 3: Implement the migration**

Create `migrations/004_product.sql`:

```sql
create table if not exists corrections (
  id bigint generated always as identity primary key,
  thread_id text not null,
  decision_id bigint references decisions(id),
  category_id text not null,
  observed_from text not null default 'sent-forward',
  sent_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists corrections_thread_idx on corrections(thread_id);

create table if not exists exemplars (
  id bigint generated always as identity primary key,
  category_id text not null,
  from_addr text not null default '',
  subject text not null default '',
  body_excerpt text not null default '',
  tier text not null check (tier in ('gold','llm')),
  created_at timestamptz not null default now()
);

alter table decisions add column if not exists config_hash text;

insert into ingest_state (id, checkpoint_ms) values (2, 0) on conflict do nothing;
```

Note: the PGlite adapter in the test routes no-param `ALTER` through `exec` — the existing adapters in `tests/db.test.ts` and `scripts/demo.ts` only special-case `CREATE`/`INSERT`; update both to include `ALTER` (same one-line change in each).

- [ ] **Step 4: Run tests to verify they pass — including the whole suite**

Run: `npx vitest run tests/officeStore.test.ts` — Expected: PASS (3 tests).
Run: `npx vitest run` — Expected: ALL PASS (migration 004 must not break existing schema tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/004_product.sql tests/officeStore.test.ts tests/db.test.ts scripts/demo.ts
git commit -m "feat: corrections/exemplars tables, config_hash, sent-mail checkpoint"
```

---

### Task 3: MailClient interface, snapshot extension, Gmail refactor, fake client

**Files:**
- Create: `src/lib/mail/types.ts`, `src/lib/mail/fake.ts`
- Create: `src/lib/mail/gmail.ts` (refactor-move of `src/lib/gmail.ts`; delete the old file)
- Modify: `src/lib/normalize.ts` (snapshot gains `to`, `references`), `src/lib/act.ts` + `src/graph/triage.ts` + `src/app/api/cron/*` + `scripts/probe-gmail.ts` (imports/renames)
- Test: `tests/mailclient.test.ts` (contract suite, run against the fake), `tests/gmail.test.ts` (pure-helper tests updated in place)

**Interfaces:**
- Consumes: `ThreadSnapshot`/`normalize` (existing).
- Produces (frozen for M2's Graph implementation):
  - `ThreadSnapshot` gains `to: string[]` and `references: string[]` (both default `[]`); `NormalizedEmail` passes them through unchanged.
  - `interface MailClient { listNewThreads(sinceMs: number, opts?: { sent?: boolean }): Promise<ThreadSnapshot[]>; listHistory(opts: { months: number; maxThreads: number; sent?: boolean }): AsyncIterable<ThreadSnapshot>; ensureCategories(names: string[]): Promise<void>; applyCategories(threadId: string, names: string[]): Promise<void>; forward(threadId: string, to: string, contextBody: string): Promise<void>; sendMessage(to: string, subject: string, body: string): Promise<void> }`
  - `makeGmail(api?): MailClient` — same auth logic as today (OAuth primary, SA/DWD alternative).
  - `makeFakeMail(seed?: { inbox?: ThreadSnapshot[]; sent?: ThreadSnapshot[] }): MailClient & { log: string[]; labels: Map<string, string[]> }` — records every action; used by demo, integration tests, and the CLI's `--dry-run`.
  - `runContractTests(name: string, make: () => MailClient & { log: string[] })` — shared vitest suite exported from `tests/mailclient.test.ts` so M2's Graph client runs the identical assertions.

- [ ] **Step 1: Write the failing contract test**

Create `tests/mailclient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeFakeMail } from "@/lib/mail/fake";
import type { MailClient, ThreadSnapshot } from "@/lib/mail/types";

function snap(threadId: string, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { threadId, from: "a@b.example", to: [], subject: "s", listId: null,
    attachments: [], bodyText: "b", internalDateMs: 1000, references: [], ...over };
}

export function runContractTests(name: string, make: () => MailClient & { log: string[] }) {
  describe(`MailClient contract: ${name}`, () => {
    it("listHistory yields sent mail only when sent=true", async () => {
      const m = make();
      const seen: string[] = [];
      for await (const t of m.listHistory({ months: 6, maxThreads: 100, sent: true })) seen.push(t.threadId);
      expect(seen.every((id) => id.startsWith("sent-"))).toBe(true);
    });
    it("applyCategories requires ensureCategories first (unknown category throws)", async () => {
      const m = make();
      await expect(m.applyCategories("t1", ["triage/jo"])).rejects.toThrow(/unknown/i);
      await m.ensureCategories(["triage/jo"]);
      await expect(m.applyCategories("t1", ["triage/jo"])).resolves.toBeUndefined();
    });
    it("forward includes the context body and records the action", async () => {
      const m = make();
      await m.forward("t1", "jo@x.example", "PROPOSED: jo (high) — invoice question");
      expect(m.log.some((l) => l.includes("forward") && l.includes("jo@x.example"))).toBe(true);
    });
  });
}

runContractTests("fake", () =>
  makeFakeMail({ inbox: [snap("in-1")], sent: [snap("sent-1", { to: ["jo@x.example"] })] })
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mailclient.test.ts` — Expected: FAIL (modules don't exist).

- [ ] **Step 3: Implement types, fake, and the normalize extension**

Create `src/lib/mail/types.ts`:

```ts
export interface ThreadSnapshot {
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  listId: string | null;
  attachments: string[];
  bodyText: string;
  internalDateMs: number;
  references: string[];
}

export interface MailClient {
  listNewThreads(sinceMs: number, opts?: { sent?: boolean }): Promise<ThreadSnapshot[]>;
  listHistory(opts: { months: number; maxThreads: number; sent?: boolean }): AsyncIterable<ThreadSnapshot>;
  ensureCategories(names: string[]): Promise<void>;
  applyCategories(threadId: string, names: string[]): Promise<void>;
  forward(threadId: string, to: string, contextBody: string): Promise<void>;
  sendMessage(to: string, subject: string, body: string): Promise<void>;
}
```

In `src/lib/normalize.ts`: re-export `ThreadSnapshot` from `./mail/types` (delete the local declaration); add `to` and `references` pass-through on `NormalizedEmail` with `?? []` defaults so all existing fixtures (which omit them) keep compiling — update the `ThreadSnapshot` fixture objects in existing tests by adding `to: [], references: []` only where TypeScript complains (strictness makes the compiler produce the exact list).

Create `src/lib/mail/fake.ts`:

```ts
import type { MailClient, ThreadSnapshot } from "./types";

export function makeFakeMail(seed: { inbox?: ThreadSnapshot[]; sent?: ThreadSnapshot[] } = {}) {
  const inbox = [...(seed.inbox ?? [])];
  const sent = [...(seed.sent ?? [])];
  const known = new Set<string>();
  const labels = new Map<string, string[]>();
  const log: string[] = [];

  const client: MailClient & { log: string[]; labels: Map<string, string[]>; pushInbox(t: ThreadSnapshot): void; pushSent(t: ThreadSnapshot): void } = {
    log, labels,
    pushInbox: (t) => inbox.push(t),
    pushSent: (t) => sent.push(t),
    async listNewThreads(sinceMs, opts) {
      return (opts?.sent ? sent : inbox).filter((t) => t.internalDateMs > sinceMs);
    },
    async *listHistory(opts) {
      const src = opts.sent ? sent : inbox;
      for (const t of src.slice(0, opts.maxThreads)) yield t;
    },
    async ensureCategories(names) { names.forEach((n) => known.add(n)); log.push(`ensure:${names.join(",")}`); },
    async applyCategories(threadId, names) {
      for (const n of names) if (!known.has(n)) throw new Error(`unknown category: ${n}`);
      labels.set(threadId, [...(labels.get(threadId) ?? []), ...names]);
      log.push(`categories:${threadId}:${[...names].sort().join("|")}`);
    },
    async forward(threadId, to, contextBody) { log.push(`forward:${threadId}:${to}:${contextBody.slice(0, 40)}`); },
    async sendMessage(to, subject) { log.push(`send:${to}:${subject}`); },
  };
  return client;
}
```

- [ ] **Step 4: Refactor the Gmail client onto the interface**

Move `src/lib/gmail.ts` to `src/lib/mail/gmail.ts` implementing `MailClient`:
- `applyLabels` → `applyCategories`; add `ensureCategories` using `users.labels.create` for names missing from the label map (catch 409/duplicate as success).
- `forward(threadId, to, contextBody)` — pass `contextBody` as the `comment` argument of the existing `buildForwardRaw` (replaces the hardcoded "Auto-forwarded by triage.").
- `sendAlert` → `sendMessage` (same MIME body).
- `listNewThreads(sinceMs, opts)` — when `opts?.sent`, query becomes `in:sent after:...` and the snapshot's `to`/`references` are read from the last message's headers (`To`, `References` split on whitespace); inbox path reads them from the first message.
- New `listHistory`: async generator paging `threads.list` with `q = after:<months ago> [in:sent]`, yielding snapshots, stopping at `maxThreads`.
- Update all importers (`act.ts`, `graph/triage.ts`, cron routes, `scripts/probe-gmail.ts`, `scripts/demo.ts`, existing tests) — mechanical rename `GmailClient` → `MailClient`, `applyLabels` → `applyCategories`, `sendAlert` → `sendMessage`. Existing act/triage/ingest tests keep passing with their fakes updated to the new interface shape.

- [ ] **Step 5: Run the full suite, commit**

Run: `npx vitest run` — Expected: ALL PASS (contract tests + migrated existing tests).

```bash
git add src/lib/mail/ src/lib/normalize.ts src/lib/act.ts src/graph/triage.ts src/app/api tests/ scripts/
git rm src/lib/gmail.ts
git commit -m "feat: MailClient interface with Gmail impl, fake client, contract tests"
```

---

### Task 4: Forward detection (gold ground truth)

**Files:**
- Create: `src/lib/forwardDetect.ts`
- Test: `tests/forwardDetect.test.ts`

**Interfaces:**
- Consumes: `ThreadSnapshot` (Task 3), `Routee` (Task 1), `extractAddr` (existing `src/lib/normalize.ts`).
- Produces (used by mining Task 5 and observer Task 8):
  - `interface GoldLabel { threadId: string; categoryId: string; evidence: "same-thread" | "subject-match"; sentMessageDateMs: number }`
  - `detectForwards(sent: ThreadSnapshot[], inbox: ThreadSnapshot[], routees: Routee[]): GoldLabel[]`
  - `subjectCore(s: string): string` — strips `Fwd:`/`FW:`/`Re:` chains and `[...]` prefixes (exported; observer reuses it)

Matching rules (in priority order, first match wins per inbox thread):
1. **same-thread**: a sent snapshot with the same `threadId` as an inbox thread whose `to` includes a routee email (Gmail keeps UI-forwards in the same thread).
2. **subject-match**: a sent snapshot addressed to a routee whose `subjectCore` equals an inbox thread's `subjectCore` and whose date is 0–14 days after the inbox thread's date.
A thread forwarded to multiple routees keeps the earliest forward only (the dispatcher's first decision).

- [ ] **Step 1: Write the failing test**

Create `tests/forwardDetect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectForwards, subjectCore } from "@/lib/forwardDetect";
import type { ThreadSnapshot } from "@/lib/mail/types";

const routees = [
  { id: "jo", name: "Jo", email: "jo@office.example", description: "billing" },
  { id: "sales", name: "Sales", email: "sales@office.example", description: "sales" },
];

function t(threadId: string, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { threadId, from: "cust@x.example", to: [], subject: "Invoice 42 overdue", listId: null,
    attachments: [], bodyText: "", internalDateMs: 1_000_000, references: [], ...over };
}

describe("subjectCore", () => {
  it("strips forward/reply chains and bracket prefixes", () => {
    expect(subjectCore("Fwd: FW: [EXTERNAL] Re: Invoice 42 overdue ")).toBe("Invoice 42 overdue");
  });
});

describe("detectForwards", () => {
  it("detects a same-thread forward to a routee", () => {
    const inbox = [t("t1")];
    const sent = [t("t1", { from: "info@office.example", to: ["jo@office.example"], internalDateMs: 1_100_000 })];
    expect(detectForwards(sent, inbox, routees)).toEqual([
      { threadId: "t1", categoryId: "jo", evidence: "same-thread", sentMessageDateMs: 1_100_000 },
    ]);
  });
  it("detects a cross-thread forward by subject within 14 days", () => {
    const inbox = [t("t2", { subject: "Need a quote for 40 chairs" })];
    const sent = [t("s9", { to: ["sales@office.example"], subject: "Fwd: Need a quote for 40 chairs",
      internalDateMs: 1_000_000 + 3 * 86_400_000 })];
    expect(detectForwards(sent, inbox, routees)[0]).toMatchObject({ threadId: "t2", categoryId: "sales", evidence: "subject-match" });
  });
  it("ignores forwards to non-routees and stale subject matches", () => {
    const inbox = [t("t3")];
    const sent = [
      t("t3", { to: ["friend@elsewhere.example"], internalDateMs: 1_100_000 }),
      t("s1", { to: ["jo@office.example"], subject: "Fwd: Invoice 42 overdue", internalDateMs: 1_000_000 + 20 * 86_400_000 }),
    ];
    expect(detectForwards(sent, inbox, routees)).toEqual([]);
  });
  it("keeps only the earliest forward per thread", () => {
    const inbox = [t("t4")];
    const sent = [
      t("t4", { to: ["sales@office.example"], internalDateMs: 1_300_000 }),
      t("t4", { to: ["jo@office.example"], internalDateMs: 1_200_000 }),
    ];
    const gold = detectForwards(sent, inbox, routees);
    expect(gold).toHaveLength(1);
    expect(gold[0].categoryId).toBe("jo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/forwardDetect.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/forwardDetect.ts`:

```ts
import type { ThreadSnapshot } from "./mail/types";
import type { Routee } from "./officeConfig";
import { extractAddr } from "./normalize";

export interface GoldLabel {
  threadId: string;
  categoryId: string;
  evidence: "same-thread" | "subject-match";
  sentMessageDateMs: number;
}

const FOURTEEN_DAYS = 14 * 86_400_000;

export function subjectCore(s: string): string {
  return s.replace(/^(\s*(\[[^\]]+\]|fwd?:|fw:|re:)\s*)+/i, "").trim();
}

export function detectForwards(sent: ThreadSnapshot[], inbox: ThreadSnapshot[], routees: Routee[]): GoldLabel[] {
  const routeeByEmail = new Map(routees.map((r) => [r.email.toLowerCase(), r.id]));
  const inboxById = new Map(inbox.map((t) => [t.threadId, t]));
  const inboxBySubject = new Map<string, ThreadSnapshot[]>();
  for (const t of inbox) {
    const key = subjectCore(t.subject).toLowerCase();
    if (key) (inboxBySubject.get(key) ?? inboxBySubject.set(key, []).get(key)!).push(t);
  }

  const best = new Map<string, GoldLabel>();
  const consider = (g: GoldLabel) => {
    const prev = best.get(g.threadId);
    if (!prev || g.sentMessageDateMs < prev.sentMessageDateMs) best.set(g.threadId, g);
  };

  for (const s of [...sent].sort((a, b) => a.internalDateMs - b.internalDateMs)) {
    const routeeId = s.to.map((a) => routeeByEmail.get(extractAddr(a))).find(Boolean);
    if (!routeeId) continue;

    const sameThread = inboxById.get(s.threadId);
    if (sameThread) {
      consider({ threadId: s.threadId, categoryId: routeeId, evidence: "same-thread", sentMessageDateMs: s.internalDateMs });
      continue;
    }
    const key = subjectCore(s.subject).toLowerCase();
    for (const orig of inboxBySubject.get(key) ?? []) {
      const delta = s.internalDateMs - orig.internalDateMs;
      if (delta >= 0 && delta <= FOURTEEN_DAYS)
        consider({ threadId: orig.threadId, categoryId: routeeId, evidence: "subject-match", sentMessageDateMs: s.internalDateMs });
    }
  }
  return [...best.values()];
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/forwardDetect.test.ts` — Expected: PASS (5 tests).

```bash
git add src/lib/forwardDetect.ts tests/forwardDetect.test.ts
git commit -m "feat: gold ground truth from sent-mail forward detection"
```

---

### Task 5: Mining — stratified sampling, silver labeling, holdout, purity mining, seeding

**Files:**
- Create: `src/lib/mining.ts`
- Test: `tests/mining.test.ts`

**Interfaces:**
- Consumes: `NormalizedEmail`/`normalize` (existing), `GoldLabel` (Task 4), `Vocabulary` (Task 1), `Querier` (existing), `Rule` shape of the `rules` table (existing Task-5-of-case-study `src/lib/rules.ts` — patterns now emit **category ids** in `label_set`).
- Produces (used by onboarding CLI Task 10 and eval Task 9):
  - `interface LabeledThread { email: NormalizedEmail; categoryIds: string[]; tier: "gold" | "llm" }`
  - `stratifiedSample(threads: NormalizedEmail[], max: number): NormalizedEmail[]` — round-robin over sender domains, each domain's list spread across the time window.
  - `labelWithLLM(classify: (e: NormalizedEmail) => Promise<{ tasks: { category: string }[] }>, threads: NormalizedEmail[], opts?: { concurrency?: number }): Promise<LabeledThread[]>` — failures skip-and-count (returned in `.failures`), never abort. Return type: `{ labeled: LabeledThread[]; failures: number }`.
  - `splitHoldout(labeled: LabeledThread[], opts?: { fraction?: number; min?: number; cap?: number }): { train: LabeledThread[]; holdout: LabeledThread[] }` — defaults 0.2/30/200; gold-preferred (holdout fills from gold first); deterministic (sorted by threadId, every 5th — no randomness, resumable).
  - `interface MinedRule { patternType: "sender_exact" | "sender_domain" | "list_id"; pattern: string; categoryIds: string[]; purity: number; support: number; tier: "mined-gold" | "mined-llm" }`
  - `minePatterns(train: LabeledThread[]): MinedRule[]` — thresholds per Global Constraints (gold tier: domain ≥0.9 purity/≥5 support, exact ≥0.95/≥3; llm tier: domain ≥0.9/≥10, exact ≥0.95/≥5; list_id treated like domain). A pattern with any gold support uses the gold tier.
  - `seedMinedRules(db: Querier, rules: MinedRule[]): Promise<number>` — inserts into `rules` with `source = tier`, `complete = true`, `on conflict do nothing`; returns inserted count.

- [ ] **Step 1: Write the failing test**

Create `tests/mining.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { normalize } from "@/lib/normalize";
import { stratifiedSample, labelWithLLM, splitHoldout, minePatterns, seedMinedRules, type LabeledThread } from "@/lib/mining";

function email(threadId: string, from: string, dateMs: number, subject = "s") {
  return normalize({ threadId, from, to: [], subject, listId: null, attachments: [], bodyText: "b", internalDateMs: dateMs, references: [] });
}
function labeled(threadId: string, from: string, categoryIds: string[], tier: "gold" | "llm"): LabeledThread {
  return { email: email(threadId, from, 1), categoryIds, tier };
}

describe("stratifiedSample", () => {
  it("caps per-domain dominance", () => {
    const noisy = Array.from({ length: 90 }, (_, i) => email(`n${i}`, "news@spam.example", i));
    const rare = Array.from({ length: 10 }, (_, i) => email(`r${i}`, `p${i}@rare${i}.example`, i));
    const sample = stratifiedSample([...noisy, ...rare], 20);
    const spam = sample.filter((e) => e.fromDomain === "spam.example").length;
    expect(sample).toHaveLength(20);
    expect(spam).toBeLessThan(15);
    expect(sample.filter((e) => e.fromDomain !== "spam.example").length).toBe(10);
  });
});

describe("labelWithLLM", () => {
  it("labels threads and skip-counts failures", async () => {
    const threads = [email("a", "x@y.example", 1), email("b", "boom@y.example", 2)];
    const { labeled: out, failures } = await labelWithLLM(async (e) => {
      if (e.fromAddr.startsWith("boom")) throw new Error("llm down");
      return { tasks: [{ category: "jo" }] };
    }, threads);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ categoryIds: ["jo"], tier: "llm" });
    expect(failures).toBe(1);
  });
});

describe("splitHoldout", () => {
  it("prefers gold, respects min, and excludes holdout from train", () => {
    const gold = Array.from({ length: 40 }, (_, i) => labeled(`g${i}`, "a@b.example", ["jo"], "gold"));
    const silver = Array.from({ length: 160 }, (_, i) => labeled(`s${i}`, "c@d.example", ["sales"], "llm"));
    const { train, holdout } = splitHoldout([...gold, ...silver]);
    expect(holdout).toHaveLength(40); // 20% of 200
    expect(holdout.filter((l) => l.tier === "gold").length).toBe(40); // gold-first fills it entirely
    const holdoutIds = new Set(holdout.map((l) => l.email.threadId));
    expect(train.every((l) => !holdoutIds.has(l.email.threadId))).toBe(true);
  });
  it("returns an empty holdout below the minimum", () => {
    const few = Array.from({ length: 20 }, (_, i) => labeled(`g${i}`, "a@b.example", ["jo"], "gold"));
    expect(splitHoldout(few).holdout).toHaveLength(0);
  });
});

describe("minePatterns", () => {
  it("applies tier thresholds", () => {
    const goldDomain = Array.from({ length: 6 }, (_, i) => labeled(`gd${i}`, `p${i}@carrier.example`, ["jo"], "gold"));
    const llmDomainThin = Array.from({ length: 6 }, (_, i) => labeled(`ld${i}`, `p${i}@thin.example`, ["sales"], "llm"));
    const llmDomainFat = Array.from({ length: 12 }, (_, i) => labeled(`lf${i}`, `p${i}@fat.example`, ["sales"], "llm"));
    const impure = [...Array.from({ length: 9 }, (_, i) => labeled(`i${i}`, `p${i}@mixed.example`, ["jo"], "llm")),
                    ...Array.from({ length: 6 }, (_, i) => labeled(`j${i}`, `q${i}@mixed.example`, ["sales"], "llm"))];
    const rules = minePatterns([...goldDomain, ...llmDomainThin, ...llmDomainFat, ...impure]);
    const patterns = rules.map((r) => r.pattern);
    expect(patterns).toContain("carrier.example");   // gold tier: support 6 >= 5
    expect(patterns).not.toContain("thin.example");   // llm tier: support 6 < 10
    expect(patterns).toContain("fat.example");        // llm tier: support 12 >= 10
    expect(patterns).not.toContain("mixed.example");  // purity 0.6 < 0.9
    expect(rules.find((r) => r.pattern === "carrier.example")?.tier).toBe("mined-gold");
  });
});

describe("seedMinedRules", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb({ query: async (sql, params) => {
      if (!params?.length) { const t = sql.trim().toUpperCase();
        if (t.startsWith("CREATE") || t.startsWith("INSERT") || t.startsWith("ALTER")) { await p.exec(sql); return { rows: [] }; } }
      return p.query(sql, params as any[]) as any;
    } });
    await runMigrations(getDb());
  });
  it("inserts and is idempotent", async () => {
    const rules = [{ patternType: "sender_domain" as const, pattern: "carrier.example", categoryIds: ["jo"], purity: 1, support: 6, tier: "mined-gold" as const }];
    expect(await seedMinedRules(getDb(), rules)).toBe(1);
    expect(await seedMinedRules(getDb(), rules)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mining.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/mining.ts`:

```ts
import type { Querier } from "./db";
import type { NormalizedEmail } from "./normalize";

export interface LabeledThread { email: NormalizedEmail; categoryIds: string[]; tier: "gold" | "llm" }

export function stratifiedSample(threads: NormalizedEmail[], max: number): NormalizedEmail[] {
  const byDomain = new Map<string, NormalizedEmail[]>();
  for (const t of threads) (byDomain.get(t.fromDomain) ?? byDomain.set(t.fromDomain, []).get(t.fromDomain)!).push(t);
  for (const list of byDomain.values()) list.sort((a, b) => a.internalDateMs - b.internalDateMs);
  // round-robin across domains; within a domain, take items spread across time (stride pick)
  const queues = [...byDomain.values()].map((list) => {
    const stride = Math.max(1, Math.floor(list.length / Math.ceil(max / byDomain.size)));
    return list.filter((_, i) => i % stride === 0);
  });
  const out: NormalizedEmail[] = [];
  let i = 0;
  while (out.length < max && queues.some((q) => q.length)) {
    const q = queues[i % queues.length];
    if (q.length) out.push(q.shift()!);
    i++;
  }
  return out;
}

export async function labelWithLLM(
  classify: (e: NormalizedEmail) => Promise<{ tasks: { category: string }[] }>,
  threads: NormalizedEmail[],
  opts: { concurrency?: number } = {}
): Promise<{ labeled: LabeledThread[]; failures: number }> {
  const concurrency = opts.concurrency ?? 4;
  const labeled: LabeledThread[] = [];
  let failures = 0;
  const queue = [...threads];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const c = await classify(t);
        const categoryIds = [...new Set(c.tasks.map((x) => x.category))];
        if (categoryIds.length) labeled.push({ email: t, categoryIds, tier: "llm" });
        else failures++;
      } catch { failures++; }
    }
  }));
  return { labeled, failures };
}

export function splitHoldout(
  labeled: LabeledThread[],
  opts: { fraction?: number; min?: number; cap?: number } = {}
): { train: LabeledThread[]; holdout: LabeledThread[] } {
  const { fraction = 0.2, min = 30, cap = 200 } = opts;
  const target = Math.min(cap, Math.floor(labeled.length * fraction));
  if (target < min) return { train: labeled, holdout: [] };
  const sorted = [...labeled].sort((a, b) =>
    a.tier === b.tier ? a.email.threadId.localeCompare(b.email.threadId) : a.tier === "gold" ? -1 : 1);
  const holdout = sorted.slice(0, target);
  const ids = new Set(holdout.map((l) => l.email.threadId));
  return { train: labeled.filter((l) => !ids.has(l.email.threadId)), holdout };
}

export interface MinedRule {
  patternType: "sender_exact" | "sender_domain" | "list_id";
  pattern: string;
  categoryIds: string[];
  purity: number;
  support: number;
  tier: "mined-gold" | "mined-llm";
}

const THRESHOLDS = {
  gold: { sender_domain: { purity: 0.9, support: 5 }, sender_exact: { purity: 0.95, support: 3 }, list_id: { purity: 0.9, support: 5 } },
  llm:  { sender_domain: { purity: 0.9, support: 10 }, sender_exact: { purity: 0.95, support: 5 }, list_id: { purity: 0.9, support: 10 } },
} as const;

export function minePatterns(train: LabeledThread[]): MinedRule[] {
  type Bucket = { total: number; gold: number; bySet: Map<string, number> };
  const buckets = new Map<string, Bucket>(); // key: `${patternType} ${pattern}`
  const add = (patternType: MinedRule["patternType"], pattern: string, l: LabeledThread) => {
    if (!pattern) return;
    const key = `${patternType} ${pattern.toLowerCase()}`;
    const b = buckets.get(key) ?? buckets.set(key, { total: 0, gold: 0, bySet: new Map() }).get(key)!;
    b.total++;
    if (l.tier === "gold") b.gold++;
    const set = [...l.categoryIds].sort().join("+");
    b.bySet.set(set, (b.bySet.get(set) ?? 0) + 1);
  };
  for (const l of train) {
    add("sender_exact", l.email.fromAddr, l);
    add("sender_domain", l.email.fromDomain, l);
    if (l.email.listId) add("list_id", l.email.listId, l);
  }
  const out: MinedRule[] = [];
  for (const [key, b] of buckets) {
    const [patternType, pattern] = key.split(" ") as [MinedRule["patternType"], string];
    const [topSet, topCount] = [...b.bySet.entries()].sort((a, z) => z[1] - a[1])[0];
    const purity = topCount / b.total;
    const tier = b.gold > 0 ? "mined-gold" : "mined-llm";
    const th = THRESHOLDS[tier === "mined-gold" ? "gold" : "llm"][patternType];
    if (purity >= th.purity && b.total >= th.support)
      out.push({ patternType, pattern, categoryIds: topSet.split("+"), purity, support: b.total, tier });
  }
  return out;
}

export async function seedMinedRules(db: Querier, rules: MinedRule[]): Promise<number> {
  let inserted = 0;
  for (const r of rules) {
    const res = await db.query(
      `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
       values ($1, $2, $3, true, $4, $5, $6)
       on conflict (pattern_type, pattern) do nothing returning id`,
      [r.patternType, r.pattern, JSON.stringify(r.categoryIds), r.purity, r.support, r.tier]
    );
    inserted += res.rows.length;
  }
  return inserted;
}
```

Note: the `rules.label_set` column now stores **category ids**; the rules engine (`matchRules`) is unchanged — it just returns ids, and Task 7's decide maps ids to labels/forwards via the vocabulary.

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/mining.test.ts` — Expected: PASS (7 tests).

```bash
git add src/lib/mining.ts tests/mining.test.ts
git commit -m "feat: history mining — stratified sampling, silver labeling, holdout, purity mining"
```

---

### Task 6: Prompt generation and the provider-agnostic runtime classifier

**Files:**
- Create: `src/lib/promptgen.ts`
- Modify: `src/lib/classify.ts` (full rewrite), `package.json` (add dependency `langchain`)
- Test: `tests/promptgen.test.ts`, `tests/classify.test.ts` (rewrite)

**Interfaces:**
- Consumes: `OfficeConfig`/`Vocabulary` (Task 1), `NormalizedEmail` (existing), `RuleOutcome` (existing `src/lib/rules.ts`), `exemplars` table shape (Task 2).
- Produces (used by decide Task 7, mining Task 5 via the classify fn, eval Task 9, CLI Task 10):
  - `interface Exemplar { categoryId: string; fromAddr: string; subject: string; bodyExcerpt: string; tier: "gold" | "llm" }`
  - `buildSystemPrompt(cfg: OfficeConfig, exemplars: Exemplar[]): string` — office context, category catalog from `describe()`, confidence rubric ("high only when a typical dispatcher would certainly agree"), one exemplar block per category (max 2 each).
  - `pickExemplars(labeled: LabeledThread[], perCategory?: number): Exemplar[]` — gold first, single-category threads only.
  - `makeClassificationSchema(cfg: OfficeConfig)` — zod: `{ tasks: [{ category: <enum of category ids> }] (min 1), confidence: high|medium|low, rationale: string }`.
  - `type Classification = { tasks: { category: string }[]; confidence: "high" | "medium" | "low"; rationale: string }`
  - `interface ClassifierModel { invoke(messages: [string, string][]): Promise<unknown> }`
  - `makeClassifier(cfg: OfficeConfig, exemplars: Exemplar[], model?: ClassifierModel): (email: NormalizedEmail, rules: RuleOutcome) => Promise<Classification>` — default model: `await initChatModel(cfg.llm.model)` (from `langchain/chat_models/universal`) with the key read from `process.env[cfg.llm.apiKeyEnv]`, wrapped in `withStructuredOutput(schema)`; one retry then throw (caller routes to review).
  - Provider install map (used by the CLI): `openai → @langchain/openai`, `anthropic → @langchain/anthropic`, `google_genai → @langchain/google-genai`, `mistralai → @langchain/mistralai`, `groq → @langchain/groq`, `ollama → @langchain/ollama` — exported as `PROVIDER_PACKAGES: Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/promptgen.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadOfficeConfig } from "@/lib/officeConfig";
import { buildSystemPrompt, pickExemplars, PROVIDER_PACKAGES } from "@/lib/promptgen";
import { normalize } from "@/lib/normalize";

const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
const labeled = (id: string, cat: string, tier: "gold" | "llm") => ({
  email: normalize({ threadId: id, from: `c${id}@x.example`, to: [], subject: `subj-${id}`, listId: null,
    attachments: [], bodyText: `body-${id}`, internalDateMs: 1, references: [] }),
  categoryIds: [cat], tier,
});

describe("buildSystemPrompt", () => {
  it("includes every category id with its description and the confidence rubric", () => {
    const p = buildSystemPrompt(cfg, []);
    for (const id of ["jo", "sales", "support", "junk"]) expect(p).toContain(`"${id}"`);
    expect(p).toContain("Billing, invoices");
    expect(p).toMatch(/high.*certainly agree/i);
  });
  it("includes exemplars under their category", () => {
    const p = buildSystemPrompt(cfg, pickExemplars([labeled("1", "sales", "gold")]));
    expect(p).toContain("subj-1");
  });
});

describe("pickExemplars", () => {
  it("prefers gold and caps per category", () => {
    const pool = [labeled("g1", "jo", "gold"), labeled("l1", "jo", "llm"), labeled("l2", "jo", "llm"), labeled("l3", "jo", "llm")];
    const ex = pickExemplars(pool, 2);
    expect(ex).toHaveLength(2);
    expect(ex[0].tier).toBe("gold");
  });
});

describe("PROVIDER_PACKAGES", () => {
  it("maps the supported providers", () => {
    expect(PROVIDER_PACKAGES["anthropic"]).toBe("@langchain/anthropic");
    expect(PROVIDER_PACKAGES["google_genai"]).toBe("@langchain/google-genai");
  });
});
```

Rewrite `tests/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadOfficeConfig } from "@/lib/officeConfig";
import { makeClassifier, makeClassificationSchema } from "@/lib/classify";
import { normalize } from "@/lib/normalize";

const cfg = loadOfficeConfig("examples/hartley/triage.config.json");
const email = normalize({ threadId: "t", from: "cust@x.example", to: [], subject: "invoice overdue",
  listId: null, attachments: [], bodyText: "please fix my invoice", internalDateMs: 0, references: [] });
const noRules = { hits: [], labels: [], forwards: [], complete: false };

describe("runtime classification schema", () => {
  const schema = makeClassificationSchema(cfg);
  it("accepts category ids from the office vocabulary", () => {
    expect(() => schema.parse({ tasks: [{ category: "jo" }], confidence: "high", rationale: "" })).not.toThrow();
  });
  it("rejects ids outside the vocabulary", () => {
    expect(() => schema.parse({ tasks: [{ category: "ceo" }], confidence: "high", rationale: "" })).toThrow();
  });
});

describe("makeClassifier", () => {
  it("returns schema-valid output from the model", async () => {
    const fake = { invoke: async () => ({ tasks: [{ category: "jo" }], confidence: "high", rationale: "billing" }) };
    const c = await makeClassifier(cfg, [], fake)(email, noRules);
    expect(c.tasks[0].category).toBe("jo");
  });
  it("retries once, then throws", async () => {
    let calls = 0;
    const flaky = { invoke: async () => { calls++; throw new Error("boom"); } };
    await expect(makeClassifier(cfg, [], flaky)(email, noRules)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
  it("passes rule evidence into the human message", async () => {
    let seen = "";
    const spy = { invoke: async (m: [string, string][]) => { seen = m[1][1]; return { tasks: [{ category: "jo" }], confidence: "high", rationale: "" }; } };
    await makeClassifier(cfg, [], spy)(email, { hits: [{} as any], labels: ["jo"], forwards: [], complete: false });
    expect(seen).toContain("rules already suggest");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/promptgen.test.ts tests/classify.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement promptgen**

Run `npm i langchain` first. Create `src/lib/promptgen.ts`:

```ts
import type { OfficeConfig } from "./officeConfig";
import { deriveVocabulary } from "./officeConfig";
import type { LabeledThread } from "./mining";

export interface Exemplar { categoryId: string; fromAddr: string; subject: string; bodyExcerpt: string; tier: "gold" | "llm" }

export const PROVIDER_PACKAGES: Record<string, string> = {
  openai: "@langchain/openai",
  anthropic: "@langchain/anthropic",
  google_genai: "@langchain/google-genai",
  mistralai: "@langchain/mistralai",
  groq: "@langchain/groq",
  ollama: "@langchain/ollama",
};

export function pickExemplars(labeled: LabeledThread[], perCategory = 2): Exemplar[] {
  const byCat = new Map<string, Exemplar[]>();
  const sorted = [...labeled].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "gold" ? -1 : 1));
  for (const l of sorted) {
    if (l.categoryIds.length !== 1) continue; // unambiguous exemplars only
    const cat = l.categoryIds[0];
    const list = byCat.get(cat) ?? byCat.set(cat, []).get(cat)!;
    if (list.length < perCategory)
      list.push({ categoryId: cat, fromAddr: l.email.fromAddr, subject: l.email.subject,
        bodyExcerpt: l.email.bodyExcerpt.slice(0, 300), tier: l.tier });
  }
  return [...byCat.values()].flat();
}

export function buildSystemPrompt(cfg: OfficeConfig, exemplars: Exemplar[]): string {
  const vocab = deriveVocabulary(cfg);
  const catalog = vocab.categoryIds
    .map((id) => `- "${id}": ${vocab.describe(id)}`)
    .join("\n");
  const examples = exemplars.length
    ? "\n\nEXAMPLES from this office's own mail:\n" + exemplars
        .map((e) => `[${e.categoryId}] From: ${e.fromAddr} | Subject: ${e.subject}\n${e.bodyExcerpt}`)
        .join("\n---\n")
    : "";
  return `You triage inbound email for ${cfg.office.name} (${cfg.office.mailbox}).
Assign every email one task per distinct request, each task naming exactly one category id.

Categories:
${catalog}

Confidence: "high" only when a typical dispatcher at this office would certainly agree;
"medium" when plausible alternatives exist; "low" when genuinely unsure. Uncertain mail is
reviewed by a human - prefer honest "medium"/"low" over guessed "high".${examples}`;
}

export function emailPrompt(e: { fromAddr: string; subject: string; listId: string | null; attachments: string[]; bodyExcerpt: string },
  ruleEvidence: { labels: string[] }): string {
  return [
    `From: ${e.fromAddr}`, `Subject: ${e.subject}`, `List-Id: ${e.listId ?? "(none)"}`,
    `Attachments: ${e.attachments.join(", ") || "(none)"}`,
    ruleEvidence.labels.length ? `Deterministic rules already suggest: ${ruleEvidence.labels.join(", ")}` : "",
    ``, `Body:`, e.bodyExcerpt || "(empty)",
  ].filter(Boolean).join("\n");
}
```

- [ ] **Step 4: Rewrite the classifier**

Rewrite `src/lib/classify.ts`:

```ts
import { z } from "zod";
import type { OfficeConfig } from "./officeConfig";
import { deriveVocabulary } from "./officeConfig";
import type { NormalizedEmail } from "./normalize";
import type { RuleOutcome } from "./rules";
import { buildSystemPrompt, emailPrompt, type Exemplar } from "./promptgen";

export function makeClassificationSchema(cfg: OfficeConfig) {
  const ids = deriveVocabulary(cfg).categoryIds as [string, ...string[]];
  return z.object({
    tasks: z.array(z.object({ category: z.enum(ids) })).min(1),
    confidence: z.enum(["high", "medium", "low"]),
    rationale: z.string(),
  });
}
export type Classification = z.infer<ReturnType<typeof makeClassificationSchema>>;

export interface ClassifierModel { invoke(messages: [string, string][]): Promise<unknown> }

async function defaultModel(cfg: OfficeConfig, schema: ReturnType<typeof makeClassificationSchema>): Promise<ClassifierModel> {
  const { initChatModel } = await import("langchain/chat_models/universal");
  const apiKey = process.env[cfg.llm.apiKeyEnv];
  if (!apiKey) throw new Error(`${cfg.llm.apiKeyEnv} is not set (required by llm.model=${cfg.llm.model})`);
  const llm = await initChatModel(cfg.llm.model, { temperature: 0, apiKey });
  return llm.withStructuredOutput(schema) as unknown as ClassifierModel;
}

export function makeClassifier(cfg: OfficeConfig, exemplars: Exemplar[], model?: ClassifierModel) {
  const schema = makeClassificationSchema(cfg);
  const system = buildSystemPrompt(cfg, exemplars);
  let m: ClassifierModel | undefined = model;
  return async (email: NormalizedEmail, ruleEvidence: RuleOutcome): Promise<Classification> => {
    m ??= await defaultModel(cfg, schema);
    const messages: [string, string][] = [["system", system], ["human", emailPrompt(email, ruleEvidence)]];
    try { return schema.parse(await m.invoke(messages)); }
    catch { return schema.parse(await m.invoke(messages)); } // one retry, then throw
  };
}
```

Delete `src/lib/prompt.ts` after moving anything still referenced; `scripts/probe-gemini.ts` and `evals/` will be updated in Task 11 — until then, exclude them from the build if they break compilation by updating them minimally to the new `makeClassifier(cfg, exemplars, model?)` signature with `examples/agency/triage.config.json`.

- [ ] **Step 5: Run tests, commit**

Run: `npx vitest run tests/promptgen.test.ts tests/classify.test.ts` — Expected: PASS (8 tests). Run `npx tsc --noEmit -p tsconfig.json` — Expected: clean.

```bash
git add src/lib/promptgen.ts src/lib/classify.ts tests/promptgen.test.ts tests/classify.test.ts package.json package-lock.json
git rm src/lib/prompt.ts
git commit -m "feat: generated prompts and provider-agnostic runtime classifier"
```

---

### Task 7: Decide/act/graph adaptation — config-driven routing, review forwards, context bodies

**Files:**
- Create: `src/lib/review.ts`
- Modify: `src/lib/decide.ts`, `src/lib/act.ts`, `src/graph/triage.ts`, `src/lib/config.ts`
- Test: `tests/decide.test.ts`, `tests/act.test.ts`, `tests/triage.test.ts` (rewrites), `tests/review.test.ts`

**Interfaces:**
- Consumes: `Vocabulary` (Task 1), `Classification` (Task 6), `RuleOutcome` (existing), `MailClient` (Task 3), `AppConfig` (existing runtime config: `{ stage, autoActLabels }` — `autoActLabels` now holds **category ids**).
- Produces:
  - `interface TriageTask { categoryId: string; label: string; forwardTo: string | null }` (label/forwardTo resolved via vocabulary at decide time)
  - `type Action = { kind: "categories"; labels: string[] } | { kind: "forward"; to: string } | { kind: "review-forward"; to: string }`
  - `decide(vocab: Vocabulary, reviewRecipient: string, rule: RuleOutcome, llm: Classification | null, cfg: AppConfig): Decision` — rule-complete decides at confidence `"rule"`; LLM decides when confidence `high` AND every category id ∈ `cfg.autoActLabels`; otherwise `needs_review` **with `actionsPlanned = [{ kind: "review-forward", to: reviewRecipient }]`** (review forwards are planned actions like any other — the stage gate decides whether they execute).
  - `buildContextBody(email: NormalizedEmail, decision: Decision, vocab: Vocabulary): string` (in `review.ts`) — `[triage]` header, proposed category/routing per task, confidence, rationale, "reply-free correction: just forward this to the right person".
  - Stage gating in `act.ts`: `shadow` → nothing; `assisted` → `categories` + `review-forward`; `autonomous` → all. `executeDecision(db, mail, decisionId, cfg, ctx: { vocab: Vocabulary; contextBodyFor(decisionId: number): Promise<string> })` — forwards call `mail.forward(threadId, to, contextBody)`; `ensureCategories` is called once per process before the first `applyCategories`.
  - `recordDecision` gains `configHash` parameter → written to `decisions.config_hash`.

- [ ] **Step 1: Write the failing tests**

Rewrite `tests/decide.test.ts` (core cases shown; keep the recordDecision cases from the existing file, updated to the new task shape):

```ts
import { describe, it, expect } from "vitest";
import { decide } from "@/lib/decide";
import { loadOfficeConfig, deriveVocabulary } from "@/lib/officeConfig";

const vocab = deriveVocabulary(loadOfficeConfig("examples/hartley/triage.config.json"));
const REVIEW = "jo@hartleysons.example";
const noRules = { hits: [], labels: [], forwards: [], complete: false };
const cfg = { stage: "shadow" as const, autoActLabels: ["jo", "sales", "junk"] };

describe("decide (config-driven)", () => {
  it("high-confidence allowed category decides with label + forward resolved from config", () => {
    const d = decide(vocab, REVIEW, noRules, { tasks: [{ category: "sales" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("decided");
    expect(d.tasks[0]).toEqual({ categoryId: "sales", label: "triage/sales", forwardTo: "sales@hartleysons.example" });
    expect(d.actionsPlanned).toEqual([
      { kind: "categories", labels: ["triage/sales"] },
      { kind: "forward", to: "sales@hartleysons.example" },
    ]);
  });
  it("junk decides with no forward", () => {
    const d = decide(vocab, REVIEW, noRules, { tasks: [{ category: "junk" }], confidence: "high", rationale: "" }, cfg);
    expect(d.actionsPlanned).toEqual([{ kind: "categories", labels: ["triage/junk"] }]);
  });
  it("categories outside the allow-list plan a review-forward", () => {
    const d = decide(vocab, REVIEW, noRules, { tasks: [{ category: "support" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("needs_review");
    expect(d.actionsPlanned).toEqual([{ kind: "review-forward", to: REVIEW }]);
  });
  it("medium confidence and null classifications also review-forward", () => {
    for (const llm of [null, { tasks: [{ category: "jo" }], confidence: "medium" as const, rationale: "" }]) {
      const d = decide(vocab, REVIEW, noRules, llm, cfg);
      expect(d.status).toBe("needs_review");
      expect(d.actionsPlanned).toEqual([{ kind: "review-forward", to: REVIEW }]);
    }
  });
  it("rule-complete hits decide at rule confidence using category ids from the rules table", () => {
    const d = decide(vocab, REVIEW, { hits: [{} as any], labels: ["jo"], forwards: [], complete: true }, null, cfg);
    expect(d.confidence).toBe("rule");
    expect(d.tasks[0].forwardTo).toBe("jo@hartleysons.example");
  });
});
```

Rewrite `tests/act.test.ts` stage-gating cases:

```ts
// fake MailClient from Task 3; seed a decided decision with a forward and a needs_review decision
it("shadow executes nothing", ...)                                     // log stays empty
it("assisted applies categories and review-forwards, never routee forwards", ...)
  // decided-with-forward: only the categories action executes
  // needs_review: the review-forward executes, log contains `forward:<id>:jo@...`
it("autonomous executes routee forwards with the context body", ...)   // log contains context excerpt
it("remains idempotent per action across re-runs", ...)                // second run adds nothing
```

Write these four with the same seed/fake structure as the existing `tests/act.test.ts` (PGlite + `recordDecision`), asserting against `fake.log` exactly as the current file does — the shapes change (`categories:`/`forward:` prefixes from Task 3's fake), not the technique.

Create `tests/review.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildContextBody } from "@/lib/review";
import { loadOfficeConfig, deriveVocabulary } from "@/lib/officeConfig";
import { normalize } from "@/lib/normalize";

const vocab = deriveVocabulary(loadOfficeConfig("examples/hartley/triage.config.json"));
const email = normalize({ threadId: "t", from: "cust@x.example", to: [], subject: "invoice overdue",
  listId: null, attachments: [], bodyText: "b", internalDateMs: 0, references: [] });

it("context body names the proposal, confidence, rationale, and the correction instruction", () => {
  const body = buildContextBody(email, {
    tasks: [{ categoryId: "jo", label: "triage/jo", forwardTo: "jo@hartleysons.example" }],
    confidence: "medium", status: "needs_review", actionsPlanned: [], rationale: "looks like billing",
  } as any, vocab);
  expect(body).toContain("[triage]");
  expect(body).toContain("Jo"); // human-readable name, not just the id
  expect(body).toContain("medium");
  expect(body).toContain("looks like billing");
  expect(body).toMatch(/forward this email to the right person/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/decide.test.ts tests/act.test.ts tests/review.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement decide**

Rewrite the decision core of `src/lib/decide.ts` (persistence helpers keep their existing SQL, plus `config_hash`):

```ts
import type { Vocabulary } from "./officeConfig";

export interface TriageTask { categoryId: string; label: string; forwardTo: string | null }
export type Action =
  | { kind: "categories"; labels: string[] }
  | { kind: "forward"; to: string }
  | { kind: "review-forward"; to: string };
export interface Decision {
  tasks: TriageTask[];
  confidence: "high" | "medium" | "low" | "rule";
  status: "decided" | "needs_review";
  actionsPlanned: Action[];
  rationale?: string;
}

function resolveTasks(vocab: Vocabulary, categoryIds: string[]): TriageTask[] {
  return [...new Set(categoryIds)].map((id) => ({ categoryId: id, label: vocab.labelFor(id), forwardTo: vocab.routeFor(id) }));
}

function planActions(tasks: TriageTask[]): Action[] {
  const labels = [...new Set(tasks.map((t) => t.label))];
  const actions: Action[] = labels.length ? [{ kind: "categories", labels }] : [];
  for (const t of tasks) if (t.forwardTo) actions.push({ kind: "forward", to: t.forwardTo });
  return actions;
}

export function decide(vocab: Vocabulary, reviewRecipient: string, rule: RuleOutcome, llm: Classification | null, cfg: AppConfig): Decision {
  if (rule.complete) {
    const tasks = resolveTasks(vocab, rule.labels);
    return { tasks, confidence: "rule", status: "decided", actionsPlanned: planActions(tasks) };
  }
  const review = (conf: Decision["confidence"], tasks: TriageTask[] = [], rationale?: string): Decision =>
    ({ tasks, confidence: conf, status: "needs_review", actionsPlanned: [{ kind: "review-forward", to: reviewRecipient }], rationale });
  if (!llm) return review("low");
  const tasks = resolveTasks(vocab, [...llm.tasks.map((t) => t.category), ...rule.labels]);
  const allowed = new Set(cfg.autoActLabels);
  const eligible = llm.confidence === "high" && tasks.every((t) => allowed.has(t.categoryId));
  return eligible
    ? { tasks, confidence: llm.confidence, status: "decided", actionsPlanned: planActions(tasks), rationale: llm.rationale }
    : review(llm.confidence, tasks, llm.rationale);
}
```

- [ ] **Step 4: Implement review context and act gating**

Create `src/lib/review.ts`:

```ts
import type { NormalizedEmail } from "./normalize";
import type { Decision } from "./decide";
import type { Vocabulary, OfficeConfig } from "./officeConfig";

export function buildContextBody(email: NormalizedEmail, d: Decision, vocab: Vocabulary): string {
  const lines = d.tasks.length
    ? d.tasks.map((t) => `  - ${vocab.describe(t.categoryId) ? t.label : t.label} -> ${nameFor(vocab, t.categoryId)}${t.forwardTo ? ` (${t.forwardTo})` : ""}`)
    : ["  - (no proposal - classifier could not decide)"];
  return [
    `[triage] Proposed routing for: ${email.subject}`,
    `From: ${email.fromAddr}`,
    ``, `Proposal (confidence: ${d.confidence}):`, ...lines,
    d.rationale ? `Why: ${d.rationale}` : "",
    ``, `If this is wrong or unhandled, just forward this email to the right person as usual -`,
    `the system watches sent mail and learns from your correction. No buttons, no login.`,
  ].filter(Boolean).join("\n");
}

function nameFor(vocab: Vocabulary, id: string): string {
  return vocab.describe(id).split(",")[0] || id;
}
```

In `src/lib/act.ts`, `permitted` becomes:

```ts
function permitted(action: Action, stage: AppConfig["stage"]): boolean {
  if (stage === "shadow") return false;
  if (stage === "assisted") return action.kind === "categories" || action.kind === "review-forward";
  return true; // autonomous
}
```

`executeDecision` gains the `ctx` parameter; `categories` actions call `mail.ensureCategories(labels)` then `mail.applyCategories`; both forward kinds call `mail.forward(threadId, to, await ctx.contextBodyFor(decisionId))` where `contextBodyFor` reconstructs the context from the decision row + thread snapshot (query both tables; build via `buildContextBody`). In `src/graph/triage.ts`, the graph passes `vocab` + `reviewRecipient` (read from `getOfficeConfig(db)`) into decide/act; `recordDecision` writes `configHash(officeCfg)`.

- [ ] **Step 5: Run the whole suite, commit**

Run: `npx vitest run` — Expected: ALL PASS (decide/act/review/triage rewrites + everything earlier).

```bash
git add src/lib/decide.ts src/lib/act.ts src/lib/review.ts src/graph/triage.ts src/lib/config.ts tests/
git commit -m "feat: config-driven routing, review forwards, context bodies, stage regating"
```

---

### Task 8: Sent-mail observer — passive corrections and learned-rule promotion

**Files:**
- Create: `src/lib/observer.ts`
- Modify: `src/app/api/cron/ingest/route.ts` (observer runs after the inbox batch)
- Test: `tests/observer.test.ts`

**Interfaces:**
- Consumes: `MailClient` (Task 3), `detectForwards`/`subjectCore` (Task 4), `Vocabulary`/`OfficeConfig` (Task 1), `corrections` table (Task 2), `ingest_state` row 2 (Task 2), `Querier`.
- Produces:
  - `observeSentMail(db: Querier, mail: MailClient, cfg: OfficeConfig, nowMs: number): Promise<{ corrections: number; promoted: number }>` — lists sent mail since `ingest_state[2].checkpoint_ms`; runs `detectForwards` against threads present in the `threads` table; for each match on a thread whose latest decision differs from the observed routing (or was `needs_review`), inserts a `corrections` row; advances checkpoint 2; then calls `promoteLearnedRules`.
  - `promoteLearnedRules(db: Querier, cfg: OfficeConfig): Promise<number>` — groups corrections joined to `threads` by `sender_exact` (support ≥3, purity 1.0) and `sender_domain` (support ≥5, purity ≥0.9); inserts matching patterns into `rules` with `source='learned'`, `on conflict do nothing`; returns inserted count.
  - Observer failures never abort ingest: the route wraps the call in try/catch and reports `observerError` in its JSON.

- [ ] **Step 1: Write the failing test**

Create `tests/observer.test.ts` (PGlite adapter as in Task 2; FakeMailClient from Task 3):

```ts
import { describe, it, expect, beforeEach } from "vitest";
// setup: migrations; office config stored; threads rows for t1..t5 from sender a@vendor.example;
// decisions rows: t1..t5 needs_review

it("records a correction when the reviewer forwards a reviewed thread to a routee", async () => {
  const mail = makeFakeMail({ sent: [snap("t1", { to: ["jo@hartleysons.example"], internalDateMs: NOW - 1000 })] });
  const r = await observeSentMail(getDb(), mail, cfg, NOW);
  expect(r.corrections).toBe(1);
  const { rows } = await getDb().query(`select category_id from corrections where thread_id='t1'`);
  expect(rows[0].category_id).toBe("jo");
});

it("ignores forwards of unknown threads and non-routee recipients", async () => {
  const mail = makeFakeMail({ sent: [
    snap("nope", { to: ["jo@hartleysons.example"] }),
    snap("t2", { to: ["stranger@elsewhere.example"] }),
  ]});
  expect((await observeSentMail(getDb(), mail, cfg, NOW)).corrections).toBe(0);
});

it("advances the sent checkpoint so a correction is not double-counted", async () => {
  const mail = makeFakeMail({ sent: [snap("t1", { to: ["jo@hartleysons.example"], internalDateMs: NOW - 1000 })] });
  await observeSentMail(getDb(), mail, cfg, NOW);
  expect((await observeSentMail(getDb(), mail, cfg, NOW)).corrections).toBe(0);
});

it("promotes a learned sender_exact rule after 3 consistent corrections", async () => {
  // seed corrections for t1,t2,t3 (same sender a@vendor.example, all -> jo) via three observer runs
  // then:
  const { rows } = await getDb().query(`select pattern, source, label_set from rules where pattern='a@vendor.example'`);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe("learned");
  expect(JSON.parse(rows[0].label_set)).toEqual(["jo"]);
});
```

Write the seeding helpers concretely in the test file (threads + decisions inserts mirror `recordDecision`'s SQL; three sent snapshots with ascending `internalDateMs` across three observer calls).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/observer.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/observer.ts`:

```ts
import type { Querier } from "./db";
import type { MailClient, ThreadSnapshot } from "./mail/types";
import type { OfficeConfig } from "./officeConfig";
import { detectForwards } from "./forwardDetect";

export async function observeSentMail(db: Querier, mail: MailClient, cfg: OfficeConfig, nowMs: number) {
  const { rows } = await db.query(`select checkpoint_ms from ingest_state where id = 2`);
  const since = Number(rows[0]?.checkpoint_ms ?? 0) || nowMs - 24 * 3600_000;

  const sent = await mail.listNewThreads(since, { sent: true });
  if (!sent.length) return { corrections: 0, promoted: 0 };

  // Only threads the system knows about can be corrected.
  const known = await db.query(`select thread_id, from_addr, subject, internal_date_ms from threads`);
  const inbox: ThreadSnapshot[] = known.rows.map((r: any) => ({
    threadId: r.thread_id, from: r.from_addr, to: [], subject: r.subject, listId: null,
    attachments: [], bodyText: "", internalDateMs: Number(r.internal_date_ms), references: [],
  }));

  let corrections = 0;
  for (const g of detectForwards(sent, inbox, cfg.routees)) {
    const dec = await db.query(
      `select id, final_tasks, status from decisions where thread_id = $1 order by id desc limit 1`, [g.threadId]);
    if (!dec.rows.length) continue;
    const tasks = typeof dec.rows[0].final_tasks === "string" ? JSON.parse(dec.rows[0].final_tasks) : dec.rows[0].final_tasks;
    const already = (tasks as any[]).some((t) => t.categoryId === g.categoryId);
    if (dec.rows[0].status !== "needs_review" && already) continue; // agreement, not a correction
    const dupe = await db.query(`select 1 from corrections where thread_id = $1 and category_id = $2`, [g.threadId, g.categoryId]);
    if (dupe.rows.length) continue;
    await db.query(
      `insert into corrections (thread_id, decision_id, category_id, observed_from) values ($1,$2,$3,'sent-forward')`,
      [g.threadId, dec.rows[0].id, g.categoryId]);
    corrections++;
  }

  const maxSent = Math.max(...sent.map((s) => s.internalDateMs), since);
  await db.query(`update ingest_state set checkpoint_ms = $1, last_success_at = now() where id = 2`, [maxSent]);
  const promoted = await promoteLearnedRules(db, cfg);
  return { corrections, promoted };
}

export async function promoteLearnedRules(db: Querier, _cfg: OfficeConfig): Promise<number> {
  const { rows } = await db.query(`
    select t.from_addr, c.category_id, count(*) as n
    from corrections c join threads t on t.thread_id = c.thread_id
    group by 1, 2`);
  let promoted = 0;
  const byAddr = new Map<string, { total: number; top: { cat: string; n: number } }>();
  for (const r of rows as any[]) {
    const cur = byAddr.get(r.from_addr) ?? { total: 0, top: { cat: "", n: 0 } };
    cur.total += Number(r.n);
    if (Number(r.n) > cur.top.n) cur.top = { cat: r.category_id, n: Number(r.n) };
    byAddr.set(r.from_addr, cur);
  }
  for (const [addr, { total, top }] of byAddr) {
    if (top.n >= 3 && top.n / total === 1) {
      const res = await db.query(
        `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
         values ('sender_exact', $1, $2, true, 1, $3, 'learned') on conflict (pattern_type, pattern) do nothing returning id`,
        [addr, JSON.stringify([top.cat]), top.n]);
      promoted += res.rows.length;
    }
  }
  // sender_domain: same aggregation keyed on split_part(from_addr,'@',2), support >= 5, purity >= 0.9
  const dom = await db.query(`
    select split_part(t.from_addr,'@',2) as domain, c.category_id, count(*) as n
    from corrections c join threads t on t.thread_id = c.thread_id group by 1, 2`);
  const byDom = new Map<string, { total: number; top: { cat: string; n: number } }>();
  for (const r of dom.rows as any[]) {
    const cur = byDom.get(r.domain) ?? { total: 0, top: { cat: "", n: 0 } };
    cur.total += Number(r.n);
    if (Number(r.n) > cur.top.n) cur.top = { cat: r.category_id, n: Number(r.n) };
    byDom.set(r.domain, cur);
  }
  for (const [domain, { total, top }] of byDom) {
    if (top.n >= 5 && top.n / total >= 0.9) {
      const res = await db.query(
        `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
         values ('sender_domain', $1, $2, true, $3, $4, 'learned') on conflict (pattern_type, pattern) do nothing returning id`,
        [domain, JSON.stringify([top.cat]), top.n / total, total]);
      promoted += res.rows.length;
    }
  }
  return promoted;
}
```

In `src/app/api/cron/ingest/route.ts`, after the inbox batch completes (and before returning), add:

```ts
let observer: { corrections: number; promoted: number } | { error: string };
try { observer = await observeSentMail(db, mail, officeCfg, Date.now()); }
catch (e) { observer = { error: e instanceof Error ? e.message : String(e) }; }
return NextResponse.json({ processed, checkpoint: maxSeen, failures, observer });
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/observer.test.ts` — Expected: PASS (4 tests).

```bash
git add src/lib/observer.ts src/app/api/cron/ingest/route.ts tests/observer.test.ts
git commit -m "feat: sent-mail observer — passive corrections and learned-rule promotion"
```

---

### Task 9: Onboarding eval, HTML report, and the daily digest

**Files:**
- Create: `src/lib/onboardEval.ts`, `src/lib/report.ts`, `src/lib/digest.ts`, `src/app/api/cron/digest/route.ts`
- Modify: `vercel.json` (add digest cron, daily), `src/app/api/cron/watchdog/route.ts` (alert address = `cfg.review.recipient`; `ALERT_EMAIL` env no longer used)
- Test: `tests/onboardEval.test.ts`, `tests/report.test.ts`, `tests/digest.test.ts`

**Interfaces:**
- Consumes: `LabeledThread` (Task 5), classify fn (Task 6), `Vocabulary` (Task 1), `MinedRule` (Task 5), `Querier`.
- Produces:
  - `interface CategoryStat { categoryId: string; precision: number; recall: number; f1: number; support: number }`
  - `interface EvalReport { overallAgreement: number; perCategory: CategoryStat[]; strongCategoryIds: string[]; evaluated: number; failures: number }` — strong = F1 ≥ 0.86 AND support ≥ 5; agreement = exact category-set match.
  - `runHoldoutEval(classify: (e) => Promise<Classification>, holdout: LabeledThread[]): Promise<EvalReport>`
  - `renderReport(input: { office: string; evalReport: EvalReport | null; rules: MinedRule[]; samples: { subject: string; from: string; categoryIds: string[] }[]; floor: number }): string` — one self-contained HTML string, zero external requests; includes the review-only warning block when `overallAgreement < floor` or `evalReport` is null.
  - `buildDigest(db: Querier, sinceMs: number): Promise<{ subject: string; body: string }>` — counts by status, pending review count, failures with detail, corrections observed.
  - `GET /api/cron/digest` — CRON_SECRET-gated; sends the digest to `cfg.review.recipient` via `mail.sendMessage`; `vercel.json` gains `{ "path": "/api/cron/digest", "schedule": "0 13 * * *" }`.

- [ ] **Step 1: Write the failing tests**

`tests/onboardEval.test.ts`:

```ts
it("scores per-category F1 and flags strong categories", async () => {
  // holdout: 10 jo-labeled + 10 sales-labeled threads
  // classify stub: perfect on jo; sales correct 6/10 (4 -> support)
  const report = await runHoldoutEval(stub, holdout);
  expect(report.overallAgreement).toBeCloseTo(16 / 20);
  const jo = report.perCategory.find((c) => c.categoryId === "jo")!;
  expect(jo.f1).toBe(1);
  expect(report.strongCategoryIds).toContain("jo");
  expect(report.strongCategoryIds).not.toContain("sales");
});
it("counts classify failures without aborting", async () => {
  const report = await runHoldoutEval(async () => { throw new Error("x"); }, holdout.slice(0, 3));
  expect(report.failures).toBe(3);
  expect(report.evaluated).toBe(0);
});
```

`tests/report.test.ts`:

```ts
it("renders a self-contained page with the strong/review-only split", () => {
  const html = renderReport({ office: "Hartley & Sons", evalReport, rules, samples, floor: 0.7 });
  expect(html).toContain("Hartley");
  expect(html).toContain("triage/jo");
  expect(html).not.toMatch(/https?:\/\/(?!smith)/); // no external requests (allow doc links if any -> keep none, simplest: no http at all)
  expect(html).toMatch(/auto-route/i);
});
it("shows the warning block below the floor", () => {
  const html = renderReport({ office: "X", evalReport: { ...evalReport, overallAgreement: 0.5 }, rules: [], samples: [], floor: 0.7 });
  expect(html).toMatch(/review-only/i);
});
```

`tests/digest.test.ts`: seed PGlite with 3 decided / 2 needs_review / 1 failed decisions + 1 correction; assert subject contains the office-day counts and body lists the failure detail and pending count.

- [ ] **Step 2: Run tests to verify they fail** — `npx vitest run tests/onboardEval.test.ts tests/report.test.ts tests/digest.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `onboardEval.ts`**

```ts
import type { LabeledThread } from "./mining";
import type { Classification } from "./classify";
import type { NormalizedEmail } from "./normalize";

export interface CategoryStat { categoryId: string; precision: number; recall: number; f1: number; support: number }
export interface EvalReport { overallAgreement: number; perCategory: CategoryStat[]; strongCategoryIds: string[]; evaluated: number; failures: number }

export async function runHoldoutEval(
  classify: (e: NormalizedEmail) => Promise<Classification>,
  holdout: LabeledThread[]
): Promise<EvalReport> {
  let exact = 0, evaluated = 0, failures = 0;
  const tp = new Map<string, number>(), fp = new Map<string, number>(), fn = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const h of holdout) {
    let got: Set<string>;
    try { got = new Set((await classify(h.email)).tasks.map((t) => t.category)); }
    catch { failures++; continue; }
    evaluated++;
    const want = new Set(h.categoryIds);
    if (got.size === want.size && [...got].every((g) => want.has(g))) exact++;
    for (const g of got) want.has(g) ? bump(tp, g) : bump(fp, g);
    for (const w of want) if (!got.has(w)) bump(fn, w);
  }
  const cats = new Set([...tp.keys(), ...fp.keys(), ...fn.keys()]);
  const perCategory = [...cats].map((c) => {
    const t = tp.get(c) ?? 0, f = fp.get(c) ?? 0, n = fn.get(c) ?? 0;
    const precision = t + f ? t / (t + f) : 0, recall = t + n ? t / (t + n) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { categoryId: c, precision, recall, f1, support: t + n };
  }).sort((a, b) => b.f1 - a.f1);
  return {
    overallAgreement: evaluated ? exact / evaluated : 0,
    perCategory,
    strongCategoryIds: perCategory.filter((c) => c.f1 >= 0.86 && c.support >= 5).map((c) => c.categoryId),
    evaluated, failures,
  };
}
```

- [ ] **Step 4: Implement `report.ts`, `digest.ts`, the digest route, and the watchdog change**

`renderReport` builds one HTML string: inline `<style>` (system fonts, one accent), header with office name + date, agreement headline, per-category table (`<td>` label, F1 as percent, `strong`/`review-only` chip), mined-rules table (pattern, categories, purity/support, tier), the would-have-routed samples list, and — when `evalReport === null || overallAgreement < floor` — a bordered warning block: "Automation starts review-only. The system will still organize and propose; nothing sends automatically until measured agreement improves." Keep it under ~150 lines; no scripts, no external URLs.

`buildDigest`: three queries (decisions since `sinceMs` grouped by status; failures with `error_detail`; corrections count) formatted as plain text; subject `"[triage] daily digest — N routed, M waiting, K errors"`.

`src/app/api/cron/digest/route.ts` mirrors the watchdog route's auth pattern; loads office config; `mail.sendMessage(cfg.review.recipient, subject, body)`. Watchdog route: replace `process.env.ALERT_EMAIL` with `officeCfg.review.recipient` (config is the single source of truth; drop `ALERT_EMAIL` from `.env.example`).

- [ ] **Step 5: Run the full suite, commit**

Run: `npx vitest run` — Expected: ALL PASS.

```bash
git add src/lib/onboardEval.ts src/lib/report.ts src/lib/digest.ts src/app/api/cron/ vercel.json .env.example tests/
git commit -m "feat: onboarding eval, HTML report, daily digest, config-driven alerting"
```

---

### Task 10: The CLI — init, status, promote, pause

**Files:**
- Create: `src/cli/main.ts`, `src/cli/steps/connect.ts`, `src/cli/steps/interview.ts`, `src/cli/steps/mine.ts`, `src/cli/steps/deploy.ts`
- Modify: `package.json` (script `"triage": "npx tsx --env-file=.env src/cli/main.ts"`), `scripts/authorize-gmail.ts` (extract its loopback flow into `src/cli/steps/connect.ts`; the script becomes a thin wrapper)
- Test: `tests/cli.test.ts` (pure pieces: arg routing, interview parsing, artifact round-trip — the interactive/deploy paths are covered by the integration test and live use)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `npm run triage -- init [--dry-run] [--config <path>]` — orchestrates: connect → interview (skipped when `--config` given) → mine → generate → evaluate → report → deploy. `--dry-run` swaps `makeGmail()` for `makeFakeMail()` seeded from `examples/hartley/history.json` and skips deploy — this is also the README demo path.
  - **Artifacts directory `.triage/`** (gitignored): `mined-rules.json` (`MinedRule[]`), `exemplars.json` (`Exemplar[]`), `holdout.json` (`LabeledThread[]`), `eval.json` (`EvalReport`), `triage-report.html`. Mining runs **before** any database exists; the deploy step provisions Neon, runs migrations, then seeds config + rules + exemplars from these files. `writeArtifacts(dir, artifacts)` / `readArtifacts(dir)` exported from `src/cli/steps/mine.ts`.
  - `npm run triage -- status` — reads DB: stage, decision counts by status (7 days), corrections count, agreement-vs-corrections rate, and whether promotion gates look met (plain language).
  - `npm run triage -- promote` / `-- pause` — confirmation prompt, then `setConfigKey(db, "stage", next)`; `pause` always goes to `shadow`.

- [ ] **Step 1: Write the failing test for the pure pieces**

Create `tests/cli.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCliArgs } from "@/cli/main";
import { interviewToConfig } from "@/cli/steps/interview";
import { writeArtifacts, readArtifacts } from "@/cli/steps/mine";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("parseCliArgs", () => {
  it("routes commands and flags", () => {
    expect(parseCliArgs(["init", "--dry-run"])).toEqual({ command: "init", dryRun: true, config: undefined });
    expect(parseCliArgs(["promote"])).toEqual({ command: "promote", dryRun: false, config: undefined });
    expect(() => parseCliArgs(["dance"])).toThrow(/unknown command/i);
  });
});

describe("interviewToConfig", () => {
  it("builds a valid office config from interview answers", () => {
    const cfg = interviewToConfig({
      officeName: "Hartley & Sons", mailbox: "info@hartleysons.example",
      routees: [{ name: "Jo Hartley", email: "jo@hartleysons.example", description: "Billing and invoices" }],
      reviewRecipient: "jo@hartleysons.example", llmModel: "anthropic:claude-sonnet-5",
    });
    expect(cfg.routees[0].id).toBe("jo-hartley"); // slugified
    expect(cfg.llm.apiKeyEnv).toBe("ANTHROPIC_API_KEY"); // derived from provider
    expect(cfg.categories.some((c) => c.id === "junk")).toBe(true);
  });
});

describe("artifacts round-trip", () => {
  it("writes and reads the .triage artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "triage-"));
    const artifacts = {
      minedRules: [{ patternType: "sender_domain" as const, pattern: "x.example", categoryIds: ["jo"], purity: 1, support: 6, tier: "mined-gold" as const }],
      exemplars: [], holdout: [], evalReport: null, reportHtml: "<h1>r</h1>",
    };
    writeArtifacts(dir, artifacts as any);
    expect(readArtifacts(dir).minedRules[0].pattern).toBe("x.example");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/cli.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the CLI skeleton and pure pieces**

`src/cli/main.ts`:

```ts
import { parseArgs } from "node:util";

export interface CliArgs { command: "init" | "status" | "promote" | "pause"; dryRun: boolean; config: string | undefined }

export function parseCliArgs(argv: string[]): CliArgs {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, config: { type: "string" } },
  });
  const command = positionals[0];
  if (!["init", "status", "promote", "pause"].includes(command ?? ""))
    throw new Error(`unknown command: ${command ?? "(none)"} — expected init | status | promote | pause`);
  return { command: command as CliArgs["command"], dryRun: values["dry-run"]!, config: values.config };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const { run } = await import(`./commands/${args.command}`);
  await run(args);
}
if (process.argv[1]?.endsWith("main.ts")) main().catch((e) => { console.error(e.message); process.exit(1); });
```

`src/cli/steps/interview.ts` — `interviewToConfig(answers)` (pure, tested) + `runInterview()` (readline wrapper that collects the same answers interactively). Slugify: lowercase, spaces→`-`, strip non `[a-z0-9-]`. `apiKeyEnv` from provider prefix: `{ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google_genai: "GEMINI_API_KEY", mistralai: "MISTRAL_API_KEY", groq: "GROQ_API_KEY", ollama: "OLLAMA_UNUSED" }`. Writes `triage.config.json` and echoes it for review.

`src/cli/steps/connect.ts` — the loopback OAuth flow extracted verbatim from `scripts/authorize-gmail.ts`, parameterized by mailbox; on success appends `GOOGLE_OAUTH_REFRESH_TOKEN` to `.env` (with the user's confirmation printed). Also `npm i`s the provider package for the configured LLM if missing (`PROVIDER_PACKAGES` from Task 6, via `execFileSync("npm", ["i", pkg])`).

`src/cli/steps/mine.ts` — orchestration used by both init and the integration test:

```ts
export interface Artifacts { minedRules: MinedRule[]; exemplars: Exemplar[]; holdout: LabeledThread[]; evalReport: EvalReport | null; reportHtml: string }
export async function runMiningPipeline(mail: MailClient, cfg: OfficeConfig, classify: ClassifyFn, log = console.log): Promise<Artifacts>
```
Pipeline: pull inbox + sent history (`listHistory`) → normalize → `detectForwards` → gold labels; `stratifiedSample` the unlabeled remainder to `min(1000, maxThreads/5)` → `labelWithLLM` (classifier built with **no exemplars** for this pass) → merge → `splitHoldout` → `minePatterns(train)` → `pickExemplars(train)` → rebuild classifier **with** exemplars → `runHoldoutEval` → `renderReport` → return artifacts. `writeArtifacts`/`readArtifacts`: JSON files + the HTML, in `.triage/` (add to `.gitignore`).

`src/cli/steps/deploy.ts` — the productized Task-12 sequence from the case study, each step printed then executed with confirmation: `vercel link`, `vercel integration add neon`, env pushes (`printf | vercel env add` equivalents via `execFileSync` with `input:`), migrations + seeding from artifacts (config via `setOfficeConfig`, rules via `seedMinedRules`, exemplars insert), `vercel deploy --prod`, one authenticated smoke ingest, then: "Shadow mode is live. Open `triage-report.html` — that's what your office can expect."

`status/promote/pause` commands: thin DB reads/writes as specced in Interfaces; promote refuses `shadow → autonomous` (must pass through assisted).

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/cli.test.ts` — Expected: PASS. Run: `npx tsc --noEmit` — Expected: clean.

```bash
git add src/cli/ package.json scripts/authorize-gmail.ts .gitignore tests/cli.test.ts
git commit -m "feat: triage CLI — init pipeline, artifacts, status/promote/pause"
```

---

### Task 11: Example-office migration — tests, demo, evals, case-study docs, README, CI

**Files:**
- Create: `examples/hartley/history.json` (synthetic history fixtures), `docs/case-study/README.md`
- Modify: `scripts/demo.ts` (Hartley office through the config-driven pipeline), `evals/run.ts` + `evals/evaluators.ts` (case-study eval uses `examples/agency/triage.config.json`), `scripts/probe-gemini.ts`, `tests/labels.test.ts` → delete (superseded by `tests/officeConfig.test.ts` vocabulary tests), `README.md`, `docs/architecture.md`, `docs/operations.md`, `docs/onboarding.md`
- Move: `docs/superpowers/specs/2026-08-05-email-triage-design.md` → `docs/case-study/design-spec.md` (git mv; leave a pointer file), `docs/evals.md` → keep path, update to reference the case-study config
- Test: the whole suite is the test — `npx vitest run` green with `src/lib/labels.ts` deleted

**Interfaces:**
- Consumes: everything.
- Produces: `examples/hartley/history.json` — ~40 synthetic threads (inbox) + ~12 sent forwards, shaped `{ inbox: ThreadSnapshot[], sent: ThreadSnapshot[] }`, covering: a patterned vendor domain (8 threads, all historically forwarded to jo — mines a gold rule), a newsletter list-id (6 threads — mines a junk rule via LLM labels in the integration test), order/quote/support mail spread across senders, 2 multi-request emails. This file powers `--dry-run` init, the demo, and Task 12's integration test — one fixture set, three consumers.

Steps (this task is mechanical; each bullet is a step with its own commit-worthy checkpoint):

- [ ] **Step 1:** Write `examples/hartley/history.json` with the composition above (fictional senders on `.example` domains; concrete subjects/bodies — e.g. vendor `statements@officesupply.example` "Monthly statement #<n>"; newsletter `news@tradeweekly.example` with `listId "<news.tradeweekly.example>"`; quote requests "Quote for 40 chairs" etc.).
- [ ] **Step 2:** Rewrite `scripts/demo.ts`: load Hartley config + history fixtures, seed PGlite via `runMigrations` + `setOfficeConfig` + a mined-gold rule for the vendor domain, run 6 representative emails through the graph with a canned classifier (same shadow → autonomous two-act structure as today, now showing `triage/jo`-style labels and review-forwards). Verify `npm run demo` output shows: rule-hit skip, review-forward for a low-confidence email, context body excerpt, idempotent re-run.
- [ ] **Step 3:** Delete `src/lib/labels.ts`; fix remaining importers (compiler-guided); delete `tests/labels.test.ts` and `tests/config.test.ts`'s autoActLabels-default block (allow-list is now seeded by eval, not hardcoded — `DEFAULTS.autoActLabels` becomes `[]`).
- [ ] **Step 4:** Update `evals/run.ts` to build its target from `examples/agency/triage.config.json` (`makeClassifier(caseCfg, [])`) and map the dataset's golden label names to the new category ids (small translation table in the file: `"7-Loss Run Req" → "loss-run-request"` etc.); `evals/evaluators.ts` conventions table stays (it documents the case-study rubric). Run `npm run eval -- --limit 3 --no-judges` once with keys to confirm wiring.
- [ ] **Step 5:** `git mv` the AGY spec into `docs/case-study/design-spec.md`; write `docs/case-study/README.md` (one page: what the case study was, the phase0 method, the measured numbers, link to the old plan); update `docs/*.md` cross-references; rewrite the top half of `README.md` around the product (hero: `npm run triage -- init --dry-run`; the case study as the evidence section; provider-choice table; M2/M3 roadmap).
- [ ] **Step 6:** Run everything: `npx vitest run` (ALL PASS), `npm run demo` (works), `npm run build` (clean), `npx tsc --noEmit` (clean). Commit:

```bash
git add -A
git commit -m "feat: example offices, config-driven demo/evals, case-study docs, product README"
```

---

### Task 12: End-to-end integration test — clone-to-shadow on fakes, correction loop proof

**Files:**
- Create: `tests/integration.test.ts`
- Test: itself

**Interfaces:**
- Consumes: `runMiningPipeline` + artifacts (Task 10), `makeFakeMail` (Task 3), Hartley config + `history.json` (Task 11), graph + observer + digest (Tasks 7–9).
- Produces: the executable proof of spec §13 success criteria 3, 4, and 5's zero-credential requirement. **No network, no keys, no randomness.**

- [ ] **Step 1: Write the test (it fails only if earlier tasks are broken — this is the acceptance gate)**

Create `tests/integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
// PGlite adapter as in Task 2; imports: officeConfig, mining pipeline, fake mail, graph, observer, digest

describe("clone-to-shadow, end to end on fakes", () => {
  let artifacts: Artifacts; let mail: ReturnType<typeof makeFakeMail>; let cfg: OfficeConfig;

  beforeAll(async () => {
    cfg = loadOfficeConfig("examples/hartley/triage.config.json");
    const history = JSON.parse(readFileSync("examples/hartley/history.json", "utf8"));
    mail = makeFakeMail(history);
    // deterministic stub classifier: routes by keyword — invoice/statement -> jo, quote/order -> sales,
    // return/broken -> support, list-id newsletters -> junk, else low confidence
    artifacts = await runMiningPipeline(mail, cfg, stubClassifier, () => {});
  });

  it("mines a gold rule from the forwarded vendor domain", () => {
    const vendor = artifacts.minedRules.find((r) => r.pattern === "officesupply.example");
    expect(vendor).toMatchObject({ tier: "mined-gold", categoryIds: ["jo"] });
  });

  it("produces an eval report and the HTML artifact", () => {
    expect(artifacts.evalReport!.evaluated).toBeGreaterThan(0);
    expect(artifacts.reportHtml).toContain("Hartley");
  });

  it("seeds a database and runs a shadow ingest with zero mail writes", async () => {
    await setupDb(); // PGlite + migrations + setOfficeConfig + seedMinedRules(artifacts.minedRules)
    const graph = buildTriageGraph({ db: getDb(), mail, classify: stubClassifier, cfg });
    const id = await graph.run(normalizeSnap(newVendorEmail)); // fresh officesupply.example thread
    const { rows } = await getDb().query(`select confidence, status, config_hash from decisions where id=$1`, [id]);
    expect(rows[0]).toMatchObject({ confidence: "rule", status: "decided" });
    expect(rows[0].config_hash).toBeTruthy();
    expect(mail.log.filter((l) => l.startsWith("categories") || l.startsWith("forward"))).toHaveLength(0); // shadow
  });

  it("closes the correction loop: 3 reviewer forwards promote a learned rule", async () => {
    // run 3 uncertain emails from newvendor.example through the graph (stub returns low confidence),
    // then push 3 sent forwards of those threads to jo@ and run observeSentMail 3x with advancing timestamps
    const { rows } = await getDb().query(`select source from rules where pattern = 'billing@newvendor.example'`);
    expect(rows[0]?.source).toBe("learned");   // spec §13 criterion 3
  });

  it("builds a digest naming the day's activity", async () => {
    const d = await buildDigest(getDb(), 0);
    expect(d.subject).toMatch(/\d+ routed|\d+ waiting/);
  });
});
```

Fill in `stubClassifier`, `setupDb`, `newVendorEmail`, and the three-correction sequence concretely — every helper is under 15 lines and lives in the test file.

- [ ] **Step 2: Run it** — `npx vitest run tests/integration.test.ts` — Expected: PASS. If any assertion fails, the defect is in the task that owns that seam — fix there, not in the test.

- [ ] **Step 3: Full-suite gate and commit**

Run: `npx vitest run && npm run build && npm run demo` — Expected: all green, no credentials used anywhere.

```bash
git add tests/integration.test.ts
git commit -m "test: clone-to-shadow integration proof incl. learned-rule promotion"
```

---

## Self-review notes

- **Spec coverage:** §4 onboarding steps 1–6 → Tasks 10 (connect/interview/deploy), 4–5 (mining), 6 (generate), 9 (evaluate + report); §5 config → Task 1 (+ storage Task 2); §6 MailClient → Task 3 (Graph impl is M2, contract tests frozen here); §7 runtime safety/stages → Task 7; §8 review + correction loop → Tasks 7 (context bodies) and 8 (observer); §9 error handling → embedded per task (mining skip-counts T5, eval floor T9, observer isolation T8); §10 testing → every task + Task 12; §11 repo transition → Task 11; §13 criteria → 1: Task 10+11 (README-driven init), 2: Task 9, 3: Task 12, 4: Tasks 11–12, 5: Task 11 step 4. **M2 (Graph) and M3 are explicitly out of this plan.**
- **Type consistency:** `Vocabulary`/`OfficeConfig` (T1) consumed in T5/T6/T7/T8/T9/T10; `ThreadSnapshot`+`MailClient` (T3) in T4/T8/T10/T12; `LabeledThread`/`MinedRule` (T5) in T6 (`pickExemplars`)/T9/T10/T12; `Classification{tasks:[{category}]}` (T6) in T5 (`labelWithLLM` shape)/T7/T9; `Action` incl. `review-forward` (T7) in T8's status checks and T12; `Artifacts` (T10) in T12 — names cross-checked.
- **Deliberate simplifications vs the case study, restated:** model emits category ids only (routing is config lookup); per-task multi-label dropped (categories have no rider labels); `subject_template` mining deferred (sender/domain/list-id only in M1 — the case study's subject templates were carrier-specific).
- **Ordering note for executors:** Tasks 1–2 are independent of 3–4; 5 needs 1+4; 6 needs 1+5; 7 needs 1+3+6; 8 needs 2+3+4; 9 needs 5+6; 10 needs all prior; 11–12 last.
