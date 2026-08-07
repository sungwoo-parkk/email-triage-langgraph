import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MailClient, ThreadSnapshot } from "../../lib/mail/types";
import type { OfficeConfig } from "../../lib/officeConfig";
import { normalize, type NormalizedEmail } from "../../lib/normalize";
import { detectForwards } from "../../lib/forwardDetect";
import {
  stratifiedSample, labelWithLLM, splitHoldout, minePatterns,
  type LabeledThread, type MinedRule,
} from "../../lib/mining";
import { pickExemplars, type Exemplar } from "../../lib/promptgen";
import { makeClassifier, type Classification } from "../../lib/classify";
import type { RuleOutcome } from "../../lib/rules";
import { runHoldoutEval, type EvalReport } from "../../lib/onboardEval";
import { renderReport } from "../../lib/report";

export type ClassifyFn = (email: NormalizedEmail) => Promise<Classification>;

export interface Artifacts {
  minedRules: MinedRule[];
  exemplars: Exemplar[];
  holdout: LabeledThread[];
  evalReport: EvalReport | null;
  reportHtml: string;
}

// Onboarding eval floor: below ~70% overall agreement, deploy proceeds with everything
// review-only and the report shows a plain warning instead of an auto-route recommendation.
// This is NOT a promotion gate (those are shadow->assisted ≥85% agreement and
// assisted->autonomous <5% correction rate, defined in status.ts) — it only decides whether
// the onboarding report can suggest anything auto-routes on day one.
// Spec: docs/superpowers/specs/2026-08-07-small-office-triage-design.md §4.
export const EVAL_FLOOR = 0.7;

const NO_RULES: RuleOutcome = { hits: [], labels: [], forwards: [], complete: false };

/**
 * Mining and eval run before any rules exist (mining is what produces the rules), so the
 * classifier they use is always called with no rule evidence. makeClassifier's returned
 * function takes (email, ruleEvidence); this adapts it to the single-argument ClassifyFn
 * that labelWithLLM/runHoldoutEval expect.
 */
export function withNoRules(
  classifier: (email: NormalizedEmail, ruleEvidence: RuleOutcome) => Promise<Classification>
): ClassifyFn {
  return (email) => classifier(email, NO_RULES);
}

async function collect(iter: AsyncIterable<ThreadSnapshot>): Promise<ThreadSnapshot[]> {
  const out: ThreadSnapshot[] = [];
  for await (const t of iter) out.push(t);
  return out;
}

/**
 * Orchestration used by both `triage init` and the (Task 11) integration test. Pulls the
 * office's mail history, derives gold labels from sent-mail forwards, silver-labels the rest
 * with the LLM, mines deterministic rules, picks prompt exemplars, and evaluates the resulting
 * classifier on a held-out slice — everything an office needs to see before it commits to
 * anything, and everything the deploy step later seeds into the database.
 */
export async function runMiningPipeline(
  mail: MailClient,
  cfg: OfficeConfig,
  classify: ClassifyFn,
  log: (msg: string) => void = console.log
): Promise<Artifacts> {
  const { months, maxThreads } = cfg.mining;

  log(`Pulling up to ${maxThreads} inbox threads from the last ${months} months...`);
  const inboxRaw = await collect(mail.listHistory({ months, maxThreads }));
  log(`Pulling sent-mail history to find gold labels from past forwards...`);
  const sentRaw = await collect(mail.listHistory({ months, maxThreads, sent: true }));
  log(`Pulled ${inboxRaw.length} inbox thread(s), ${sentRaw.length} sent thread(s).`);

  const inbox = inboxRaw.map(normalize);
  const byThreadId = new Map(inbox.map((e) => [e.threadId, e]));

  const goldLabels = detectForwards(sentRaw, inboxRaw, cfg.routees);
  const gold: LabeledThread[] = [];
  for (const g of goldLabels) {
    const email = byThreadId.get(g.threadId);
    if (email) gold.push({ email, categoryIds: [g.categoryId], tier: "gold" });
  }
  log(`Found ${gold.length} gold label(s) from sent-mail forwards.`);

  const goldThreadIds = new Set(gold.map((l) => l.email.threadId));
  const remainder = inbox.filter((e) => !goldThreadIds.has(e.threadId));
  const sampleSize = Math.min(1000, Math.floor(maxThreads / 5));
  const sample = stratifiedSample(remainder, sampleSize);
  log(`Sampled ${sample.length} thread(s) for LLM silver labeling.`);

  const { labeled: silver, failures } = await labelWithLLM(classify, sample);
  log(`Silver-labeled ${silver.length} thread(s) (${failures} failure(s)).`);

  const allLabeled = [...gold, ...silver];
  const { train, holdout } = splitHoldout(allLabeled);
  log(`Split into ${train.length} train / ${holdout.length} holdout.`);

  const minedRules = minePatterns(train);
  log(`Mined ${minedRules.length} deterministic rule(s).`);

  const exemplars = pickExemplars(train);
  log(`Picked ${exemplars.length} prompt exemplar(s).`);

  let evalReport: EvalReport | null = null;
  if (holdout.length) {
    const evalClassify = withNoRules(makeClassifier(cfg, exemplars));
    evalReport = await runHoldoutEval(evalClassify, holdout);
    log(`Holdout eval: ${Math.round(evalReport.overallAgreement * 100)}% agreement over ${evalReport.evaluated} thread(s).`);
  } else {
    log(`Not enough labeled mail yet for a holdout eval.`);
  }

  const samples = [...allLabeled]
    .sort((a, b) => b.email.internalDateMs - a.email.internalDateMs)
    .slice(0, 8)
    .map((l) => ({ subject: l.email.subject, from: l.email.fromAddr, categoryIds: l.categoryIds }));

  const reportHtml = renderReport({ office: cfg.office.name, evalReport, rules: minedRules, samples, floor: EVAL_FLOOR });
  log(`Rendered triage-report.html.`);

  return { minedRules, exemplars, holdout, evalReport, reportHtml };
}

export function writeArtifacts(dir: string, artifacts: Artifacts): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "mined-rules.json"), JSON.stringify(artifacts.minedRules, null, 2));
  writeFileSync(path.join(dir, "exemplars.json"), JSON.stringify(artifacts.exemplars, null, 2));
  writeFileSync(path.join(dir, "holdout.json"), JSON.stringify(artifacts.holdout, null, 2));
  writeFileSync(path.join(dir, "eval.json"), JSON.stringify(artifacts.evalReport, null, 2));
  writeFileSync(path.join(dir, "triage-report.html"), artifacts.reportHtml);
}

export function readArtifacts(dir: string): Artifacts {
  const readJson = <T,>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
  return {
    minedRules: readJson<MinedRule[]>("mined-rules.json"),
    exemplars: readJson<Exemplar[]>("exemplars.json"),
    holdout: readJson<LabeledThread[]>("holdout.json"),
    evalReport: readJson<EvalReport | null>("eval.json"),
    reportHtml: readFileSync(path.join(dir, "triage-report.html"), "utf8"),
  };
}
