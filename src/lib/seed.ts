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
