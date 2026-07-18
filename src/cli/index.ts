#!/usr/bin/env node

const USAGE = `Termyte - local-first context engine for coding agents

Usage:
  termyte <command>

Commands:
  init       Connect Termyte to supported coding agents
  viewer     Open the local context and diagnostics viewer
  doctor     Check installation and runtime health
  task       Create, inspect, verify, checkpoint, resume, or hand off tasks
  uninstall  Remove Termyte integrations
  help       Show this help
`;

function parseOptions(argv: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index++;
    } else {
      options[key] = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const options = parseOptions(rest);
  try {
    switch (command) {
      case "init": {
        const { initCommand } = await import("./init.js");
        process.exitCode = await initCommand();
        return;
      }
      case "viewer": {
        const { viewerCommand } = await import("./viewer.js");
        await viewerCommand({
          host: typeof options["host"] === "string" ? options["host"] : undefined,
          port: typeof options["port"] === "string" ? Number.parseInt(options["port"], 10) : undefined,
          open: options["no-open"] !== true,
        });
        return;
      }
      case "doctor": {
        const doctor = await import("./doctor.js");
        if (options["json"] === true) await doctor.runDoctorJson();
        else await doctor.runMain();
        return;
      }
      case "task": {
        const { taskCommand } = await import("./task.js");
        process.exitCode = await taskCommand(rest[0], options);
        return;
      }
      case "uninstall": {
        const { uninstallCommand } = await import("./uninstall.js");
        process.exitCode = await uninstallCommand();
        return;
      }
      default:
        process.stderr.write(`termyte: '${command}' is not a public command. Open 'termyte viewer' to inspect and manage context.\n`);
        process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`termyte: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
