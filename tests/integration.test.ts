import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { setDb, getDb, type Querier } from "@/lib/db";
import { runMigrations } from "@/lib/migrate";
import { loadOfficeConfig, setOfficeConfig, type OfficeConfig } from "@/lib/officeConfig";
import { runMiningPipeline, type Artifacts } from "@/cli/steps/mine";
import { offlineClassify } from "@/cli/commands/init";
import { makeFakeMail } from "@/lib/mail/fake";
import type { ThreadSnapshot } from "@/lib/mail/types";
import { seedMinedRules } from "@/lib/mining";
import { buildTriageGraph } from "@/graph/triage";
import { observeSentMail } from "@/lib/observer";
import { buildDigest } from "@/lib/digest";
import { normalize, type NormalizedEmail } from "@/lib/normalize";
import type { RuleOutcome } from "@/lib/rules";
import type { Classification } from "@/lib/classify";

// --- fixture builders -------------------------------------------------------

function snap(o: Partial<ThreadSnapshot> & { threadId: string; from: string; subject: string; internalDateMs: number }): ThreadSnapshot {
  return { to: [], listId: null, attachments: [], bodyText: "", references: [], ...o };
}

const VENDOR_FROM = "OfficeSupply Co Billing <statements@officesupply.example>";
const HARTLEY_FROM = "Hartley & Sons <info@hartleysons.example>";
const JO = "jo@hartleysons.example";

/**
 * examples/hartley/history.json (LEDGER MUST-FIX, final fix wave, 2026-08-07) now carries
 * ~170 inbox threads / ~44 sent forwards on its own - grown deterministically from the
 * original 40/12 (see the fixture's own appended entries: more newsletters, more mixed
 * sales/support one-offs, more forwarded quote/support/billing threads across new fictional
 * senders, all ascending dates, no Date.now()/Math.random()). That alone clears
 * splitHoldout's spec-mandated min=30 holdout floor (20% of ~170 is ~34) without any
 * synthetic filler - a prior version of this test pushed ~130 "aaa-fill-..." synthetic
 * threads to clear that floor; those are gone now that the real fixture is big enough.
 *
 * The 8 real "hartley-vendor-*" gold threads (forwarded to jo@ - see Task 11) still survive
 * splitHoldout's gold-first, then-threadId-alphabetical holdout fill: the new gold forwards
 * (the "hartley-billing", "hartley-quote", and "hartley-support" prefixes) all sort
 * alphabetically before "hartley-vendor", so they fill the holdout first. Test 1 below
 * still asserts at least 5 of the 8 vendor threads land in `train` (not swept into
 * holdout) - anchoring the mined-gold rule it checks to real fixture content - see
 * REAL_VENDOR_IDS.
 */
const REAL_VENDOR_IDS = Array.from({ length: 8 }, (_, i) => `hartley-vendor-0${i + 1}`);

// Fresh thread from the office's own known vendor domain, dated after every entry in
// history.json - the mined-gold rule from history.json's real vendor forwards should catch
// this without ever calling the classifier.
const freshVendorEmail: ThreadSnapshot = snap({
  threadId: "hartley-vendor-fresh-01", from: VENDOR_FROM, subject: "Monthly statement #9999",
  bodyText: "Amount due: $88.00.", internalDateMs: 1786500000000,
});

// A sender no rule has ever seen. Content is deliberately keyword-free so offlineClassify
// falls back to its "medium confidence, no clear match" branch - genuinely uncertain, not
// just unlucky. (Confidence isn't actually why these land in review: the deploy default
// cfg.autoActLabels=[] sends every non-rule decision to needs_review regardless of
// confidence - see decide.ts. This still matches the brief's "uncertain" framing honestly.)
const CORR_BASE = 1787000000000;
function newVendorThread(i: number): ThreadSnapshot {
  return snap({
    threadId: `newvendor-${i}`, from: "Billing <billing@newvendor.example>",
    subject: `Account setup, thread ${i}`, bodyText: "We wanted to check in about our new vendor relationship.",
    internalDateMs: CORR_BASE + i * 1_000_000,
  });
}
function forwardOf(t: ThreadSnapshot): ThreadSnapshot {
  return snap({ threadId: t.threadId, from: HARTLEY_FROM, to: [JO], subject: `Fwd: ${t.subject}`, internalDateMs: t.internalDateMs + 500_000 });
}

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

describe("clone-to-shadow, end to end on fakes", () => {
  let artifacts: Artifacts;
  let mail: ReturnType<typeof makeFakeMail>;
  let cfg: OfficeConfig;
  let stubClassifier: (email: NormalizedEmail) => Promise<Classification>;
  let graphClassify: (email: NormalizedEmail, rule: RuleOutcome) => Promise<Classification>;

  async function setupDb(): Promise<void> {
    setDb(pgliteAdapter(new PGlite()));
    await runMigrations(getDb());
    await setOfficeConfig(getDb(), cfg);
    await seedMinedRules(getDb(), artifacts.minedRules);
  }

  beforeAll(async () => {
    cfg = loadOfficeConfig("examples/hartley/triage.config.json");
    const history = JSON.parse(readFileSync("examples/hartley/history.json", "utf8")) as { inbox: ThreadSnapshot[]; sent: ThreadSnapshot[] };
    mail = makeFakeMail(history);
    // Deterministic keyword stub, reused from init.ts's --dry-run path (exported for this
    // purpose - see task-12-report.md) rather than duplicated here: invoice/statement -> jo,
    // quote/order -> sales, return/damaged/etc -> support, list-id newsletters -> junk,
    // else medium confidence. Also passed as runMiningPipeline's new evalClassify override
    // (see task-12-report.md, "Production fixes", finding 2) so the holdout eval never
    // instantiates the real Gemini model.
    stubClassifier = offlineClassify(cfg);
    graphClassify = (email, _rule) => stubClassifier(email);
    artifacts = await runMiningPipeline(mail, cfg, stubClassifier, () => {}, stubClassifier);
  });

  it("mines a gold rule from the forwarded vendor domain", () => {
    // Structural anchor: prove the rule below is built from REAL history.json forwards, not
    // just synthetic filler - fails if a sort-order regression ever sweeps the real vendor
    // threads into the holdout (excluded from mining) instead of the filler.
    const holdoutIds = new Set(artifacts.holdout.map((l) => l.email.threadId));
    const survivingReal = REAL_VENDOR_IDS.filter((id) => !holdoutIds.has(id));
    expect(survivingReal.length).toBeGreaterThanOrEqual(5);

    const vendor = artifacts.minedRules.find((r) => r.pattern === "officesupply.example");
    expect(vendor).toMatchObject({ tier: "mined-gold", categoryIds: ["jo"] });
    expect(vendor?.support).toBeGreaterThanOrEqual(8); // at least the 8 real vendor threads
  });

  it("produces an eval report and the HTML artifact", () => {
    expect(artifacts.evalReport!.evaluated).toBeGreaterThan(0);
    expect(artifacts.reportHtml).toContain("Hartley");
  });

  it("seeds a database and runs a shadow ingest with zero mail writes", async () => {
    await setupDb();
    const graph = buildTriageGraph({ db: getDb(), mail, classify: graphClassify });
    const id = await graph.run(normalize(freshVendorEmail));
    const { rows } = await getDb().query(`select confidence, status, config_hash from decisions where id=$1`, [id]);
    expect(rows[0]).toMatchObject({ confidence: "rule", status: "decided" });
    expect(rows[0].config_hash).toBeTruthy();
    expect(mail.log.filter((l) => l.startsWith("categories") || l.startsWith("forward"))).toHaveLength(0); // shadow
  });

  it("closes the correction loop: 3 reviewer forwards promote a learned rule", async () => {
    const graph = buildTriageGraph({ db: getDb(), mail, classify: graphClassify });
    for (let i = 1; i <= 3; i++) {
      const email = newVendorThread(i);
      const id = await graph.run(normalize(email));
      const { rows } = await getDb().query(`select status from decisions where id=$1`, [id]);
      expect(rows[0].status).toBe("needs_review"); // unknown sender, no rule, review-only by default
      const fwd = forwardOf(email);
      mail.pushSent(fwd);
      await observeSentMail(getDb(), mail, cfg, fwd.internalDateMs + 100_000); // 3 calls, advancing nowMs
    }
    const { rows } = await getDb().query(`select source, label_set from rules where pattern = 'billing@newvendor.example'`);
    expect(rows[0]?.source).toBe("learned"); // spec §13 criterion 3: sender_exact @ 3/3 purity 1.0 promotes
    const labelSet = typeof rows[0]?.label_set === "string" ? JSON.parse(rows[0].label_set) : rows[0]?.label_set;
    expect(labelSet).toEqual(["jo"]);
  });

  it("builds a digest naming the day's activity", async () => {
    const d = await buildDigest(getDb(), 0); // sinceMs=0 sidesteps decisions.created_at's DB now()
    expect(d.subject).toMatch(/\d+ routed|\d+ waiting/);
    expect(d.subject).toContain("3 waiting"); // the 3 correction-loop threads, still needs_review
    expect(d.body).toContain("3 corrections observed"); // the loop that just ran
  });
});
