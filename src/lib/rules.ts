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
