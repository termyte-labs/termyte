#!/usr/bin/env node
const HELP = `Termyte gives coding agents the project context they need.\n\nUsage:\n  termyte init\n  termyte help\n`;
async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") { process.stdout.write(HELP); return; }
  if (command === "init") { const { initCommand } = await import("./init.js"); process.exitCode = await initCommand(); return; }
  process.stderr.write(`termyte: unknown command '${command}'\n`); process.exitCode = 2;
}
void main().catch((error) => { process.stderr.write(`termyte: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
