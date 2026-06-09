import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultDbPath, openDatabase } from "./db.js";
import { DEFAULT_POLICY_VERSION, analyzePolicyDrift, loadPolicyState, validatePolicySet } from "./policy.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  id: string;
  section: string;
  label: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  generatedAt: string;
  termyteVersion: string;
  cwd: string;
  platform: NodeJS.Platform;
  arch: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: DoctorCheck[];
}

const DOCTOR_SECTIONS = ["System", "Workspace", "Tools", "Package"] as const;

export async function runDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const packageRoot = packageRootFromImport();
  const packageJson = readPackageJson(packageRoot);

  addCheck(checks, {
    id: "system.platform",
    section: "System",
    label: "OS platform",
    status: "PASS",
    message: `${process.platform} ${process.arch}`,
    details: { platform: process.platform, arch: process.arch, release: os.release() },
  });
  addCheck(checks, checkNodeVersion());
  addCheck(checks, checkCommandVersion("npm", ["--version"], true, "npm not found. Install Node.js/npm or confirm npm is on PATH."));
  addCheck(checks, checkCommandVersion("git", ["--version"], false, "git not found. Install Git or confirm git is on PATH if your agent uses git."));

  addCheck(checks, {
    id: "workspace.cwd",
    section: "Workspace",
    label: "Current working directory",
    status: fs.existsSync(cwd) ? "PASS" : "FAIL",
    message: cwd,
  });
  addCheck(checks, checkWriteAccess(cwd, "workspace.write", "Workspace write access"));
  addCheck(checks, checkDbWritable(cwd));
  addCheck(checks, checkPolicyLoadable(cwd));
  addCheck(checks, checkDirectoryCreatable(path.join(cwd, ".termyte"), "workspace.termyte_dir", ".termyte directory"));

  addCheck(checks, checkNpmGlobalBinPath());
  addCheck(checks, optionalAgentCheck("codex", "Codex CLI"));
  addCheck(checks, optionalAgentCheck("claude", "Claude Code"));

  addCheck(checks, checkPackageBin(packageRoot, packageJson));
  addCheck(checks, checkBundledBenchmarkFile(packageRoot, cwd));
  addCheck(checks, checkBenchRunsFromPackage(packageRoot));

  return {
    generatedAt: new Date().toISOString(),
    termyteVersion: typeof packageJson.version === "string" ? packageJson.version : "unknown",
    cwd,
    platform: process.platform,
    arch: process.arch,
    summary: summarizeChecks(checks),
    checks,
  };
}

export function formatDoctorHuman(report: DoctorReport): string {
  const lines = [
    `Termyte doctor ${report.termyteVersion}`,
    `cwd: ${report.cwd}`,
    `summary: ${report.summary.pass} PASS, ${report.summary.warn} WARN, ${report.summary.fail} FAIL`,
    "",
  ];

  for (const section of DOCTOR_SECTIONS) {
    const sectionChecks = report.checks.filter((check) => check.section === section);
    if (sectionChecks.length === 0) continue;
    lines.push(`${section}:`);
    for (const check of sectionChecks) {
      lines.push(`  ${check.status.padEnd(4)} ${check.label}: ${check.message}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

export function summarizeChecks(checks: DoctorCheck[]): DoctorReport["summary"] {
  return {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
}

export function evaluateWindowsPathNormalization(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DoctorCheck {
  if (platform !== "win32") {
    return {
      id: "windows.path_normalization",
      section: "Tools",
      label: "Windows PATH/Path normalization",
      status: "PASS",
      message: "Not applicable on this platform.",
    };
  }

  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  return {
    id: "windows.path_normalization",
    section: "Tools",
    label: "Windows PATH/Path normalization",
    status: pathKeys.length === 1 ? "PASS" : "FAIL",
    message: pathKeys.length === 1 ? `Single path key: ${pathKeys[0]}` : `Expected one PATH key, found ${pathKeys.join(", ")}`,
    details: { pathKeys },
  };
}

export function evaluateWindowsPathext(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DoctorCheck {
  if (platform !== "win32") {
    return {
      id: "windows.pathext",
      section: "System",
      label: "Windows PATHEXT",
      status: "PASS",
      message: "Not applicable on this platform.",
    };
  }

  const pathext = env.PATHEXT ?? "";
  const normalized = pathext.toLowerCase().split(";").filter(Boolean);
  const hasCmd = normalized.includes(".cmd");
  const hasExe = normalized.includes(".exe");
  return {
    id: "windows.pathext",
    section: "System",
    label: "Windows PATHEXT",
    status: hasCmd && hasExe ? "PASS" : "WARN",
    message: hasCmd && hasExe
      ? "PATHEXT includes .EXE and .CMD."
      : "PATHEXT is missing .EXE or .CMD; Windows command discovery may be limited.",
    details: { pathext },
  };
}

export function resolveBenchmarkFile(packageRoot: string, cwd: string): string | null {
  const candidates = [
    path.join(packageRoot, "benchmarks", "commands.json"),
    path.join(cwd, "benchmarks", "commands.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function addCheck(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    id: "system.node",
    section: "System",
    label: "Node.js",
    status: Number.isFinite(major) && major >= 20 ? "PASS" : "FAIL",
    message: Number.isFinite(major) && major >= 20
      ? `Node ${process.version}`
      : `Node ${process.version}; Termyte requires Node >=20.`,
    details: { version: process.version },
  };
}

function checkCommandVersion(command: string, args: string[], required: boolean, missingMessage: string): DoctorCheck {
  const resolved = findExecutable(command);
  if (!resolved) {
    return {
      id: `tool.${command}`,
      section: "Tools",
      label: `${command} availability`,
      status: required ? "FAIL" : "WARN",
      message: missingMessage,
    };
  }

  const result = runExecutable(resolved, args, process.cwd());
  const output = firstOutputLine(result);
  return {
    id: `tool.${command}`,
    section: "Tools",
    label: `${command} availability`,
    status: result.status === 0 ? "PASS" : required ? "FAIL" : "WARN",
    message: result.status === 0 ? `${resolved} ${output}` : `${command} found at ${resolved}, but version check failed: ${output}`,
    details: { path: resolved, exitCode: result.status },
  };
}

function checkWriteAccess(directory: string, id: string, label: string): DoctorCheck {
  const probe = path.join(directory, `.termyte-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(probe, "doctor", "utf8");
    fs.rmSync(probe, { force: true });
    return {
      id,
      section: "Workspace",
      label,
      status: "PASS",
      message: "Writable.",
    };
  } catch (error) {
    return {
      id,
      section: "Workspace",
      label,
      status: "FAIL",
      message: `Not writable: ${errorMessage(error)}`,
    };
  }
}

function checkDbWritable(cwd: string): DoctorCheck {
  const dbPath = defaultDbPath(cwd);
  try {
    const context = openDatabase(dbPath);
    context.db.prepare("SELECT 1").get();
    context.db.close();
    return {
      id: "workspace.db_path",
      section: "Workspace",
      label: "Termyte DB path",
      status: "PASS",
      message: `Writable: ${dbPath}`,
      details: { dbPath },
    };
  } catch (error) {
    return {
      id: "workspace.db_path",
      section: "Workspace",
      label: "Termyte DB path",
      status: "FAIL",
      message: `Cannot open SQLite DB at ${dbPath}: ${errorMessage(error)}`,
      details: { dbPath },
    };
  }
}

export function checkPolicyLoadable(cwd: string): DoctorCheck {
  const dbPath = defaultDbPath(cwd);
  try {
    const state = loadPolicyState(dbPath);
    const policies = state.policies;
    const errors = validatePolicySet(policies);
    const drift = analyzePolicyDrift(state);
    const missingDefaultCount = drift.missingBlockDefaults.length + drift.missingWarnDefaults.length;
    const shouldWarnForDrift = errors.length === 0 && drift.staleDefaultVersion && !drift.customized && missingDefaultCount > 0;
    return {
      id: "workspace.policy_state",
      section: "Workspace",
      label: "Policy state",
      status: errors.length > 0 ? "FAIL" : shouldWarnForDrift ? "WARN" : "PASS",
      message: errors.length === 0
        ? shouldWarnForDrift
          ? `Policies loaded but default policy version is stale (${state.metadata.defaultVersion}/${DEFAULT_POLICY_VERSION}); ${missingDefaultCount} current default rule(s) are missing. Run \`termyte policies reset\` to adopt current defaults, or keep custom policies intentionally.`
          : `Policies loaded: ${policies.block.length} block rules, ${policies.warn.length} warn rules.`
        : `Policy state is invalid: ${errors.join("; ")}`,
      details: {
        dbPath,
        blockRules: policies.block.length,
        warnRules: policies.warn.length,
        defaultVersion: state.metadata.defaultVersion,
        currentDefaultVersion: DEFAULT_POLICY_VERSION,
        customized: state.metadata.customized,
        drift,
        errors,
      },
    };
  } catch (error) {
    return {
      id: "workspace.policy_state",
      section: "Workspace",
      label: "Policy state",
      status: "FAIL",
      message: `Cannot load local policies from ${dbPath}: ${errorMessage(error)}`,
      details: { dbPath },
    };
  }
}

function checkDirectoryCreatable(directory: string, id: string, label: string): DoctorCheck {
  try {
    fs.mkdirSync(directory, { recursive: true });
    return {
      id,
      section: "Workspace",
      label,
      status: "PASS",
      message: `Creatable: ${directory}`,
      details: { path: directory },
    };
  } catch (error) {
    return {
      id,
      section: "Workspace",
      label,
      status: "FAIL",
      message: `Cannot create ${directory}: ${errorMessage(error)}`,
      details: { path: directory },
    };
  }
}

function checkNpmGlobalBinPath(): DoctorCheck {
  const npm = findExecutable("npm");
  if (!npm) {
    return {
      id: "tool.npm_global_bin",
      section: "Tools",
      label: "npm global bin path",
      status: "FAIL",
      message: "npm not found, so npm global bin path cannot be resolved.",
    };
  }

  const result = runExecutable(npm, ["config", "get", "prefix"], process.cwd());
  const prefix = String(result.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
  if (result.status !== 0 || !prefix) {
    return {
      id: "tool.npm_global_bin",
      section: "Tools",
      label: "npm global bin path",
      status: "WARN",
      message: `Could not resolve npm global prefix: ${firstOutputLine(result)}`,
    };
  }

  const binPath = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  return {
    id: "tool.npm_global_bin",
    section: "Tools",
    label: "npm global bin path",
    status: fs.existsSync(binPath) ? "PASS" : "WARN",
    message: fs.existsSync(binPath)
      ? `npm global bin path exists: ${binPath}`
      : `npm global bin path does not exist yet: ${binPath}`,
    details: { prefix, binPath },
  };
}

export function optionalAgentCheck(command: string, label: string, resolved = findExecutable(command)): DoctorCheck {
  return {
    id: `agent.${command}`,
    section: "Tools",
    label,
    status: resolved ? "PASS" : "WARN",
    message: resolved
      ? `${command} is discoverable at ${resolved}.`
      : `${command} is not discoverable. Install ${label} or confirm PATH before launching it through Termyte.`,
    details: { path: resolved },
  };
}

function checkPackageBin(packageRoot: string, packageJson: Record<string, unknown>): DoctorCheck {
  const bin = packageJson.bin as Record<string, unknown> | undefined;
  const binPath = typeof bin?.termyte === "string" ? path.join(packageRoot, bin.termyte) : "";
  return {
    id: "package.bin",
    section: "Package",
    label: "package bin entry",
    status: binPath && fs.existsSync(binPath) ? "PASS" : "FAIL",
    message: binPath && fs.existsSync(binPath)
      ? `termyte bin points to existing file: ${binPath}`
      : `package.json bin.termyte is missing or points to a missing file: ${binPath || "<missing>"}`,
    details: { binPath },
  };
}

function checkBundledBenchmarkFile(packageRoot: string, cwd: string): DoctorCheck {
  const benchmarkPath = resolveBenchmarkFile(packageRoot, cwd);
  return {
    id: "package.benchmark_file",
    section: "Package",
    label: "Bundled benchmark file",
    status: benchmarkPath ? "PASS" : "FAIL",
    message: benchmarkPath
      ? `Benchmark file found: ${benchmarkPath}`
      : "Benchmark file not found. Packaged `termyte bench --json` may fail.",
    details: { benchmarkPath },
  };
}

function checkBenchRunsFromPackage(packageRoot: string): DoctorCheck {
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  if (!fs.existsSync(cliPath)) {
    return {
      id: "package.bench_json",
      section: "Package",
      label: "Packaged bench --json",
      status: "FAIL",
      message: `Cannot run packaged bench; missing ${cliPath}`,
    };
  }

  const result = spawnSync(process.execPath, [cliPath, "bench", "--json"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    return {
      id: "package.bench_json",
      section: "Package",
      label: "Packaged bench --json",
      status: "FAIL",
      message: `termyte bench --json failed from packaged layout: ${result.error ? errorMessage(result.error) : firstOutputLine(result)}`,
      details: { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { summary?: { total?: number; falseNegatives?: number } };
    const total = parsed.summary?.total ?? 0;
    return {
      id: "package.bench_json",
      section: "Package",
      label: "Packaged bench --json",
      status: total > 0 ? "PASS" : "FAIL",
      message: total > 0
        ? `Benchmark runs from packaged layout: ${total} cases.`
        : "Benchmark command returned JSON but no cases.",
      details: { total, falseNegatives: parsed.summary?.falseNegatives },
    };
  } catch (error) {
    return {
      id: "package.bench_json",
      section: "Package",
      label: "Packaged bench --json",
      status: "FAIL",
      message: `Benchmark output was not valid JSON: ${errorMessage(error)}`,
    };
  }
}

function packageRootFromImport(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const parent = path.basename(currentDir) === "dist" || path.basename(currentDir) === "src"
    ? path.dirname(currentDir)
    : currentDir;
  return parent;
}

function readPackageJson(packageRoot: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes("/")) {
    return fs.existsSync(command) ? command : null;
  }

  const pathValue = env[pathEnvKey(env)] ?? "";
  const candidates = executableCandidates(command, env);
  for (const entry of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") {
    return [command];
  }

  if (path.extname(command)) {
    return [command];
  }

  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathext.split(";").filter(Boolean).map((ext) => `${command}${ext.toLowerCase()}`);
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runExecutable(executable: string, args: string[], cwd: string, timeout = 10_000): ReturnType<typeof spawnSync> {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    return spawnSync([quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(" "), {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout,
    });
  }

  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout,
  });
}

function firstOutputLine(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["^])/g, "^$1")}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
