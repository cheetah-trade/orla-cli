/**
 * Every way a command can fail, with a code a program can branch on and an
 * exit status a shell can.
 *
 * Before this, failure was one shape: a message on stderr and exit code 1,
 * whatever had gone wrong. A person reads the message; a script or an agent
 * reads the number, and "1" told it nothing. The server already answers a
 * refusal with a code (`mcp.unknown_tool`, `validation_error`), and the CLI
 * was throwing that code away and keeping only the prose.
 *
 * Codes that begin `cli.` are minted here, for failures that never reached
 * Orla. Anything else is the server's own code, passed through unchanged, so a
 * caller branching on it reads the same names the REST API and the MCP
 * endpoint use.
 */

/** Exit statuses. The table in skills/orla/SKILL.md and README.md is read back from here by a test. */
export const EXIT = {
  /** The command did what was asked. */
  ok: 0,
  /** Something failed that none of the codes below describes. */
  failure: 1,
  /** The command line itself: an unknown command, a missing flag. */
  usage: 2,
  /** No session on this machine, or a session Orla no longer honours. */
  notConnected: 3,
  /** A space-scoped command with no space to work in, or too many. */
  space: 4,
  /** Orla could not be reached at all. */
  network: 5,
  /** Orla was reached and said no, or answered in a shape this CLI cannot use. */
  refused: 6,
  /** Signing in was abandoned or came back wrong. */
  cancelled: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly code: string;
  readonly exit: ExitCode;
  readonly details: unknown;

  constructor(code: string, exit: ExitCode, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exit = exit;
    this.details = details;
  }
}

export const usage = (message: string): CliError => new CliError("cli.usage", EXIT.usage, message);

export const notConnected = (): CliError =>
  new CliError("cli.not_connected", EXIT.notConnected, "not connected: run `orla login` first");

export const sessionExpired = (why: string): CliError =>
  new CliError(
    "cli.session_expired",
    EXIT.notConnected,
    `the stored session is no longer honoured (${why}): \`orla logout\` and \`orla login\` again`,
  );

export const noSpaces = (): CliError =>
  new CliError("cli.no_spaces", EXIT.space, "this connection reaches no spaces; re-run `orla login` and tick one");

export const spaceRequired = (choices: { id: string; name: string }[]): CliError =>
  new CliError(
    "cli.space_required",
    EXIT.space,
    `several spaces are in reach, name one with --space:\n${choices.map((s) => `  ${s.id}  ${s.name}`).join("\n")}`,
    { spaces: choices },
  );

export const unreachable = (message: string): CliError => new CliError("cli.unreachable", EXIT.network, message);

/** Orla said no. `code` is the server's own, so it is not prefixed. */
export const refused = (code: string, message: string, details?: unknown): CliError =>
  new CliError(code, EXIT.refused, message, details);

/** Orla answered, but not in a shape a tool call can be read from. */
export const badAnswer = (message: string): CliError => new CliError("cli.bad_answer", EXIT.refused, message);

export const cancelled = (message: string): CliError => new CliError("cli.sign_in_cancelled", EXIT.cancelled, message);

/** What the caller sees, whatever was thrown. A bare Error is a general failure, not a lie about its cause. */
export function describe(err: unknown): { code: string; exit: ExitCode; message: string; details?: unknown } {
  if (err instanceof CliError) {
    return err.details === undefined
      ? { code: err.code, exit: err.exit, message: err.message }
      : { code: err.code, exit: err.exit, message: err.message, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "cli.failure", exit: EXIT.failure, message };
}
