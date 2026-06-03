import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-package-proof-"));
const packDir = path.join(tempRoot, "pack");
const installDir = path.join(tempRoot, "install");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(installDir, { recursive: true });

try {
  run(npm, ["run", "build"], { cwd: root });
  const pack = run(npm, ["pack", "--json", "--pack-destination", packDir], { cwd: root });
  const packEntries = JSON.parse(pack.stdout);
  const filename = Array.isArray(packEntries) ? packEntries[0]?.filename : undefined;
  const tarball = filename ? path.join(packDir, filename) : findTarball(packDir);
  if (!tarball || !fs.existsSync(tarball)) {
    throw new Error(`npm pack did not produce a tarball in ${packDir}`);
  }

  run(npm, ["install", tarball, "--prefix", installDir, "--no-audit", "--no-fund"], { cwd: root, timeoutMs: 120_000 });

  const packageRoot = path.join(installDir, "node_modules", "termyte");
  const cli = path.join(packageRoot, "dist", "cli.js");
  assertFile(cli, "installed CLI");
  assertFile(path.join(packageRoot, "benchmarks", "commands.json"), "installed benchmark file");

  const env = {
    ...process.env,
    TERMYTE_DB_PATH: path.join(installDir, ".termyte", "termyte.db"),
  };

  const help = run(process.execPath, [cli, "--help"], { cwd: installDir, env });
  assertIncludes(help.stdout, "termyte run", "help output");

  const doctor = run(process.execPath, [cli, "doctor", "--json"], { cwd: installDir, env, timeoutMs: 120_000 });
  const doctorJson = JSON.parse(doctor.stdout);
  if (doctorJson.summary?.fail !== 0) {
    throw new Error(`packaged doctor reported ${doctorJson.summary?.fail ?? "unknown"} failure(s)`);
  }

  const dryRun = run(process.execPath, [cli, "run", "--dry-run", "codex"], { cwd: installDir, env });
  assertIncludes(dryRun.stdout, "Termyte agent run dry run", "codex dry-run output");

  const shell = run(process.execPath, [cli, "shell", "--", "node", "--version"], { cwd: installDir, env, timeoutMs: 120_000 });
  assertIncludes(shell.stdout, process.version, "shell node smoke output");

  const bench = run(process.execPath, [cli, "bench", "--json"], { cwd: installDir, env, timeoutMs: 120_000 });
  const benchJson = JSON.parse(bench.stdout);
  if ((benchJson.summary?.total ?? 0) < 230 || benchJson.summary?.falseNegatives !== 0) {
    throw new Error(`packaged bench failed reliability expectations: ${JSON.stringify(benchJson.summary)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    packageRoot,
    doctor: doctorJson.summary,
    bench: benchJson.summary,
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const isWindowsCommandScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = isWindowsCommandScript ? spawnSync([quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" "), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    shell: true,
  }) : spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(" ")}`,
      `exit: ${result.status}`,
      `stdout: ${result.stdout ?? ""}`.trimEnd(),
      `stderr: ${result.stderr ?? ""}`.trimEnd(),
      result.error ? `error: ${result.error.message}` : "",
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!String(value).includes(expected)) {
    throw new Error(`${label} did not include ${expected}`);
  }
}

function findTarball(directory) {
  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(directory, entry))[0];
}

function quoteCmdArg(value) {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["^])/g, "^$1")}"`;
}
