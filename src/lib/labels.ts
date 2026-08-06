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
