/**
 * Evaluators for the triage classifier. Programmatic ones are free and deterministic;
 * the two judge evaluators (faithfulness, instruction-following) spend Gemini tokens.
 *
 * Signature follows the LangSmith local-evaluate() convention: (run, example) with
 * TS attribute access, returning { key, score, comment }.
 */
import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { applyStructuralRules } from "../src/lib/rules";

// TEMPORARY (Task 6): the classifier now emits a single `category` id per task and no
// per-task forward_to (see src/lib/classify.ts); the golden dataset.json still uses the
// old label/forward_to shape until Task 11 refreshes it to the office-config taxonomy.
// Accept both shapes so this keeps compiling and produces sane (if imperfect) scores.
type Task = { category?: string; labels?: string[]; forward_to?: string; forwardTo?: string };
const taskLabels = (t: Task): string[] => (t.category ? [t.category] : t.labels ?? []);

// The blind test treats the two USLI renewal-quote labels as one category (both are
// dispatcher-accepted); mirror that here so the metric measures real disagreement.
function canon(labels: string[]): string[] {
  return applyStructuralRules(
    labels.map((l) => (l === "3-KR/USLI RENEWAL QUOTE" ? "6-RENEWAL QUOTE-USLI" : l))
  ).sort();
}

const labelUnion = (tasks: Task[]) => canon([...new Set((tasks ?? []).flatMap(taskLabels))]);
const forwardSet = (tasks: Task[]) =>
  [...new Set((tasks ?? []).map((t) => t.forward_to ?? t.forwardTo).filter((f) => f && f !== "none"))].sort();

export function exactSetMatch(run: any, example: any) {
  const got = labelUnion(run.outputs?.tasks ?? []);
  const want = labelUnion(example.outputs?.tasks ?? []);
  const match = JSON.stringify(got) === JSON.stringify(want);
  return { key: "exact_set_match", score: match ? 1 : 0, comment: `got [${got}] want [${want}]` };
}

export function taskCountMatch(run: any, example: any) {
  const got = (run.outputs?.tasks ?? []).length;
  const want = example.outputs?.request_count ?? (example.outputs?.tasks ?? []).length;
  return { key: "task_count_match", score: got === want ? 1 : 0, comment: `got ${got} task(s), want ${want}` };
}

export function forwardMatch(run: any, example: any) {
  const got = forwardSet(run.outputs?.tasks ?? []);
  const want = forwardSet(example.outputs?.tasks ?? []);
  const match = JSON.stringify(got) === JSON.stringify(want);
  return { key: "forward_match", score: match ? 1 : 0, comment: `got [${got}] want [${want}]` };
}

// Measures the MODEL's instruction-following on the co-emit rule specifically —
// deliberately checks the raw output, before applyStructuralRules would patch it.
export function coEmitCompliance(run: any, _example: any) {
  const raw = [...new Set(((run.outputs?.tasks ?? []) as Task[]).flatMap(taskLabels))];
  if (!raw.includes("Cancelllation")) return { key: "co_emit_compliance", score: 1, comment: "n/a (no Cancelllation)" };
  const ok = raw.includes("3-KR/DOCS&NOTICE");
  return { key: "co_emit_compliance", score: ok ? 1 : 0, comment: ok ? "co-emitted" : "missing 3-KR/DOCS&NOTICE alongside Cancelllation" };
}

export function latencySeconds(run: any, _example: any) {
  const ms = run.outputs?.latency_ms ?? 0;
  return { key: "latency_s", score: Math.round(ms) / 1000, comment: `${ms}ms end-to-end classify` };
}

// ---------- LLM-as-judge evaluators ----------

function judgeModel() {
  return new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_JUDGE_MODEL ?? "gemini-3.6-flash",
    temperature: 0,
    apiKey: process.env.GEMINI_API_KEY,
  });
}

const emailText = (inputs: any) =>
  `From: ${inputs.from}\nSubject: ${inputs.subject}\nAttachments: ${(inputs.attachments ?? []).join(", ") || "(none)"}\nBody: ${inputs.body}`;

const FaithfulnessGrade = z.object({
  unsupported_claims: z.array(z.string()).describe("Factual claims in the rationale NOT supported by the email (fabricated details, invented attachments, policy numbers or reasons not present)"),
  reasoning: z.string(),
});

export async function faithfulness(run: any, example: any) {
  const judge = judgeModel().withStructuredOutput(FaithfulnessGrade);
  const grade = await judge.invoke([
    ["system", `You check whether a classifier's rationale is grounded in the source email.
List ONLY factual claims about the EMAIL'S CONTENT that the email does not support - invented
attachments, policy numbers, amounts, senders, or reasons that are not present.
Do NOT flag: the classifier describing its own classification or routing decision ("forward to
accounting", "this is a KR work item"), category/label names, or reasonable inferences a
dispatcher would make (e.g. an undeliverable notice implies the agency sent the original).`],
    ["human", `EMAIL:\n${emailText(example.inputs)}\n\nRATIONALE TO CHECK:\n${run.outputs?.rationale ?? "(empty)"}`],
  ]);
  const ok = grade.unsupported_claims.length === 0;
  return { key: "faithfulness", score: ok ? 1 : 0, comment: ok ? grade.reasoning : `unsupported: ${grade.unsupported_claims.join(" | ")}` };
}

const InstructionGrade = z.object({
  splits_requests_correctly: z.boolean().describe("One task per distinct WORK ITEM — no merged or invented requests. Variants of the same work item (e.g. a WC certificate plus its wall poster) are ONE task."),
  companion_labels_correct: z.boolean().describe("Companion labels follow the CONVENTIONS TABLE provided in the system message — judge only against that table, never your own assumptions"),
  forward_convention_correct: z.boolean().describe("Forward only when the desk convention requires it: carrier invoices/statements -> invoice@agency.example; broker/insured payment matters -> accounting@agency.example; NHO homeowners endorsements -> express@agency.example; otherwise none"),
  confidence_appropriate: z.boolean().describe("'high' is correct for routine, clearly-patterned mail; only ambiguous or unusual mail should be medium/low"),
  reasoning: z.string(),
});

// The judge grades against the REAL desk conventions, not its own priors — an
// earlier judge version invented a false companion-label rule and tanked the metric.
const CONVENTIONS_TABLE = `COMPANION-LABEL CONVENTIONS (authoritative):
- Broker requests processed by KR ride with "3-KR": 4-CAN REQ, 7-Loss Run Req, 8-C-105.2, 3-KR/POLICY REQUEST, 3-Endorsement.
- Front-office work rides with "2-NY": 2-NY/Endorsement, 2-NY/Recommendation.
- "Cancelllation" (a CARRIER-issued cancellation notice only - never a broker's cancel request) rides with "3-KR/DOCS&NOTICE".
- Machine-generated carrier document deliveries: "3-KR" + "3-KR/DOCS&NOTICE".
- USLI renewal quotes: "6-RENEWAL QUOTE-USLI" (or "3-KR/USLI RENEWAL QUOTE") stands alone.
- "Billing" may appear alone or alongside another label.
A broker ASKING to cancel is 4-CAN REQ + 3-KR. It never carries 3-KR/DOCS&NOTICE.`;

export async function instructionFollowing(run: any, example: any) {
  const judge = judgeModel().withStructuredOutput(InstructionGrade);
  const grade = await judge.invoke([
    ["system", `You audit an email-triage classifier's output against its operating instructions. Grade each criterion strictly and independently.\n\n${CONVENTIONS_TABLE}`],
    ["human", `EMAIL:\n${emailText(example.inputs)}\n\nCLASSIFIER OUTPUT:\n${JSON.stringify({ tasks: run.outputs?.tasks, confidence: run.outputs?.confidence }, null, 1)}`],
  ]);
  const checks = [grade.splits_requests_correctly, grade.companion_labels_correct, grade.forward_convention_correct, grade.confidence_appropriate];
  const score = checks.filter(Boolean).length / checks.length;
  return { key: "instruction_following", score, comment: grade.reasoning };
}
