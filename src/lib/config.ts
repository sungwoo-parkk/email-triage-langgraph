import { z } from "zod";
import type { Querier } from "./db";

const AppConfigSchema = z.object({
  stage: z.enum(["shadow", "assisted", "autonomous"]),
  autoActLabels: z.array(z.string()),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// The allow-list is never hand-curated: it starts empty (everything review-only) and is
// seeded per office by the onboarding eval (`triage init`'s mining pipeline measures
// per-category F1 against the office's own mail history — see src/lib/onboardEval.ts)
// and updated afterward by live corrections. A fresh office with no eval yet is
// maximally conservative: nothing auto-acts until it's earned.
const DEFAULTS: AppConfig = {
  stage: "shadow",
  autoActLabels: [],
};

export async function getConfig(db: Querier): Promise<AppConfig> {
  const { rows } = await db.query(`select key, value from app_config`);
  const overrides = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
  return AppConfigSchema.parse({ ...DEFAULTS, ...overrides });
}

export async function setConfigKey(db: Querier, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into app_config (key, value) values ($1, $2) on conflict (key) do update set value = $2, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}
