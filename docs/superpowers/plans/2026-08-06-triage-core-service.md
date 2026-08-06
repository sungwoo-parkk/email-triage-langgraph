# Email Triage Core Service Implementation Plan

> **Status (2026-08-06):** Tasks 1–11 and 13 complete (67 tests green on `triage-core`; Gemini eval gate PASSED — see spec §7.1). Remaining: **Task 12** (deployment + DWD setup — human-in-the-loop checklist).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pro@agency.example triage service through shadow-mode readiness: Gmail ingestion, rules engine, Gemini classifier, LangGraph pipeline, staged action layer, and the pre-launch eval — per the approved spec `docs/superpowers/specs/2026-08-05-email-triage-design.md`.

**Architecture:** Next.js (App Router) on Vercel; LangGraph.js state graph (`rules → classify → decide → record → act`); Postgres as system of record (decisions written before any action); Gmail via domain-wide-delegation service account; Gemini 3.6 Flash with schema-enforced output. Dashboard is a separate follow-up plan.

**Tech Stack:** TypeScript (strict), Next.js, `@langchain/langgraph`, `@langchain/google-genai`, `@langchain/core`, `googleapis`, `zod`, `pg` (prod) / `@electric-sql/pglite` (tests), Vitest.

## Global Constraints

- Label vocabulary is the existing 42 Gmail labels **verbatim** — including the `Cancelllation` triple-L misspelling. Never "fix" spellings.
- The classifier may only emit **queue-family labels** (never `*DONE*` completion markers — those are human-only).
- Every decision row is written to Postgres **before** any Gmail action executes.
- Fail toward humans: any classification failure routes to `needs_review`, never to an automated action.
- Stage default is `shadow` (zero Gmail writes). Stage changes are manual config updates.
- `phase0/data/` and `phase0/analysis/` contain insured PII and stay gitignored (already configured).
- Gemini model ID comes from env `GEMINI_MODEL` (default `gemini-3.6-flash`); verify the exact ID with the probe script before relying on it.
- Desk aliases: `invoice@agency.example`, `accounting@agency.example`, `express@agency.example` only. Forwards go to aliases, never to individuals.
- All new code in `src/`; tests in `tests/` mirroring module names; run tests with `npx vitest run`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`, `src/app/page.tsx`, `tests/sanity.test.ts`

**Interfaces:**
- Produces: a building Next.js TypeScript project with Vitest wired; all later tasks assume `npx vitest run` and `npm run build` work.

- [ ] **Step 1: Scaffold Next.js and install dependencies**

```bash
npx create-next-app@latest . --ts --app --no-tailwind --no-eslint --src-dir --import-alias "@/*" --yes
npm i @langchain/langgraph @langchain/google-genai @langchain/core googleapis zod pg
npm i -D vitest @electric-sql/pglite @types/pg
```

(If `create-next-app` balks at the non-empty directory, run it in a temp dir and move the generated files in — do not delete `docs/`, `phase0/`, or `.git/`.)

- [ ] **Step 2: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 3: Write the sanity test**

Create `tests/sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs TypeScript tests", () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
```

- [ ] **Step 4: Create `.env.example`**

```bash
DATABASE_URL=postgres://user:pass@host/db
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
GOOGLE_SA_EMAIL=triage-bot@<gcp-project>.iam.gserviceaccount.com
GOOGLE_SA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GMAIL_USER=pro@agency.example
CRON_SECRET=
ALERT_EMAIL=
```

- [ ] **Step 5: Verify build and tests, commit**

Run: `npm run test` → sanity test PASSES. Run: `npm run build` → succeeds.

```bash
git add -A && git commit -m "chore: scaffold Next.js + Vitest project"
```

---

### Task 2: Database layer and schema

**Files:**
- Create: `src/lib/db.ts`, `src/lib/migrate.ts`, `migrations/001_init.sql`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `getDb(): Querier`, `setDb(q: Querier)` (test injection), `runMigrations(db: Querier): Promise<void>`, and interface `Querier { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }`. All later DB access goes through `getDb()`.

- [ ] **Step 1: Write the failing test**

Create `tests/db.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";

function pgliteAdapter(p: PGlite): Querier {
  return { query: (sql, params) => p.query(sql, params as any[]) as any };
}

describe("schema", () => {
  beforeAll(async () => {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
  });

  it("creates all tables", async () => {
    const { rows } = await getDb().query(
      `select table_name from information_schema.tables where table_schema='public' order by 1`
    );
    const names = rows.map((r: any) => r.table_name);
    for (const t of ["threads", "decisions", "reviews", "rules", "app_config", "ingest_state", "schema_migrations"])
      expect(names).toContain(t);
  });

  it("is idempotent", async () => {
    await runMigrations(getDb()); // second run must not throw
  });

  it("enforces rule pattern types", async () => {
    await expect(
      getDb().query(`insert into rules (pattern_type, pattern, label_set) values ('bogus','x','[]')`)
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts` — Expected: FAIL (modules don't exist).

- [ ] **Step 3: Implement db, migrations, and schema**

Create `src/lib/db.ts`:

```ts
import { Pool } from "pg";

export interface Querier {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

let db: Querier | null = null;

export function setDb(q: Querier): void {
  db = q;
}

export function getDb(): Querier {
  if (!db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = { query: (sql, params) => pool.query(sql, params as any[]) };
  }
  return db;
}
```

Create `migrations/001_init.sql`:

```sql
create table if not exists threads (
  thread_id text primary key,
  from_addr text not null,
  subject text not null default '',
  attachments jsonb not null default '[]',
  list_id text,
  body_excerpt text not null default '',
  internal_date_ms bigint not null,
  first_seen timestamptz not null default now()
);

create table if not exists decisions (
  id bigint generated always as identity primary key,
  thread_id text not null references threads(thread_id),
  stage text not null,
  rule_hits jsonb not null default '[]',
  llm_output jsonb,
  final_tasks jsonb not null default '[]',
  confidence text,
  status text not null default 'decided'
    check (status in ('decided','needs_review','acted','failed')),
  actions_planned jsonb not null default '[]',
  actions_executed jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists decisions_thread_idx on decisions(thread_id);
create index if not exists decisions_status_idx on decisions(status);

create table if not exists reviews (
  id bigint generated always as identity primary key,
  decision_id bigint not null references decisions(id),
  corrected_tasks jsonb not null,
  reviewer text not null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists rules (
  id bigint generated always as identity primary key,
  pattern_type text not null
    check (pattern_type in ('sender_exact','sender_domain','list_id','subject_template')),
  pattern text not null,
  label_set jsonb not null,
  forward_to text,
  complete boolean not null default true,
  purity real,
  support int,
  source text not null default 'manual',
  active boolean not null default true,
  unique (pattern_type, pattern)
);

create table if not exists app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ingest_state (
  id int primary key,
  checkpoint_ms bigint not null,
  last_success_at timestamptz
);
insert into ingest_state (id, checkpoint_ms) values (1, 0) on conflict do nothing;
```

Create `src/lib/migrate.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Querier } from "./db";

export async function runMigrations(db: Querier, dir = path.join(process.cwd(), "migrations")): Promise<void> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const { rows } = await db.query(`select 1 from schema_migrations where name = $1`, [f]);
    if (rows.length) continue;
    await db.query(readFileSync(path.join(dir, f), "utf8"));
    await db.query(`insert into schema_migrations (name) values ($1)`, [f]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/migrate.ts migrations/ tests/db.test.ts
git commit -m "feat: database layer, migration runner, and v1 schema"
```

---

### Task 3: Label vocabulary and runtime config

**Files:**
- Create: `src/lib/labels.ts`, `src/lib/config.ts`
- Test: `tests/labels.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `ALL_LABELS: readonly string[]` (42 entries), `CLASSIFIABLE_LABELS: readonly string[]` (queue family only), `DESK_ALIASES = ["invoice@agency.example","accounting@agency.example","express@agency.example"] as const`, `isDoneLabel(name: string): boolean`; `getConfig(db): Promise<AppConfig>`, `setConfigKey(db, key, value)`, with `AppConfig = { stage: "shadow"|"assisted"|"autonomous", autoActLabels: string[] }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ALL_LABELS, CLASSIFIABLE_LABELS, isDoneLabel, DESK_ALIASES } from "@/lib/labels";

describe("label vocabulary", () => {
  it("preserves the Cancelllation misspelling (load-bearing)", () => {
    expect(ALL_LABELS).toContain("Cancelllation");
    expect(ALL_LABELS).not.toContain("Cancellation");
  });
  it("has exactly 42 labels", () => {
    expect(ALL_LABELS.length).toBe(42);
  });
  it("excludes DONE-family labels from the classifier vocabulary", () => {
    expect(CLASSIFIABLE_LABELS.every((l) => !isDoneLabel(l))).toBe(true);
    expect(CLASSIFIABLE_LABELS).toContain("3-KR/DOCS&NOTICE");
    expect(CLASSIFIABLE_LABELS).not.toContain("*1-DONE/DONE-P4");
  });
  it("locks the desk aliases", () => {
    expect([...DESK_ALIASES]).toEqual(["invoice@agency.example", "accounting@agency.example", "express@agency.example"]);
  });
});
```

Create `tests/config.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { getConfig, setConfigKey } from "@/lib/config";

describe("config", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb({ query: (sql, params) => p.query(sql, params as any[]) as any });
    await runMigrations(getDb());
  });

  it("defaults stage to shadow", async () => {
    const cfg = await getConfig(getDb());
    expect(cfg.stage).toBe("shadow");
  });

  it("round-trips a stage change", async () => {
    await setConfigKey(getDb(), "stage", "assisted");
    expect((await getConfig(getDb())).stage).toBe("assisted");
  });

  it("rejects invalid stage values", async () => {
    await setConfigKey(getDb(), "stage", "yolo");
    await expect(getConfig(getDb())).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/labels.test.ts tests/config.test.ts` — Expected: FAIL (modules don't exist).

- [ ] **Step 3: Implement labels**

Create `src/lib/labels.ts` (vocabulary source: Phase 0 `diagnose2` label snapshot — every name verbatim):

```ts
export const ALL_LABELS = [
  "0- NY Pro Training", "1- NY to F/up", "2-NY", "2-NY/Endorsement", "2-NY/Recommendation",
  "3-Endorsement", "3-KR", "3-KR/DOCS&NOTICE", "3-KR/POLICY REQUEST", "3-KR/USLI RENEWAL QUOTE",
  "4-CAN REQ", "5-UW", "6-RENEWAL QUOTE-USLI", "7-Loss Run Req", "8-C-105.2",
  "*1-DONE", "*1-DONE/1-DONE-P1", "*1-DONE/DONE-P2", "*1-DONE/DONE-P3",
  "*1-DONE/DONE-P4", "*1-DONE/DONE-P4/S1", "*1-DONE/DONE-P4/S2", "*1-DONE/DONE-P4/S3",
  "*1-DONE/DONE-P4/S4", "*1-DONE/DONE-P4/S5",
  "Billing", "Cancelllation", "DONE-P5", "DONE-P6", "DONE-P7", "DONE-P8",
  "DONE-P9", "P10 Done", "P10-double check", "Done - P11", "Forward to EHA",
  "ONLY UPDATE EPIC", "STAFF-P12", "Undelivered Email", "Y",
  "disregard", "disregard/confirmed done in EPIC",
] as const;

export function isDoneLabel(name: string): boolean {
  return /done/i.test(name) && !name.toLowerCase().startsWith("disregard");
}

export const CLASSIFIABLE_LABELS = ALL_LABELS.filter((l) => !isDoneLabel(l));

export const DESK_ALIASES = ["invoice@agency.example", "accounting@agency.example", "express@agency.example"] as const;
export type DeskAlias = (typeof DESK_ALIASES)[number];
```

- [ ] **Step 4: Implement config**

Create `src/lib/config.ts`:

```ts
import { z } from "zod";
import type { Querier } from "./db";
import { CLASSIFIABLE_LABELS } from "./labels";

const AppConfigSchema = z.object({
  stage: z.enum(["shadow", "assisted", "autonomous"]),
  autoActLabels: z.array(z.string()),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// Categories the blind test measured strong (F1 >= 0.86) start auto-act-eligible;
// weak categories stay review-only until eval proves otherwise (spec 4.4).
const DEFAULTS: AppConfig = {
  stage: "shadow",
  autoActLabels: CLASSIFIABLE_LABELS.filter((l) =>
    ["2-NY/Endorsement", "3-Endorsement", "7-Loss Run Req", "8-C-105.2", "3-KR/POLICY REQUEST",
     "2-NY/Recommendation", "6-RENEWAL QUOTE-USLI", "3-KR/USLI RENEWAL QUOTE", "3-KR",
     "3-KR/DOCS&NOTICE", "Cancelllation", "4-CAN REQ", "2-NY"].includes(l)
  ),
};

export async function getConfig(db: Querier): Promise<AppConfig> {
  const { rows } = await db.query(`select key, value from app_config`);
  const overrides = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  return AppConfigSchema.parse({ ...DEFAULTS, ...overrides });
}

export async function setConfigKey(db: Querier, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into app_config (key, value) values ($1, $2)
     on conflict (key) do update set value = $2, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}
```

- [ ] **Step 5: Run tests to verify they pass, commit**

Run: `npx vitest run tests/labels.test.ts tests/config.test.ts` — Expected: PASS (7 tests).

```bash
git add src/lib/labels.ts src/lib/config.ts tests/labels.test.ts tests/config.test.ts
git commit -m "feat: label vocabulary (42 verbatim) and db-backed runtime config"
```

---

### Task 4: Email normalization

**Files:**
- Create: `src/lib/normalize.ts`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `interface ThreadSnapshot { threadId: string; from: string; subject: string; listId: string | null; attachments: string[]; bodyText: string; internalDateMs: number }`, `interface NormalizedEmail { threadId: string; fromAddr: string; fromDomain: string; subject: string; listId: string | null; attachments: string[]; bodyExcerpt: string; internalDateMs: number }`, `normalize(s: ThreadSnapshot): NormalizedEmail`, `extractAddr(header: string): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalize, extractAddr } from "@/lib/normalize";

const base = {
  threadId: "t1", from: "Jane Doe <JANE@Acme.com>", subject: "[EXTERNAL] cancellation request",
  listId: null, attachments: ["BOP-LPR-signed.pdf"],
  bodyText: "Please  cancel\r\n\r\n\r\nthe policy.  " + "x".repeat(3000),
  internalDateMs: 1_754_400_000_000,
};

describe("normalize", () => {
  it("extracts and lowercases the bare address and domain", () => {
    const n = normalize(base);
    expect(n.fromAddr).toBe("jane@acme.com");
    expect(n.fromDomain).toBe("acme.com");
  });
  it("handles bare addresses without angle brackets", () => {
    expect(extractAddr("  pro@agency.example ")).toBe("pro@agency.example");
  });
  it("collapses whitespace and caps body excerpt at 1200 chars", () => {
    const n = normalize(base);
    expect(n.bodyExcerpt.length).toBeLessThanOrEqual(1200);
    expect(n.bodyExcerpt).not.toMatch(/\r|\n{3,}| {2,}/);
  });
  it("passes through subject, listId, attachments, dates", () => {
    const n = normalize(base);
    expect(n.subject).toBe(base.subject);
    expect(n.attachments).toEqual(["BOP-LPR-signed.pdf"]);
    expect(n.internalDateMs).toBe(base.internalDateMs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/normalize.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/normalize.ts`:

```ts
export interface ThreadSnapshot {
  threadId: string;
  from: string;
  subject: string;
  listId: string | null;
  attachments: string[];
  bodyText: string;
  internalDateMs: number;
}

export interface NormalizedEmail {
  threadId: string;
  fromAddr: string;
  fromDomain: string;
  subject: string;
  listId: string | null;
  attachments: string[];
  bodyExcerpt: string;
  internalDateMs: number;
}

const BODY_CHARS = 1200;

export function extractAddr(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

function cleanBody(s: string): string {
  return s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalize(s: ThreadSnapshot): NormalizedEmail {
  const fromAddr = extractAddr(s.from);
  return {
    threadId: s.threadId,
    fromAddr,
    fromDomain: fromAddr.includes("@") ? fromAddr.split("@").pop()! : fromAddr,
    subject: s.subject,
    listId: s.listId,
    attachments: s.attachments,
    bodyExcerpt: cleanBody(s.bodyText).slice(0, BODY_CHARS),
    internalDateMs: s.internalDateMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/normalize.test.ts` — Expected: PASS.

```bash
git add src/lib/normalize.ts tests/normalize.test.ts
git commit -m "feat: thread snapshot normalization"
```

---

### Task 5: Rules engine

**Files:**
- Create: `src/lib/rules.ts`
- Test: `tests/rules.test.ts`

**Interfaces:**
- Consumes: `NormalizedEmail` from Task 4.
- Produces: `interface Rule { id: number; patternType: "sender_exact"|"sender_domain"|"list_id"|"subject_template"; pattern: string; labels: string[]; forwardTo: string | null; complete: boolean }`, `interface RuleOutcome { hits: Rule[]; labels: string[]; forwards: string[]; complete: boolean }`, `matchRules(email: NormalizedEmail, rules: Rule[]): RuleOutcome`, `loadActiveRules(db: Querier): Promise<Rule[]>`, `applyStructuralRules(labels: string[]): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchRules, applyStructuralRules, type Rule } from "@/lib/rules";
import { normalize } from "@/lib/normalize";

const rules: Rule[] = [
  { id: 1, patternType: "sender_domain", pattern: "dxc.com", labels: ["3-KR", "3-KR/DOCS&NOTICE"], forwardTo: null, complete: true },
  { id: 2, patternType: "subject_template", pattern: "USLI Renewal Quote", labels: ["6-RENEWAL QUOTE-USLI"], forwardTo: null, complete: true },
  { id: 3, patternType: "sender_exact", pattern: "quit@agency.example", labels: ["disregard"], forwardTo: null, complete: true },
  { id: 4, patternType: "sender_domain", pattern: "granadainsurance.com", labels: ["Billing"], forwardTo: "invoice@agency.example", complete: false },
];

function email(from: string, subject = "hello", listId: string | null = null) {
  return normalize({ threadId: "t", from, subject, listId, attachments: [], bodyText: "", internalDateMs: 0 });
}

describe("matchRules", () => {
  it("matches by sender domain and reports complete", () => {
    const r = matchRules(email("ny_agent_copy@dxc.com"), rules);
    expect(r.labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
    expect(r.complete).toBe(true);
  });
  it("matches subject template as case-insensitive prefix (ignoring [EXTERNAL] etc.)", () => {
    const r = matchRules(email("a@b.com", "[EXTERNAL] USLI Renewal Quote for X"), rules);
    expect(r.labels).toContain("6-RENEWAL QUOTE-USLI");
  });
  it("partial rules never report complete", () => {
    const r = matchRules(email("billing@granadainsurance.com"), rules);
    expect(r.complete).toBe(false);
    expect(r.forwards).toEqual(["invoice@agency.example"]);
  });
  it("no match yields empty incomplete outcome", () => {
    const r = matchRules(email("someone@unknown.com"), rules);
    expect(r.hits).toEqual([]);
    expect(r.complete).toBe(false);
  });
});

describe("applyStructuralRules", () => {
  it("Cancelllation co-emits 3-KR/DOCS&NOTICE (spec 4.2)", () => {
    expect(applyStructuralRules(["Cancelllation"]).sort()).toEqual(["3-KR/DOCS&NOTICE", "Cancelllation"].sort());
  });
  it("is idempotent and preserves other labels", () => {
    const once = applyStructuralRules(["Cancelllation", "3-KR"]);
    expect(applyStructuralRules(once)).toEqual(once);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rules.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/rules.ts`:

```ts
import type { Querier } from "./db";
import type { NormalizedEmail } from "./normalize";

export interface Rule {
  id: number;
  patternType: "sender_exact" | "sender_domain" | "list_id" | "subject_template";
  pattern: string;
  labels: string[];
  forwardTo: string | null;
  complete: boolean;
}

export interface RuleOutcome {
  hits: Rule[];
  labels: string[];
  forwards: string[];
  complete: boolean;
}

function subjectCore(subject: string): string {
  // strip bracketed prefixes like [EXTERNAL] and Fwd:/Re: chains
  return subject.replace(/^(\s*(\[[^\]]+\]|fwd?:|re:)\s*)+/i, "").trim();
}

export function matchRules(email: NormalizedEmail, rules: Rule[]): RuleOutcome {
  const hits = rules.filter((r) => {
    switch (r.patternType) {
      case "sender_exact": return email.fromAddr === r.pattern.toLowerCase();
      case "sender_domain": return email.fromDomain === r.pattern.toLowerCase();
      case "list_id": return (email.listId ?? "").toLowerCase().includes(r.pattern.toLowerCase());
      case "subject_template":
        return subjectCore(email.subject).toLowerCase().startsWith(r.pattern.toLowerCase());
    }
  });
  const labels = [...new Set(hits.flatMap((h) => h.labels))];
  const forwards = [...new Set(hits.map((h) => h.forwardTo).filter((f): f is string => !!f))];
  return { hits, labels, forwards, complete: hits.length > 0 && hits.every((h) => h.complete) };
}

// Structural taxonomy rules confirmed by Phase 0 (spec 4.2): a carrier
// cancellation notice is also a carrier document delivery.
export function applyStructuralRules(labels: string[]): string[] {
  const out = new Set(labels);
  if (out.has("Cancelllation")) out.add("3-KR/DOCS&NOTICE");
  return [...out];
}

export async function loadActiveRules(db: Querier): Promise<Rule[]> {
  const { rows } = await db.query(
    `select id, pattern_type, pattern, label_set, forward_to, complete from rules where active`
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    patternType: r.pattern_type,
    pattern: r.pattern,
    labels: typeof r.label_set === "string" ? JSON.parse(r.label_set) : r.label_set,
    forwardTo: r.forward_to,
    complete: r.complete,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/rules.test.ts` — Expected: PASS (6 tests).

```bash
git add src/lib/rules.ts tests/rules.test.ts
git commit -m "feat: rules engine with structural co-emit rule"
```

---

### Task 6: Rule seeding from Phase 0 analysis

**Files:**
- Create: `scripts/seed-rules.ts`, `src/lib/seed.ts`
- Test: `tests/seed.test.ts`

**Interfaces:**
- Consumes: `Querier` (Task 2); Phase 0 `stats.json` shape: `{ rule_candidates: { sender_domain_labelset: Candidate[], sender_exact_labelset: Candidate[], list_id_labelset: Candidate[] } }` where `Candidate = { key: string, n: number, top_label: string, purity: number }` and `top_label` is labels joined by `" + "`.
- Produces: `extractSeedRules(stats: any): SeedRule[]` and `seedRules(db: Querier, seeds: SeedRule[]): Promise<number>` with `SeedRule = { patternType: Rule["patternType"]; pattern: string; labels: string[]; purity: number; support: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/seed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractSeedRules } from "@/lib/seed";

const stats = {
  rule_candidates: {
    sender_domain_labelset: [
      { key: "dxc.com", n: 160, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 0.994 },
      { key: "attuneinsurance.com", n: 33, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 0.758 }, // below 0.9
      { key: "enews.wealthmanagement.com", n: 20, top_label: "(done/disregard only)", purity: 1.0 }, // sentinel
      { key: "smallco.com", n: 4, top_label: "2-NY", purity: 1.0 }, // below support
    ],
    sender_exact_labelset: [
      { key: "policyprocessing@usli.com", n: 19, top_label: "3-KR + 3-KR/DOCS&NOTICE", purity: 1.0 },
      { key: "flaky@x.com", n: 6, top_label: "2-NY", purity: 0.9 }, // below 0.95 exact threshold
    ],
    list_id_labelset: [
      { key: "<quit.agency.example>", n: 68, top_label: "disregard", purity: 0.985 },
    ],
  },
};

describe("extractSeedRules", () => {
  it("applies spec 4.2 thresholds and skips sentinel label-sets", () => {
    const seeds = extractSeedRules(stats);
    const patterns = seeds.map((s) => s.pattern);
    expect(patterns).toContain("dxc.com");
    expect(patterns).toContain("policyprocessing@usli.com");
    expect(patterns).toContain("<quit.agency.example>");
    expect(patterns).not.toContain("attuneinsurance.com");
    expect(patterns).not.toContain("smallco.com");
    expect(patterns).not.toContain("flaky@x.com");
    expect(patterns).not.toContain("enews.wealthmanagement.com");
  });
  it("splits label sets on ' + '", () => {
    const dxc = extractSeedRules(stats).find((s) => s.pattern === "dxc.com")!;
    expect(dxc.labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seed.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/seed.ts`:

```ts
import type { Querier } from "./db";
import { ALL_LABELS } from "./labels";
import type { Rule } from "./rules";

export interface SeedRule {
  patternType: Rule["patternType"];
  pattern: string;
  labels: string[];
  purity: number;
  support: number;
}

const KNOWN = new Set<string>(ALL_LABELS);

function parseLabels(topLabel: string): string[] | null {
  const labels = topLabel.split(" + ").map((s) => s.trim());
  // sentinel buckets like "(unlabeled)" / "(done/disregard only)" are not real labels
  return labels.every((l) => KNOWN.has(l)) ? labels : null;
}

export function extractSeedRules(stats: any): SeedRule[] {
  const out: SeedRule[] = [];
  const groups: Array<[Rule["patternType"], any[], number, number]> = [
    ["sender_domain", stats.rule_candidates?.sender_domain_labelset ?? [], 0.9, 10],
    ["sender_exact", stats.rule_candidates?.sender_exact_labelset ?? [], 0.95, 5],
    ["list_id", stats.rule_candidates?.list_id_labelset ?? [], 0.9, 5],
  ];
  for (const [patternType, candidates, minPurity, minSupport] of groups) {
    for (const c of candidates) {
      if (c.purity < minPurity || c.n < minSupport) continue;
      const labels = parseLabels(c.top_label);
      if (!labels) continue;
      out.push({ patternType, pattern: c.key, labels, purity: c.purity, support: c.n });
    }
  }
  return out;
}

export async function seedRules(db: Querier, seeds: SeedRule[]): Promise<number> {
  let inserted = 0;
  for (const s of seeds) {
    const res = await db.query(
      `insert into rules (pattern_type, pattern, label_set, complete, purity, support, source)
       values ($1, $2, $3, true, $4, $5, 'phase0')
       on conflict (pattern_type, pattern) do nothing
       returning id`,
      [s.patternType, s.pattern, JSON.stringify(s.labels), s.purity, s.support]
    );
    inserted += res.rows.length;
  }
  return inserted;
}
```

Create `scripts/seed-rules.ts`:

```ts
import { readFileSync } from "node:fs";
import { getDb } from "../src/lib/db";
import { runMigrations } from "../src/lib/migrate";
import { extractSeedRules, seedRules } from "../src/lib/seed";

async function main() {
  const statsPath = process.argv[2] ?? "phase0/analysis/stats.json";
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  const db = getDb();
  await runMigrations(db);
  const seeds = extractSeedRules(stats);
  const n = await seedRules(db, seeds);
  console.log(`seeded ${n} new rules (${seeds.length} candidates met thresholds)`);
}
main().then(() => process.exit(0));
```

Add script to `package.json`: `"seed-rules": "npx tsx scripts/seed-rules.ts"` and `npm i -D tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/seed.test.ts` — Expected: PASS. Also dry-run against real data: `DATABASE_URL=<local or skip> npx tsx scripts/seed-rules.ts phase0/analysis/stats.json` (optional here; runs for real in Task 12).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seed.ts scripts/seed-rules.ts tests/seed.test.ts package.json package-lock.json
git commit -m "feat: rule seeding from phase0 high-purity tables"
```

---

### Task 7: Gmail client (DWD)

**Files:**
- Create: `src/lib/gmail.ts`, `scripts/probe-gmail.ts`
- Test: `tests/gmail.test.ts`

**Interfaces:**
- Consumes: `ThreadSnapshot` shape from Task 4.
- Produces: `makeGmail(auth?): GmailClient` with `interface GmailClient { listNewThreads(sinceMs: number): Promise<ThreadSnapshot[]>; applyLabels(threadId: string, labelNames: string[]): Promise<void>; forward(threadId: string, to: string): Promise<void>; sendAlert(to: string, subject: string, body: string): Promise<void> }`; pure helpers `buildQuery(sinceMs: number): string` and `buildForwardRaw(opts: { to: string; from: string; subject: string; comment: string; originalRawB64url: string }): string`.

- [ ] **Step 1: Write the failing test (pure helpers only — API calls are covered by the live probe)**

Create `tests/gmail.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildQuery, buildForwardRaw } from "@/lib/gmail";

describe("buildQuery", () => {
  it("converts ms checkpoint to epoch-seconds after: with 1s overlap", () => {
    // 1_754_400_123_456 ms -> 1_754_400_123 s; overlap-1 => after:1754400122
    expect(buildQuery(1_754_400_123_456)).toBe("after:1754400122 -in:spam -in:trash");
  });
});

describe("buildForwardRaw", () => {
  it("builds base64url multipart MIME with the original attached as message/rfc822", () => {
    const raw = buildForwardRaw({
      to: "invoice@agency.example", from: "pro@agency.example", subject: "Fwd: March invoice",
      comment: "Auto-forwarded by triage.", originalRawB64url: Buffer.from("MIME-orig").toString("base64url"),
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: invoice@agency.example");
    expect(decoded).toContain("From: pro@agency.example");
    expect(decoded).toContain("Subject: Fwd: March invoice");
    expect(decoded).toContain("Content-Type: message/rfc822");
    expect(decoded).toContain("MIME-orig");
    expect(raw).not.toMatch(/[+/=]/); // base64url, not base64
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gmail.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/gmail.ts`:

```ts
import { google, type gmail_v1 } from "googleapis";
import type { ThreadSnapshot } from "./normalize";

export function buildQuery(sinceMs: number): string {
  return `after:${Math.floor(sinceMs / 1000) - 1} -in:spam -in:trash`;
}

export function buildForwardRaw(opts: {
  to: string; from: string; subject: string; comment: string; originalRawB64url: string;
}): string {
  const boundary = "triage-fwd-boundary";
  const original = Buffer.from(opts.originalRawB64url, "base64url").toString("utf8");
  const mime = [
    `From: ${opts.from}`, `To: ${opts.to}`, `Subject: ${opts.subject}`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", opts.comment, "",
    `--${boundary}`, "Content-Type: message/rfc822", "Content-Disposition: attachment", "",
    original, `--${boundary}--`, "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function authClient() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SA_EMAIL,
    key: process.env.GOOGLE_SA_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    subject: process.env.GMAIL_USER, // impersonate pro@agency.example via DWD
  });
}

export interface GmailClient {
  listNewThreads(sinceMs: number): Promise<ThreadSnapshot[]>;
  applyLabels(threadId: string, labelNames: string[]): Promise<void>;
  forward(threadId: string, to: string): Promise<void>;
  sendAlert(to: string, subject: string, body: string): Promise<void>;
}

export function makeGmail(api?: gmail_v1.Gmail): GmailClient {
  const gmail = api ?? google.gmail({ version: "v1", auth: authClient() });
  let labelMap: Map<string, string> | null = null; // name -> id

  async function labelIds(names: string[]): Promise<string[]> {
    if (!labelMap) {
      const { data } = await gmail.users.labels.list({ userId: "me" });
      labelMap = new Map((data.labels ?? []).map((l) => [l.name!, l.id!]));
    }
    return names.map((n) => {
      const id = labelMap!.get(n);
      if (!id) throw new Error(`unknown Gmail label: ${n}`);
      return id;
    });
  }

  return {
    async listNewThreads(sinceMs) {
      const out: ThreadSnapshot[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await gmail.users.threads.list({
          userId: "me", q: buildQuery(sinceMs), maxResults: 100, pageToken,
        });
        for (const t of data.threads ?? []) {
          const { data: full } = await gmail.users.threads.get({ userId: "me", id: t.id!, format: "full" });
          const first = full.messages?.[0];
          if (!first) continue;
          const h = (name: string) =>
            first.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
          out.push({
            threadId: t.id!,
            from: h("From"),
            subject: h("Subject"),
            listId: h("List-Id") || null,
            attachments: collectFilenames(first.payload),
            bodyText: collectText(first.payload),
            internalDateMs: Number(first.internalDate ?? 0),
          });
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    },

    async applyLabels(threadId, labelNames) {
      await gmail.users.threads.modify({
        userId: "me", id: threadId, requestBody: { addLabelIds: await labelIds(labelNames) },
      });
    },

    async forward(threadId, to) {
      const { data: full } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      const first = full.messages?.[0];
      if (!first?.id) throw new Error(`thread ${threadId} has no messages`);
      const { data: rawMsg } = await gmail.users.messages.get({ userId: "me", id: first.id, format: "raw" });
      const subject =
        first.payload?.headers?.find((x) => x.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
      const raw = buildForwardRaw({
        to, from: process.env.GMAIL_USER!, subject: `Fwd: ${subject}`,
        comment: "Auto-forwarded by triage.", originalRawB64url: rawMsg.raw!,
      });
      await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
    },

    async sendAlert(to, subject, body) {
      const mime = [`From: ${process.env.GMAIL_USER}`, `To: ${to}`, `Subject: ${subject}`, "", body].join("\r\n");
      await gmail.users.messages.send({
        userId: "me", requestBody: { raw: Buffer.from(mime, "utf8").toString("base64url") },
      });
    },
  };
}

// Byte-array vs base64 lesson from Phase 0 does not apply here (googleapis returns
// base64url strings) — but decode defensively and never let one bad part throw.
function collectText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const stack = [payload]; let plain = ""; let html = "";
  while (stack.length) {
    const p = stack.pop()!;
    if (p.mimeType === "message/rfc822") continue;
    for (const c of p.parts ?? []) stack.push(c);
    if (p.body?.data && !p.filename) {
      const text = Buffer.from(p.body.data, "base64url").toString("utf8");
      if (!plain && p.mimeType === "text/plain") plain = text;
      else if (!html && p.mimeType === "text/html") html = text;
    }
  }
  return plain || html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function collectFilenames(payload: gmail_v1.Schema$MessagePart | undefined): string[] {
  if (!payload) return [];
  const out: string[] = []; const stack = [payload];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of p.parts ?? []) stack.push(c);
    if (p.filename) out.push(p.filename);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gmail.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the live probe (run later, after DWD setup in Task 12)**

Create `scripts/probe-gmail.ts`:

```ts
import { makeGmail } from "../src/lib/gmail";

async function main() {
  const gmail = makeGmail();
  const since = Date.now() - 60 * 60 * 1000;
  const threads = await gmail.listNewThreads(since);
  console.log(`PROBE OK: ${threads.length} thread(s) in the last hour`);
  for (const t of threads.slice(0, 3))
    console.log(`- ${t.threadId} | ${t.from} | ${t.subject.slice(0, 60)} | body ${t.bodyText.length} chars`);
  if (threads.some((t) => !t.bodyText)) console.warn("WARNING: empty body detected — investigate before shadow mode");
}
main().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
```

Add script: `"probe-gmail": "npx tsx scripts/probe-gmail.ts"`. Do NOT run yet (needs DWD, Task 12).

- [ ] **Step 6: Commit**

```bash
git add src/lib/gmail.ts scripts/probe-gmail.ts tests/gmail.test.ts package.json
git commit -m "feat: Gmail DWD client with pure query/forward builders and live probe"
```

---

### Task 8: Gemini classifier

**Files:**
- Create: `src/lib/classify.ts`, `src/lib/prompt.ts`, `scripts/probe-gemini.ts`
- Test: `tests/classify.test.ts`

**Interfaces:**
- Consumes: `NormalizedEmail` (Task 4), `RuleOutcome` (Task 5), `CLASSIFIABLE_LABELS` / `DESK_ALIASES` (Task 3).
- Produces: `ClassificationSchema` (zod), `type Classification = { tasks: { labels: string[]; forward_to: string }[]; confidence: "high"|"medium"|"low"; rationale: string }`, `makeClassifier(model?: ClassifierModel): (email: NormalizedEmail, ruleEvidence: RuleOutcome) => Promise<Classification>` where `ClassifierModel = { invoke(messages: [string, string][]): Promise<unknown> }` (the LangChain structured-output runnable satisfies it; tests inject a fake).

- [ ] **Step 1: Write the failing test**

Create `tests/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeClassifier, ClassificationSchema } from "@/lib/classify";
import { normalize } from "@/lib/normalize";

const email = normalize({
  threadId: "t", from: "vicky@oakmont.com", subject: "cancellation request",
  listId: null, attachments: ["LPR.pdf"], bodyText: "Please cancel effective 6/30 and update mailing address.",
  internalDateMs: 0,
});
const noRules = { hits: [], labels: [], forwards: [], complete: false };

describe("classifier", () => {
  it("returns schema-valid output from the model", async () => {
    const fake = { invoke: async () => ({
      tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "high", rationale: "cancel + LPR",
    }) };
    const c = await makeClassifier(fake)(email, noRules);
    expect(c.tasks[0].labels).toEqual(["4-CAN REQ"]);
    expect(c.confidence).toBe("high");
  });

  it("retries once on failure, then throws", async () => {
    let calls = 0;
    const flaky = { invoke: async () => { calls++; throw new Error("boom"); } };
    await expect(makeClassifier(flaky)(email, noRules)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });

  it("rejects labels outside the classifiable vocabulary", () => {
    const bad = { tasks: [{ labels: ["*1-DONE/DONE-P4"], forward_to: "none" }], confidence: "high", rationale: "" };
    expect(() => ClassificationSchema.parse(bad)).toThrow();
  });

  it("rejects forward targets outside desk aliases", () => {
    const bad = { tasks: [{ labels: ["Billing"], forward_to: "vy@agency.example" }], confidence: "high", rationale: "" };
    expect(() => ClassificationSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/classify.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement prompt and classifier**

Create `src/lib/prompt.ts` (definitions condensed from Phase 0 qualitative characterization — `phase0/analysis/` and the design-review synthesis):

```ts
export const TAXONOMY_PROMPT = `You triage inbound email for pro@agency.example, the operations intake
mailbox of AGY, an insurance agency (NY front office; KR back-office processing center).
Assign every email one or more Gmail labels (exact names, verbatim) and, when the label's desk
convention requires it, a forward target. Multi-request emails get one task per request.

Label guide (queue labels only — never DONE-family labels):
- "3-KR" + "3-KR/DOCS&NOTICE": machine-generated carrier document deliveries for filing (DXC/DB
  agent-copy prints, AmTrust/Hartford/CNA/Employers/NGIC reports, USLI issued-policy PDFs).
- "Cancelllation" (spelling is intentional): a CARRIER-issued cancellation notice/endorsement.
  Also add "3-KR/DOCS&NOTICE".
- "4-CAN REQ" (+ "3-KR"): a retail BROKER asks AGY to cancel a policy; usually a signed LPR/ACORD.
- "7-Loss Run Req" (+ "3-KR"): broker requests loss runs / claims history.
- "8-C-105.2" (+ "3-KR"): NY Workers Comp form C-105.2 / wall poster / WC certificate requests
  (WC policy prefixes: TWC/KWC/WWC/SWC).
- "3-KR/POLICY REQUEST" (+ "3-KR"): broker asks for a COPY of an existing document (dec page,
  full policy, renewal copy, binder).
- "2-NY/Endorsement" or "3-Endorsement": broker asks to CHANGE a policy (mortgagee clause,
  address, add/remove entity or AI, coverage, payment plan). NHO homeowners book -> "2-NY/Endorsement"
  with forward express@agency.example; DP/CP commercial book -> "3-Endorsement" + "3-KR".
- "2-NY/Recommendation" (+ "2-NY"): loss-control recommendation compliance — premises photos,
  signed rec letters, replies to AGY underwriting-cancellation enforcement notices.
- "6-RENEWAL QUOTE-USLI" or "3-KR/USLI RENEWAL QUOTE": USLI renewal quote deliveries/reminders
  (subject "USLI Renewal Quote for ..." with Applicant/Retailer/Customer PDFs).
- "2-NY": front-office judgment work — new business quoting (USLI Instant Quote mail), carrier
  underwriter correspondence, misc NY-book service.
- "Billing": money matters, usually alongside another label. Carrier invoices/statements ->
  forward invoice@agency.example; broker/insured payment matters -> forward accounting@agency.example.
- "disregard": newsletters, marketing, OOO/holiday notices, ex-employee alias mail — no action.
- "Undelivered Email": bounces/NDRs of AGY's own outbound notices.
Rare labels you may use when clearly applicable: "5-UW", "Forward to EHA", "ONLY UPDATE EPIC",
"disregard/confirmed done in EPIC", "0- NY Pro Training", "1- NY to F/up", "P10-double check",
"STAFF-P12", "Y".

Confidence: "high" only when a typical dispatcher would certainly agree; "medium" when plausible
alternatives exist; "low" when genuinely unsure. Uncertain mail goes to human review — prefer
honest "medium"/"low" over guessed "high".`;

export function emailPrompt(e: {
  fromAddr: string; subject: string; listId: string | null; attachments: string[]; bodyExcerpt: string;
}, ruleEvidence: { labels: string[] }): string {
  return [
    `From: ${e.fromAddr}`, `Subject: ${e.subject}`, `List-Id: ${e.listId ?? "(none)"}`,
    `Attachments: ${e.attachments.join(", ") || "(none)"}`,
    ruleEvidence.labels.length ? `Deterministic rules already suggest: ${ruleEvidence.labels.join(", ")}` : "",
    ``, `Body:`, e.bodyExcerpt || "(empty)",
  ].filter(Boolean).join("\n");
}
```

Create `src/lib/classify.ts`:

```ts
import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { CLASSIFIABLE_LABELS, DESK_ALIASES } from "./labels";
import type { NormalizedEmail } from "./normalize";
import type { RuleOutcome } from "./rules";
import { TAXONOMY_PROMPT, emailPrompt } from "./prompt";

const labelEnum = z.enum(CLASSIFIABLE_LABELS as [string, ...string[]]);
const forwardEnum = z.enum([...DESK_ALIASES, "none"] as [string, ...string[]]);

export const ClassificationSchema = z.object({
  tasks: z.array(z.object({ labels: z.array(labelEnum).min(1), forward_to: forwardEnum })).min(1),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassifierModel {
  invoke(messages: [string, string][]): Promise<unknown>;
}

function defaultModel(): ClassifierModel {
  const llm = new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
    temperature: 0,
    apiKey: process.env.GEMINI_API_KEY,
  });
  return llm.withStructuredOutput(ClassificationSchema) as unknown as ClassifierModel;
}

export function makeClassifier(model?: ClassifierModel) {
  const m = model ?? defaultModel();
  return async (email: NormalizedEmail, ruleEvidence: RuleOutcome): Promise<Classification> => {
    const messages: [string, string][] = [
      ["system", TAXONOMY_PROMPT],
      ["human", emailPrompt(email, ruleEvidence)],
    ];
    try {
      return ClassificationSchema.parse(await m.invoke(messages));
    } catch {
      return ClassificationSchema.parse(await m.invoke(messages)); // one retry, then throw
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/classify.test.ts` — Expected: PASS (4 tests).

- [ ] **Step 5: Write the live probe (verifies real model ID + structured output)**

Create `scripts/probe-gemini.ts`:

```ts
import { makeClassifier } from "../src/lib/classify";

async function main() {
  const classify = makeClassifier();
  const result = await classify(
    { threadId: "probe", fromAddr: "vicky@oakmontins.com", fromDomain: "oakmontins.com",
      subject: "cancellation request for MY NY Leading Company LLC", listId: null,
      attachments: ["BOP-LPR-signed.pdf"],
      bodyExcerpt: "Please update the mailing address and cancel the policy effective 6/30/2026. Attach signed LPR.",
      internalDateMs: 0 },
    { hits: [], labels: [], forwards: [], complete: false }
  );
  console.log("PROBE OK:", JSON.stringify(result, null, 2));
  if (result.tasks.length < 2) console.warn("NOTE: expected 2 tasks (endorsement + cancellation) — check prompt quality");
}
main().catch((e) => { console.error("PROBE FAILED (check GEMINI_MODEL id / GEMINI_API_KEY):", e.message); process.exit(1); });
```

Add script `"probe-gemini": "npx tsx scripts/probe-gemini.ts"`. Run now if `GEMINI_API_KEY` is available locally: expected — valid Classification JSON. If it fails on model name, list valid IDs per current Gemini docs and set `GEMINI_MODEL` accordingly; do not hardcode a guess.

- [ ] **Step 6: Commit**

```bash
git add src/lib/classify.ts src/lib/prompt.ts scripts/probe-gemini.ts tests/classify.test.ts package.json
git commit -m "feat: Gemini classifier with schema-enforced multi-label output"
```

---

### Task 9: Decide logic and decision persistence

**Files:**
- Create: `src/lib/decide.ts`
- Test: `tests/decide.test.ts`

**Interfaces:**
- Consumes: `RuleOutcome`, `applyStructuralRules` (Task 5), `Classification` (Task 8), `AppConfig` (Task 3), `Querier` (Task 2), `NormalizedEmail` (Task 4).
- Produces: `interface TriageTask { labels: string[]; forwardTo: string | null }`, `interface Decision { tasks: TriageTask[]; confidence: "high"|"medium"|"low"|"rule"; status: "decided"|"needs_review"; actionsPlanned: Action[] }`, `type Action = { kind: "labels"; labels: string[] } | { kind: "forward"; to: string }`, `decide(rule: RuleOutcome, llm: Classification | null, cfg: AppConfig): Decision`, `recordDecision(db, email, rule, llm, decision, stage): Promise<number>` (returns decision id; also upserts `threads`).

- [ ] **Step 1: Write the failing test**

Create `tests/decide.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { decide, recordDecision } from "@/lib/decide";
import { normalize } from "@/lib/normalize";

const cfg = { stage: "shadow" as const, autoActLabels: ["3-KR", "3-KR/DOCS&NOTICE", "4-CAN REQ", "Cancelllation"] };
const noRules = { hits: [], labels: [], forwards: [], complete: false };

describe("decide", () => {
  it("complete rule hit decides without LLM at rule confidence", () => {
    const d = decide({ hits: [{} as any], labels: ["3-KR", "3-KR/DOCS&NOTICE"], forwards: [], complete: true }, null, cfg);
    expect(d.status).toBe("decided");
    expect(d.confidence).toBe("rule");
    expect(d.tasks[0].labels.sort()).toEqual(["3-KR", "3-KR/DOCS&NOTICE"]);
  });

  it("high-confidence LLM output within autoActLabels decides", () => {
    const d = decide(noRules, { tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("decided");
    expect(d.actionsPlanned).toEqual([{ kind: "labels", labels: ["4-CAN REQ"] }]);
  });

  it("medium/low confidence routes to review", () => {
    const d = decide(noRules, { tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "medium", rationale: "" }, cfg);
    expect(d.status).toBe("needs_review");
    expect(d.actionsPlanned).toEqual([]);
  });

  it("labels outside autoActLabels route to review even at high confidence", () => {
    const d = decide(noRules, { tasks: [{ labels: ["5-UW"], forward_to: "none" }], confidence: "high", rationale: "" }, cfg);
    expect(d.status).toBe("needs_review");
  });

  it("applies the structural co-emit and plans forwards per task", () => {
    const d = decide(noRules, { tasks: [{ labels: ["Cancelllation"], forward_to: "invoice@agency.example" }], confidence: "high", rationale: "" }, cfg);
    expect(d.tasks[0].labels).toContain("3-KR/DOCS&NOTICE");
    expect(d.actionsPlanned).toContainEqual({ kind: "forward", to: "invoice@agency.example" });
  });

  it("null LLM output (classifier failure) routes to review", () => {
    const d = decide(noRules, null, cfg);
    expect(d.status).toBe("needs_review");
  });
});

describe("recordDecision", () => {
  beforeAll(async () => {
    const p = new PGlite();
    setDb({ query: (sql, params) => p.query(sql, params as any[]) as any });
    await runMigrations(getDb());
  });

  it("upserts thread and writes a decision row", async () => {
    const email = normalize({ threadId: "t9", from: "a@b.com", subject: "s", listId: null, attachments: [], bodyText: "b", internalDateMs: 5 });
    const d = decide(noRules, null, cfg);
    const id = await recordDecision(getDb(), email, noRules, null, d, "shadow");
    const { rows } = await getDb().query(`select * from decisions where id = $1`, [id]);
    expect(rows[0].status).toBe("needs_review");
    expect(rows[0].stage).toBe("shadow");
    const t = await getDb().query(`select * from threads where thread_id = 't9'`);
    expect(t.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decide.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/decide.ts`:

```ts
import type { Querier } from "./db";
import type { NormalizedEmail } from "./normalize";
import { applyStructuralRules, type RuleOutcome } from "./rules";
import type { Classification } from "./classify";
import type { AppConfig } from "./config";

export interface TriageTask { labels: string[]; forwardTo: string | null }
export type Action = { kind: "labels"; labels: string[] } | { kind: "forward"; to: string };
export interface Decision {
  tasks: TriageTask[];
  confidence: "high" | "medium" | "low" | "rule";
  status: "decided" | "needs_review";
  actionsPlanned: Action[];
}

function planActions(tasks: TriageTask[]): Action[] {
  const labels = [...new Set(tasks.flatMap((t) => t.labels))];
  const actions: Action[] = labels.length ? [{ kind: "labels", labels }] : [];
  for (const t of tasks) if (t.forwardTo) actions.push({ kind: "forward", to: t.forwardTo });
  return actions;
}

export function decide(rule: RuleOutcome, llm: Classification | null, cfg: AppConfig): Decision {
  if (rule.complete) {
    const tasks: TriageTask[] = [{ labels: applyStructuralRules(rule.labels), forwardTo: rule.forwards[0] ?? null }];
    return { tasks, confidence: "rule", status: "decided", actionsPlanned: planActions(tasks) };
  }
  if (!llm) return { tasks: [], confidence: "low", status: "needs_review", actionsPlanned: [] };

  const tasks: TriageTask[] = llm.tasks.map((t) => ({
    labels: applyStructuralRules([...new Set([...t.labels, ...rule.labels])]),
    forwardTo: t.forward_to === "none" ? null : t.forward_to,
  }));
  const allowed = new Set(cfg.autoActLabels);
  const eligible = llm.confidence === "high" && tasks.every((t) => t.labels.every((l) => allowed.has(l)));
  return {
    tasks,
    confidence: llm.confidence,
    status: eligible ? "decided" : "needs_review",
    actionsPlanned: eligible ? planActions(tasks) : [],
  };
}

export async function recordDecision(
  db: Querier, email: NormalizedEmail, rule: RuleOutcome,
  llm: Classification | null, decision: Decision, stage: string
): Promise<number> {
  await db.query(
    `insert into threads (thread_id, from_addr, subject, attachments, list_id, body_excerpt, internal_date_ms)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (thread_id) do nothing`,
    [email.threadId, email.fromAddr, email.subject, JSON.stringify(email.attachments),
     email.listId, email.bodyExcerpt, email.internalDateMs]
  );
  const { rows } = await db.query(
    `insert into decisions (thread_id, stage, rule_hits, llm_output, final_tasks, confidence, status, actions_planned)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [email.threadId, stage, JSON.stringify(rule.hits.map((h) => h.id ?? null)),
     llm ? JSON.stringify(llm) : null, JSON.stringify(decision.tasks),
     decision.confidence, decision.status, JSON.stringify(decision.actionsPlanned)]
  );
  return Number(rows[0].id);
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/decide.test.ts` — Expected: PASS (7 tests).

```bash
git add src/lib/decide.ts tests/decide.test.ts
git commit -m "feat: decide logic with auto-act gating and decision persistence"
```

---

### Task 10: Act layer (stage gating + idempotency)

**Files:**
- Create: `src/lib/act.ts`
- Test: `tests/act.test.ts`

**Interfaces:**
- Consumes: `GmailClient` (Task 7), `Querier` (Task 2), `Action` (Task 9), `AppConfig` (Task 3).
- Produces: `executeDecision(db: Querier, gmail: GmailClient, decisionId: number, cfg: AppConfig): Promise<void>` — reads the decision row, executes permitted-and-unexecuted actions, records each in `actions_executed` immediately after success, sets final status.

- [ ] **Step 1: Write the failing test**

Create `tests/act.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { executeDecision } from "@/lib/act";
import { recordDecision, decide } from "@/lib/decide";
import { normalize } from "@/lib/normalize";
import type { GmailClient } from "@/lib/gmail";

function fakeGmail() {
  const calls: string[] = [];
  const g: GmailClient = {
    listNewThreads: async () => [],
    applyLabels: async (id, labels) => { calls.push(`labels:${id}:${labels.sort().join("|")}`); },
    forward: async (id, to) => { calls.push(`forward:${id}:${to}`); },
    sendAlert: async () => { calls.push("alert"); },
  };
  return { g, calls };
}

const highDecision = () =>
  decide({ hits: [], labels: [], forwards: [], complete: false },
    { tasks: [{ labels: ["4-CAN REQ"], forward_to: "invoice@agency.example" }], confidence: "high", rationale: "" },
    { stage: "shadow", autoActLabels: ["4-CAN REQ", "3-KR/DOCS&NOTICE"] });

async function seed(threadId: string) {
  const email = normalize({ threadId, from: "a@b.com", subject: "s", listId: null, attachments: [], bodyText: "", internalDateMs: 1 });
  return recordDecision(getDb(), email, { hits: [], labels: [], forwards: [], complete: false }, null, highDecision(), "test");
}

describe("executeDecision", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb({ query: (sql, params) => p.query(sql, params as any[]) as any });
    await runMigrations(getDb());
  });

  it("shadow stage executes nothing", async () => {
    const id = await seed("s1");
    const { g, calls } = fakeGmail();
    await executeDecision(getDb(), g, id, { stage: "shadow", autoActLabels: [] });
    expect(calls).toEqual([]);
  });

  it("assisted stage applies labels but never forwards", async () => {
    const id = await seed("s2");
    const { g, calls } = fakeGmail();
    await executeDecision(getDb(), g, id, { stage: "assisted", autoActLabels: [] });
    expect(calls).toEqual(["labels:s2:4-CAN REQ"]);
  });

  it("autonomous stage applies labels and forwards, and is idempotent", async () => {
    const id = await seed("s3");
    const { g, calls } = fakeGmail();
    const cfg = { stage: "autonomous" as const, autoActLabels: [] };
    await executeDecision(getDb(), g, id, cfg);
    await executeDecision(getDb(), g, id, cfg); // second run must be a no-op
    expect(calls).toEqual(["labels:s3:4-CAN REQ", "forward:s3:invoice@agency.example"]);
    const { rows } = await getDb().query(`select status, actions_executed from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("acted");
  });

  it("a failing forward marks the decision failed but keeps executed labels recorded", async () => {
    const id = await seed("s4");
    const g: GmailClient = {
      listNewThreads: async () => [], applyLabels: async () => {},
      forward: async () => { throw new Error("smtp down"); }, sendAlert: async () => {},
    };
    await executeDecision(getDb(), g, id, { stage: "autonomous", autoActLabels: [] });
    const { rows } = await getDb().query(`select status, actions_executed from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("failed");
    const executed = typeof rows[0].actions_executed === "string" ? JSON.parse(rows[0].actions_executed) : rows[0].actions_executed;
    expect(executed.some((a: any) => a.kind === "labels")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/act.ts`:

```ts
import type { Querier } from "./db";
import type { GmailClient } from "./gmail";
import type { Action } from "./decide";
import type { AppConfig } from "./config";

function permitted(action: Action, stage: AppConfig["stage"]): boolean {
  if (stage === "shadow") return false;
  if (stage === "assisted") return action.kind === "labels";
  return true; // autonomous
}

const keyOf = (a: Action) => JSON.stringify(a);

export async function executeDecision(
  db: Querier, gmail: GmailClient, decisionId: number, cfg: AppConfig
): Promise<void> {
  const { rows } = await db.query(
    `select thread_id, status, actions_planned, actions_executed from decisions where id = $1`, [decisionId]
  );
  const row = rows[0];
  if (!row || row.status === "needs_review") return;
  const planned: Action[] = typeof row.actions_planned === "string" ? JSON.parse(row.actions_planned) : row.actions_planned;
  const executed: Action[] = typeof row.actions_executed === "string" ? JSON.parse(row.actions_executed) : row.actions_executed;
  const done = new Set(executed.map(keyOf));

  let failed = false;
  for (const action of planned) {
    if (!permitted(action, cfg.stage) || done.has(keyOf(action))) continue;
    try {
      if (action.kind === "labels") await gmail.applyLabels(row.thread_id, action.labels);
      else await gmail.forward(row.thread_id, action.to);
      executed.push(action);
      // record immediately after success: a crash between actions can only skip, never repeat
      await db.query(`update decisions set actions_executed = $2 where id = $1`,
        [decisionId, JSON.stringify(executed)]);
    } catch (e) {
      failed = true;
      await db.query(`update decisions set status = 'failed' where id = $1`, [decisionId]);
      break; // fail toward humans: stop acting, dashboard will surface it
    }
  }
  if (!failed && cfg.stage !== "shadow") {
    await db.query(`update decisions set status = 'acted' where id = $1`, [decisionId]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run tests/act.test.ts` — Expected: PASS (4 tests).

```bash
git add src/lib/act.ts tests/act.test.ts
git commit -m "feat: staged action layer with per-action idempotency"
```

---

### Task 11: LangGraph pipeline and cron ingestion route

**Files:**
- Create: `src/graph/triage.ts`, `src/app/api/cron/ingest/route.ts`, `src/app/api/cron/watchdog/route.ts`, `vercel.json`
- Test: `tests/triage.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildTriageGraph(deps: { db: Querier; gmail: GmailClient; classify: (e: NormalizedEmail, r: RuleOutcome) => Promise<Classification> }): { run(email: NormalizedEmail): Promise<number> }` (returns decision id); HTTP `GET /api/cron/ingest` and `GET /api/cron/watchdog`, both requiring `Authorization: Bearer ${CRON_SECRET}`.

- [ ] **Step 1: Write the failing test**

Create `tests/triage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { buildTriageGraph } from "@/graph/triage";
import { normalize } from "@/lib/normalize";
import type { GmailClient } from "@/lib/gmail";

const silentGmail: GmailClient = {
  listNewThreads: async () => [], applyLabels: async () => { throw new Error("must not act in shadow"); },
  forward: async () => { throw new Error("must not act in shadow"); }, sendAlert: async () => {},
};

function email(threadId: string, from: string, subject: string, body: string) {
  return normalize({ threadId, from, subject, listId: null, attachments: [], bodyText: body, internalDateMs: 10 });
}

describe("triage graph (shadow stage)", () => {
  beforeEach(async () => {
    const p = new PGlite();
    setDb({ query: (sql, params) => p.query(sql, params as any[]) as any });
    await runMigrations(getDb());
    await getDb().query(
      `insert into rules (pattern_type, pattern, label_set, complete, source)
       values ('sender_domain','dxc.com','["3-KR","3-KR/DOCS&NOTICE"]', true, 'phase0')`
    );
  });

  it("complete rule hit skips the classifier entirely", async () => {
    let llmCalls = 0;
    const g = buildTriageGraph({ db: getDb(), gmail: silentGmail,
      classify: async () => { llmCalls++; throw new Error("should not be called"); } });
    const id = await g.run(email("g1", "ny_agent_copy@dxc.com", "Agent Copy of Print", "Hello"));
    const { rows } = await getDb().query(`select * from decisions where id=$1`, [id]);
    expect(llmCalls).toBe(0);
    expect(rows[0].confidence).toBe("rule");
    expect(rows[0].status).toBe("decided");
  });

  it("rule miss classifies via LLM and records llm_output", async () => {
    const g = buildTriageGraph({ db: getDb(), gmail: silentGmail,
      classify: async () => ({ tasks: [{ labels: ["4-CAN REQ"], forward_to: "none" }], confidence: "high", rationale: "r" }) });
    const id = await g.run(email("g2", "vicky@oakmont.com", "cancel please", "signed LPR attached"));
    const { rows } = await getDb().query(`select llm_output, status from decisions where id=$1`, [id]);
    expect(rows[0].llm_output).toBeTruthy();
    expect(rows[0].status).toBe("decided");
  });

  it("classifier failure fails toward review, never toward action", async () => {
    const g = buildTriageGraph({ db: getDb(), gmail: silentGmail,
      classify: async () => { throw new Error("gemini down"); } });
    const id = await g.run(email("g3", "x@y.com", "hmm", "??"));
    const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
    expect(rows[0].status).toBe("needs_review");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/triage.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the graph**

Create `src/graph/triage.ts`:

```ts
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { Querier } from "@/lib/db";
import type { GmailClient } from "@/lib/gmail";
import type { NormalizedEmail } from "@/lib/normalize";
import { loadActiveRules, matchRules, type RuleOutcome } from "@/lib/rules";
import type { Classification } from "@/lib/classify";
import { decide, recordDecision, type Decision } from "@/lib/decide";
import { executeDecision } from "@/lib/act";
import { getConfig, type AppConfig } from "@/lib/config";

const TriageState = Annotation.Root({
  email: Annotation<NormalizedEmail>,
  cfg: Annotation<AppConfig>,
  ruleResult: Annotation<RuleOutcome | null>({ reducer: (_, b) => b, default: () => null }),
  classification: Annotation<Classification | null>({ reducer: (_, b) => b, default: () => null }),
  decision: Annotation<Decision | null>({ reducer: (_, b) => b, default: () => null }),
  decisionId: Annotation<number | null>({ reducer: (_, b) => b, default: () => null }),
});

export function buildTriageGraph(deps: {
  db: Querier;
  gmail: GmailClient;
  classify: (e: NormalizedEmail, r: RuleOutcome) => Promise<Classification>;
}) {
  const graph = new StateGraph(TriageState)
    .addNode("rules", async (s) => {
      const rules = await loadActiveRules(deps.db);
      return { ruleResult: matchRules(s.email, rules) };
    })
    .addNode("classify", async (s) => {
      try {
        return { classification: await deps.classify(s.email, s.ruleResult!) };
      } catch {
        return { classification: null }; // fail toward review (decide handles null)
      }
    })
    .addNode("decide", async (s) => ({ decision: decide(s.ruleResult!, s.classification, s.cfg) }))
    .addNode("record", async (s) => ({
      decisionId: await recordDecision(deps.db, s.email, s.ruleResult!, s.classification, s.decision!, s.cfg.stage),
    }))
    .addNode("act", async (s) => {
      await executeDecision(deps.db, deps.gmail, s.decisionId!, s.cfg);
      return {};
    })
    .addEdge(START, "rules")
    .addConditionalEdges("rules", (s) => (s.ruleResult!.complete ? "decide" : "classify"))
    .addEdge("classify", "decide")
    .addEdge("decide", "record")
    // record ALWAYS precedes act (spec: DB write before any Gmail action)
    .addConditionalEdges("record", (s) => (s.decision!.status === "needs_review" ? END : "act"))
    .addEdge("act", END)
    .compile();

  return {
    async run(email: NormalizedEmail): Promise<number> {
      const cfg = await getConfig(deps.db);
      const out = await graph.invoke({ email, cfg });
      return out.decisionId!;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/triage.test.ts` — Expected: PASS (3 tests). (If the LangGraph API surface differs in the installed version, check `node_modules/@langchain/langgraph/README.md` for the current `Annotation`/`StateGraph` syntax and adjust — the node/edge topology is the contract, not the exact builder calls.)

- [ ] **Step 5: Implement the cron routes and vercel.json**

Create `src/app/api/cron/ingest/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/gmail";
import { makeClassifier } from "@/lib/classify";
import { buildTriageGraph } from "@/graph/triage";
import { normalize } from "@/lib/normalize";

export const maxDuration = 300;

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  const gmail = makeGmail();
  const graph = buildTriageGraph({ db, gmail, classify: makeClassifier() });

  const { rows } = await db.query(`select checkpoint_ms from ingest_state where id = 1`);
  const checkpoint = Number(rows[0].checkpoint_ms);
  const snapshots = await gmail.listNewThreads(checkpoint || Date.now() - 10 * 60 * 1000);

  let processed = 0, maxSeen = checkpoint;
  for (const snap of snapshots) {
    const seen = await db.query(`select 1 from threads where thread_id = $1`, [snap.threadId]);
    if (seen.rows.length) continue; // overlap dedupe (duplicates-over-holes)
    await graph.run(normalize(snap));
    processed++;
    maxSeen = Math.max(maxSeen, snap.internalDateMs);
  }
  // checkpoint advances only after all rows are durably written
  await db.query(
    `update ingest_state set checkpoint_ms = $1, last_success_at = now() where id = 1`, [maxSeen]
  );
  return NextResponse.json({ processed, checkpoint: maxSeen });
}
```

Create `src/app/api/cron/watchdog/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { makeGmail } from "@/lib/gmail";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { rows } = await getDb().query(`select last_success_at from ingest_state where id = 1`);
  const last = rows[0]?.last_success_at ? new Date(rows[0].last_success_at).getTime() : 0;
  const silentMin = (Date.now() - last) / 60000;
  if (silentMin > 15 && process.env.ALERT_EMAIL) {
    await makeGmail().sendAlert(process.env.ALERT_EMAIL, "[triage] ingestion silent",
      `No successful ingest run for ${Math.round(silentMin)} minutes.`);
    return NextResponse.json({ alerted: true, silentMin });
  }
  return NextResponse.json({ ok: true, silentMin });
}
```

Create `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/ingest", "schedule": "*/2 * * * *" },
    { "path": "/api/cron/watchdog", "schedule": "*/15 * * * *" }
  ]
}
```

- [ ] **Step 6: Verify build, commit**

Run: `npx vitest run` (full suite) — Expected: ALL PASS. Run: `npm run build` — Expected: succeeds.

```bash
git add src/graph/ src/app/api/ vercel.json tests/triage.test.ts
git commit -m "feat: LangGraph triage pipeline, cron ingestion, watchdog"
```

---

### Task 12: Deployment and DWD setup (human-in-the-loop checklist)

**Files:**
- Modify: `.env.example` (if any var was added along the way)

**Interfaces:**
- Consumes: everything; produces a deployed shadow-ready service.

- [ ] **Step 1 (REVISED 2026-08-06 — DWD declined by owner): per-mailbox OAuth setup (human steps, assist and verify)**

1. Create a GCP project; enable the **Gmail API**.
2. OAuth consent screen: User type **Internal** (Workspace-only; no verification, long-lived refresh tokens).
3. Create an OAuth client ID, application type **Desktop app**; note the client ID and secret.
4. Populate local `.env` from `.env.example` with `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_USER=pro@agency.example`.
5. Run `npm run authorize-gmail`; sign in as **pro@agency.example** in the browser and approve. The script verifies the authorized mailbox and prints `GOOGLE_OAUTH_REFRESH_TOKEN` — add it to `.env` (and later Vercel env).

<details><summary>Original DWD variant (declined; kept for reference)</summary>

1. Create a service account (`triage-bot`); create a JSON key; note the **client ID**.
2. In Google Admin (admin.google.com, agency.example): Security → Access and data control → API controls → **Domain-wide delegation** → Add new: the service account's client ID with scopes `https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send`.
3. Populate local `.env` with the SA email, private key, `GMAIL_USER=pro@agency.example`.

</details>

- [ ] **Step 2: Run the Gmail live probe**

Run: `npm run probe-gmail` — Expected: `PROBE OK` with recent threads and non-empty bodies. Do not proceed until it passes (Phase 0 lesson: live probe before trusting any Gmail integration).

- [ ] **Step 3: Run the Gemini live probe**

Run: `npm run probe-gemini` — Expected: valid classification JSON for the cancellation fixture. If the model ID is rejected, consult current Gemini API docs for the exact Flash-tier model ID and set `GEMINI_MODEL`.

- [ ] **Step 4: Provision Vercel project + Postgres**

1. `npm i -g vercel` (if absent) → `vercel link` (create project).
2. Provision Postgres through the Vercel Marketplace integration flow (`vercel integration` / dashboard); capture `DATABASE_URL`.
3. `vercel env add` for every variable in `.env.example` (production).
4. Run migrations + seed against the production DB: `DATABASE_URL=<prod> npx tsx -e "import('./src/lib/migrate').then(async m => m.runMigrations((await import('./src/lib/db')).getDb()))"` then `DATABASE_URL=<prod> npm run seed-rules`. Expected: seeded rule count > 20.

- [ ] **Step 5: Deploy and verify shadow operation**

1. `vercel deploy --prod`.
2. Trigger once manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/cron/ingest` — Expected: `{ processed: N, checkpoint: ... }`.
3. Query the DB: `select status, confidence, count(*) from decisions group by 1,2;` — decisions accumulating, zero Gmail writes (verify no new labels in the mailbox).
4. Confirm the cron fires on schedule (Vercel dashboard → Crons) and the watchdog returns `{ok:true}`.

- [ ] **Step 6: Commit any final config, tag shadow start**

```bash
git add -A && git commit -m "chore: deployment configuration" && git tag shadow-start
```

---

### Task 13: Gemini eval baseline (pre-shadow gate)

**Files:**
- Create: `scripts/eval-blindtest.ts`
- Modify: none (reuses `phase0/score_blindtest.py` and `phase0/analysis/blindtest/`)

**Interfaces:**
- Consumes: `makeClassifier` (Task 8); Phase 0 blind-test batches `phase0/analysis/blindtest/batch-{0..3}.json` (records: `{threadId, from, subject, listId, attachments, body}`) and `key.json`; the category mapping from `phase0/make_blindtest.py`.
- Produces: `phase0/analysis/blindtest/predictions-gemini.json` in the scorer's format `[{threadId, categories, confidence}]`.

- [ ] **Step 1: Write the eval runner**

Create `scripts/eval-blindtest.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { makeClassifier } from "../src/lib/classify";
import { normalize } from "../src/lib/normalize";

// Mirror of CATEGORIES in phase0/make_blindtest.py — keep in sync.
const CATEGORIES: Record<string, string[]> = {
  "cancellation-request": ["4-CAN REQ"],
  "loss-run-request": ["7-Loss Run Req"],
  "wc-certificate": ["8-C-105.2"],
  "policy-document-request": ["3-KR/POLICY REQUEST"],
  "endorsement-request": ["2-NY/Endorsement", "3-Endorsement"],
  "recommendation-compliance": ["2-NY/Recommendation"],
  "billing-money": ["Billing"],
  "carrier-cancellation-notice": ["Cancelllation"],
  "carrier-docs-filing": ["3-KR/DOCS&NOTICE"],
  "usli-renewal-quote": ["6-RENEWAL QUOTE-USLI", "3-KR/USLI RENEWAL QUOTE"],
};

function categoriesOf(labels: string[]): string[] {
  const out = new Set<string>();
  for (const [cat, raws] of Object.entries(CATEGORIES))
    if (raws.some((r) => labels.includes(r))) out.add(cat);
  if (labels.some((l) => l.toLowerCase().startsWith("disregard"))) out.add("junk-no-action");
  return [...out].sort();
}

async function main() {
  const classify = makeClassifier();
  const preds: any[] = [];
  for (let b = 0; b < 4; b++) {
    const batch = JSON.parse(readFileSync(`phase0/analysis/blindtest/batch-${b}.json`, "utf8"));
    for (const r of batch) {
      const email = normalize({
        threadId: r.threadId, from: r.from ?? "", subject: r.subject ?? "",
        listId: r.listId ?? null, attachments: r.attachments ?? [], bodyText: r.body ?? "", internalDateMs: 0,
      });
      const c = await classify(email, { hits: [], labels: [], forwards: [], complete: false });
      const labels = [...new Set(c.tasks.flatMap((t) => t.labels))];
      preds.push({ threadId: r.threadId, categories: categoriesOf(labels), confidence: c.confidence });
      console.log(`${preds.length}/88 ${r.threadId} -> ${categoriesOf(labels).join(",")} (${c.confidence})`);
    }
  }
  writeFileSync("phase0/analysis/blindtest/predictions-gemini.json", JSON.stringify(preds, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Add script `"eval-blindtest": "npx tsx scripts/eval-blindtest.ts"`.

- [ ] **Step 2: Run the eval**

Run: `npm run eval-blindtest` (requires `GEMINI_API_KEY`; 88 sequential calls, a few minutes). Expected: `predictions-gemini.json` written with 88 entries.

- [ ] **Step 3: Score it**

Run: `cd phase0 && PYTHONIOENCODING=utf-8 python score_blindtest.py analysis/blindtest/predictions-gemini.json`

Expected output: exact-set match, per-category P/R/F1, confidence calibration. **Gate (spec §7): adjusted exact-set match ≥ 76.8%.** Apply the same two adjustments as Phase 0 when comparing (carrier-cancellation implies docs-filing is already handled by `applyStructuralRules` upstream of the mapping; arrival-time junk scoring as in Phase 0).

- [ ] **Step 4: Act on the result**

- **Gate passes:** record the numbers in `docs/superpowers/specs/2026-08-05-email-triage-design.md` under a new "Gemini baseline" note; set per-category `autoActLabels` config from the measured strong categories; shadow mode may begin.
- **Gate fails:** iterate `src/lib/prompt.ts` (definitions, examples) and re-run; if still short after 3 iterations, escalate model (`GEMINI_MODEL` to the Pro tier) and re-run. Do not start shadow mode until the gate passes.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-blindtest.ts package.json docs/superpowers/specs/2026-08-05-email-triage-design.md
git commit -m "feat: Gemini blind-test eval runner and measured baseline"
```

---

## Self-review notes

- **Spec coverage:** §3 graph topology → Task 11; §4.1 ingestion + hardening → Tasks 7, 11; §4.2 rules + seeding + structural rule → Tasks 5, 6; §4.3 classifier → Task 8; §4.4 decide/thresholds → Tasks 3, 9; §4.5 act/idempotency/stage gating → Task 10; §4.6 schema → Task 2; §5 stages → Tasks 3, 10; §6 error handling → Tasks 8–11 (fail-to-review paths tested); §7 eval gate → Task 13; watchdog/dead-man → Task 11. **§4.7 dashboard is intentionally out of scope — separate follow-up plan.** Daily digest (§5 stage 2) is deferred to the dashboard plan alongside its metrics queries.
- **Threshold values** (purity ≥0.9/support ≥10 domain; ≥0.95/≥5 exact) copied from spec §4.2 into Task 6.
- **Type consistency check:** `Querier`/`getDb`/`setDb` (T2) used in T3/T6/T9/T10/T11; `ThreadSnapshot`/`NormalizedEmail` (T4) in T7/T8/T11; `RuleOutcome` (T5) in T8/T9/T11; `Classification` (T8) in T9/T11; `Action`/`Decision` (T9) in T10; `GmailClient` (T7) in T10/T11 — names verified consistent.
