import { createInterface } from "node:readline/promises";

/** Prompts y/N on the terminal. Used before every destructive/external action the CLI takes. */
export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
