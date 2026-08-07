import { parseArgs } from "node:util";

export interface CliArgs { command: "init" | "status" | "promote" | "pause"; dryRun: boolean; config: string | undefined }

export function parseCliArgs(argv: string[]): CliArgs {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, config: { type: "string" } },
  });
  const command = positionals[0];
  if (!["init", "status", "promote", "pause"].includes(command ?? ""))
    throw new Error(`unknown command: ${command ?? "(none)"} — expected init | status | promote | pause`);
  return { command: command as CliArgs["command"], dryRun: values["dry-run"]!, config: values.config };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const { run } = await import(`./commands/${args.command}`);
  await run(args);
}
if (process.argv[1]?.endsWith("main.ts")) main().catch((e) => { console.error(e.message); process.exit(1); });
