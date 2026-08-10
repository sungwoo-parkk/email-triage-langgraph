/**
 * Shared auth check for the cron routes. Fails CLOSED when CRON_SECRET is
 * missing: without this guard the expected header degenerates to the literal
 * string "Bearer undefined", which an attacker can simply send.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
