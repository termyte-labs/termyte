/**
 * `termyte <command> [args]`
 *
 * Subcommands:
 *
 *   search  <query>  [--project p] [--limit n] [--json]
 *   context           [--project p] [--query q] [--limit n]
 *   help
 */
import { searchCommand } from "./search.js";
import { contextCommand } from "./context.js";

const USAGE = `termyte - memory layer for coding agents

Usage:
  termyte search <query> [--project p] [--limit n] [--json]
  termyte context [--project p] [--query q] [--limit n]
  termyte help
`;

function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string | boolean> } {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") {
      opts["json"] = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const { positional, opts } = parseArgs(rest);

  try {
    switch (command) {
      case "search": {
        const query = positional.join(" ").trim();
        if (!query) {
          process.stderr.write("usage: termyte search <query>\n");
          process.exit(2);
        }
        await searchCommand(query, {
          project: typeof opts["project"] === "string" ? opts["project"] as string : undefined,
          limit: typeof opts["limit"] === "string" ? parseInt(opts["limit"] as string, 10) : undefined,
          json: opts["json"] === true,
        });
        break;
      }
      case "context": {
        await contextCommand({
          project: typeof opts["project"] === "string" ? opts["project"] as string : undefined,
          query: typeof opts["query"] === "string" ? opts["query"] as string : undefined,
          limit: typeof opts["limit"] === "string" ? parseInt(opts["limit"] as string, 10) : undefined,
        });
        break;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`termyte: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
