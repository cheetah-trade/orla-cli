/**
 * The grammar, on its own so it can be read back by a test.
 *
 * It lived inside index.ts, where the only way to reach it was to import the
 * entrypoint, which runs the CLI on import. Five commands and a handful of
 * flags are not much of a parser, and that is the point: what breaks here is
 * the quiet case, `--from` swallowing the next flag as its value.
 */

export type Flags = Record<string, string | boolean>;

export function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { words, flags };
}

export function need(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export function optional(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}
