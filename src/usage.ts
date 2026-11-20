/**
 * The command list, in one place, so the help text, `orla help --json` and
 * the skill file that teaches an agent the CLI cannot disagree about what
 * exists. A test reads this back against skills/orla/SKILL.md.
 */

export type Command = {
  /** The words after `orla`. */
  name: string;
  /** What follows the name on the command line, if anything: `<space-id>`, `[--api URL]`. */
  args?: string;
  summary: string;
};

export const COMMANDS: Command[] = [
  { name: "login", args: "[--api URL] [--agent]", summary: "connect this machine (opens a browser); --agent asks for the door where a bot can be minted" },
  { name: "logout", summary: "revoke the connection on Orla and forget the stored session" },
  { name: "whoami", summary: "who this connection is, and what it reaches" },
  { name: "spaces", summary: "the spaces in reach" },
  { name: "use", args: "<space-id>", summary: "remember a space as the default" },
  { name: "accounts", summary: "accounts in the space" },
  { name: "tx list", summary: "transactions (--from --to --search --account --limit up to 200)" },
  { name: "tx add", summary: "record one (--account --kind --amount --date [--payee --note])" },
  { name: "export", summary: "every matching row as CSV on stdout (--from --to --search --account --limit)" },
  { name: "feedback", args: "<bug|idea|problem> \"text\"", summary: "tell the Orla team, after showing the text (--yes for scripts, --space optional)" },
  { name: "tools", summary: "which tools this connection is given" },
  { name: "mcp", args: "[--api URL]", summary: "stdio bridge, for clients that cannot speak HTTP" },
  { name: "version", summary: "which version this is" },
];

const WIDTH = 30;

export const USAGE = [
  "orla: your Orla books from the terminal",
  "",
  ...COMMANDS.map((c) => `  ${`orla ${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(WIDTH)}${c.summary}`),
  "",
  "Flags: --space <id> on anything space-scoped, --json for machine output.",
  "With --json every answer is {ok:true,data} or {ok:false,error:{code,message}}.",
  "A personal connection reads and records. It cannot pay anyone.",
].join("\n");
