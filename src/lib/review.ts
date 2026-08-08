import type { NormalizedEmail } from "./normalize";
import type { Decision } from "./decide";
import type { Vocabulary } from "./officeConfig";

// Every system-generated forward (review-forwards to the reviewer, routee forwards) opens
// with this marker. It's both a human-facing label and a machine-readable tag: observer.ts
// greps for it to tell the system's own outgoing mail apart from a human's genuine
// corrective forward (finding C2 - without this, a review-forward the system sends to
// itself gets mistaken for a human correction and can mint a bogus learned rule).
export const TRIAGE_MARKER = "[triage]";

// Vocabulary only exposes routee/category description text (not the routee's display
// name), so "human-readable" here means humanizing the id itself (kebab/snake -> Title
// Case) rather than a config lookup - "jo" -> "Jo", "carrier-docs" -> "Carrier Docs".
function nameFor(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function buildContextBody(email: NormalizedEmail, d: Decision, vocab: Vocabulary): string {
  const lines = d.tasks.length
    ? d.tasks.map((t) => {
        const desc = vocab.describe(t.categoryId);
        return `  - ${t.label}${desc ? ` (${desc})` : ""} -> ${nameFor(t.categoryId)}${t.forwardTo ? ` <${t.forwardTo}>` : ""}`;
      })
    : ["  - (no proposal - classifier could not decide)"];
  return [
    `${TRIAGE_MARKER} Proposed routing for: ${email.subject}`,
    `From: ${email.fromAddr}`,
    ``,
    `Proposal (confidence: ${d.confidence}):`,
    ...lines,
    d.rationale ? `Why: ${d.rationale}` : "",
    ``,
    `If this is wrong or unhandled, just forward this email to the right person as usual -`,
    `the system watches sent mail and learns from your correction. No buttons, no login.`,
  ].filter(Boolean).join("\n");
}
