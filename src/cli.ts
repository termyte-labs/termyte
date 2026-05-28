#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultDbPath, openDatabase } from "./db.js";
import { formatInspection, formatLedger, formatMemory, formatReplay, replayEntries, toJson } from "./format.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { inspectAction, inspectPolicies, runRuntime } from "./runtime.js";
import { defaultPolicies } from "./policy.js";

function printUsage(): void {
  console.log(`Usage:
  termyte run -- <command>
  termyte logs [--limit N] [--json]
  termyte replay [--json]
  termyte memory [--limit N] [--json]
  termyte policies
  termyte inspect [--json] -- <command>`);
}

function parseLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index === -1) return 50;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50;
}

function hasJsonFlag(args: string[]): boolean {
  return args.includes("--json");
}

function commandAfterDoubleDash(args: string[]): string {
  const separatorIndex = args.indexOf("--");
  return separatorIndex >= 0 ? args.slice(separatorIndex + 1).join(" ") : args.slice(1).join(" ");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  const cwd = process.cwd();
  const dbPath = defaultDbPath(cwd);
  const dbContext = openDatabase(dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);

  if (!command) {
    printUsage();
    return 1;
  }

  if (command === "run") {
    const rawCommand = commandAfterDoubleDash(args);
    if (!rawCommand) {
      console.error("Missing command after `termyte run --`.");
      return 1;
    }

    const approval = async (reason: string): Promise<boolean> => {
      const rl = readline.createInterface({ input, output });
      const answer = (await rl.question(`\n${reason}\nApprove? [y/N] `)).trim().toLowerCase();
      rl.close();
      return answer === "y" || answer === "yes";
    };

    const result = await runRuntime({
      command: rawCommand,
      cwd,
      dbPath,
      approval,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (!result.wasExecuted) {
      process.stderr.write(`termyte ${result.decision}: ${result.semanticId} (${result.reason})\n`);
    }

    return result.exitCode;
  }

  if (command === "inspect") {
    const rawCommand = commandAfterDoubleDash(args);
    if (!rawCommand) {
      console.error("Missing command after `termyte inspect --`.");
      return 1;
    }

    const inspection = inspectAction(rawCommand, cwd);
    if (hasJsonFlag(args)) {
      console.log(toJson(inspection));
    } else {
      console.log(formatInspection(inspection));
    }
    return 0;
  }

  if (command === "logs") {
    const records = ledger.listLatest(parseLimit(args));
    if (hasJsonFlag(args)) {
      console.log(toJson(records));
    } else {
      console.log(formatLedger(records));
    }
    return 0;
  }

  if (command === "replay") {
    const records = ledger.replay();
    if (hasJsonFlag(args)) {
      console.log(toJson(replayEntries(records)));
    } else {
      console.log(formatReplay(records));
    }
    return 0;
  }

  if (command === "memory") {
    const records = memory.list(parseLimit(args));
    if (hasJsonFlag(args)) {
      console.log(toJson(records));
    } else {
      console.log(formatMemory(records));
    }
    return 0;
  }

  if (command === "policies") {
    console.log(inspectPolicies(defaultPolicies));
    return 0;
  }

  printUsage();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
