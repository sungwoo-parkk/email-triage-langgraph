import type { Querier } from "./db";
import type { NormalizedEmail } from "./normalize";

export interface LabeledThread { email: NormalizedEmail; categoryIds: string[]; tier: "gold" | "llm" }

export function stratifiedSample(threads: NormalizedEmail[], max: number): NormalizedEmail[] {
  const byDomain = new Map<string, NormalizedEmail[]>();
  for (const t of threads) (byDomain.get(t.fromDomain) ?? byDomain.set(t.fromDomain, []).get(t.fromDomain)!).push(t);
  for (const list of byDomain.values()) list.sort((a, b) => a.internalDateMs - b.internalDateMs);
  // round-robin across domains; within a domain, take items spread across time (stride pick)
  const queues = [...byDomain.values()].map((list) => {
    const stride = Math.max(1, Math.ceil(list.length / max));
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
  const buckets = new Map<string, Bucket>(); // key: `${patternType} ${pattern}`
  const add = (patternType: MinedRule["patternType"], pattern: string, l: LabeledThread) => {
    if (!pattern) return;
    const key = `${patternType} ${pattern.toLowerCase()}`;
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
    const [patternType, pattern] = key.split(" ") as [MinedRule["patternType"], string];
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
