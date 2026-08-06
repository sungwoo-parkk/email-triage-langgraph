import { z } from "zod";
import type { Querier } from "./db";
import { CLASSIFIABLE_LABELS } from "./labels";

const AppConfigSchema = z.object({
  stage: z.enum(["shadow", "assisted", "autonomous"]),
  autoActLabels: z.array(z.string()),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// Categories the Gemini 3.6 Flash blind-test baseline (2026-08-06, spec §7) measured
// strong (F1 >= 0.86) start auto-act-eligible; weak categories stay review-only until
// eval proves otherwise (spec 4.4). "4-CAN REQ" measured 0.82 — review-only for now.
// "2-NY" stays: it has no category of its own but rides along as a co-label on strong ones.
const DEFAULTS: AppConfig = {
  stage: "shadow",
  autoActLabels: CLASSIFIABLE_LABELS.filter((l) =>
    ["2-NY/Endorsement", "3-Endorsement", "7-Loss Run Req", "8-C-105.2", "3-KR/POLICY REQUEST",
     "2-NY/Recommendation", "6-RENEWAL QUOTE-USLI", "3-KR/USLI RENEWAL QUOTE", "3-KR",
     "3-KR/DOCS&NOTICE", "Cancelllation", "2-NY"].includes(l)
  ),
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
