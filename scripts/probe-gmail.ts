import { makeGmail } from "../src/lib/gmail";

async function main() {
  const gmail = makeGmail();
  const since = Date.now() - 60 * 60 * 1000;
  const threads = await gmail.listNewThreads(since);
  console.log(`PROBE OK: ${threads.length} thread(s) in the last hour`);
  for (const t of threads.slice(0, 3))
    console.log(`- ${t.threadId} | ${t.from} | ${t.subject.slice(0, 60)} | body ${t.bodyText.length} chars`);
  if (threads.some((t) => !t.bodyText)) console.warn("WARNING: empty body detected — investigate before shadow mode");
}
main().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
