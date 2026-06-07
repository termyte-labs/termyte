import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:net";
import { defaultDbPath, openDatabase } from "./db.js";
import { Ledger } from "./ledger.js";
import { DEFAULT_POLICY_VERSION, analyzePolicyDrift, loadPolicyState, validatePolicySet } from "./policy.js";
import { buildSessionEnv, createGovernedSession, resolveRealExecutable, startGuardDaemon, verifyShimManifest, type GovernedSession } from "./shell.js";

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

const DOCTOR_SECTIONS = ["System", "Workspace", "Shell Runtime", "Tools", "Package"] as const;

export async function runDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const packageRoot = packageRootFromImport();
  const packageJson = readPackageJson(packageRoot);
  let session: GovernedSession | undefined;
  let server: Server | undefined;

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

  try {
    session = createGovernedSession(cwd);
    addCheck(checks, {
      id: "shell.session_dir",
      section: "Shell Runtime",
      label: "Session directory",
      status: "PASS",
      message: session.sessionDir,
    });
    addCheck(checks, {
      id: "shell.shim_dir",
      section: "Shell Runtime",
      label: "Shim directory",
      status: "PASS",
      message: session.shimDir,
    });
    const manifestCheck = verifyShimManifest(session);
    addCheck(checks, {
      id: "shell.shim_manifest",
      section: "Shell Runtime",
      label: "Shim manifest",
      status: manifestCheck.ok ? "PASS" : "FAIL",
      message: manifestCheck.ok ? "Shim manifest created and verified." : manifestCheck.reasons.join("; "),
      details: { manifestPath: session.shimManifestPath, reasons: manifestCheck.reasons },
    });

    const env = buildSessionEnv(session);
    addCheck(checks, checkPathInsertion(env, session));
    addCheck(checks, evaluateWindowsPathNormalization(env, process.platform));
    addCheck(checks, evaluateWindowsPathext(process.env, process.platform));

    server = startGuardDaemon(session);
    await waitForListening(server);
    addCheck(checks, await checkDaemonIpc(session));
    addCheck(checks, await checkShimSmoke(session, env));
    addCheck(checks, checkNestedShimResolution(session));
    addCheck(checks, checkStaleShimRows(session));
  } catch (error) {
    addCheck(checks, {
      id: "shell.startup",
      section: "Shell Runtime",
      label: "Shell runtime startup",
      status: "FAIL",
      message: `Shell runtime cannot start: ${errorMessage(error)}`,
    });
  } finally {
    if (server) {
      await closeServer(server);
    }
  }

  addCheck(checks, checkNpmGlobalBinPath());
  addCheck(checks, optionalAgentCheck("codex", "Codex CLI"));
  addCheck(checks, optionalAgentCheck("claude", "Claude Code"));
  addCheck(checks, optionalAgentCheck("aider", "Aider"));
  addCheck(checks, checkShellAvailability("bash"));
  addCheck(checks, checkShellAvailability("zsh"));
  addCheck(checks, checkWindowsPowerShell());
  addCheck(checks, checkWindowsPsReadLine());
  addCheck(checks, checkWsl());

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
      section: "Shell Runtime",
      label: "Windows PATH/Path normalization",
      status: "PASS",
      message: "Not applicable on this platform.",
    };
  }

  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  return {
    id: "windows.path_normalization",
    section: "Shell Runtime",
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
      ? `PATHEXT includes .EXE and .CMD.`
      : `PATHEXT is missing .EXE or .CMD; Windows command discovery may be limited.`,
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
  const output = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
  return {
    id: `tool.${command}`,
    section: "Tools",
    label: `${command} availability`,
    status: result.status === 0 ? "PASS" : required ? "FAIL" : "WARN",
    message: result.status === 0 ? `${resolved} ${output}` : `${command} found at ${resolved}, but version check failed: ${firstOutputLine(result)}`,
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

function checkPathInsertion(env: NodeJS.ProcessEnv, session: GovernedSession): DoctorCheck {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const value = env[pathKey] ?? "";
  const first = value.split(path.delimiter)[0] ?? "";
  return {
    id: "shell.path_insertion",
    section: "Shell Runtime",
    label: "PATH insertion",
    status: path.resolve(first) === path.resolve(session.shimDir) ? "PASS" : "FAIL",
    message: path.resolve(first) === path.resolve(session.shimDir)
      ? "Shim directory is first in PATH."
      : "Shim directory is not first in PATH; subprocess interception may fail.",
    details: { pathKey, firstPathEntry: first, shimDir: session.shimDir },
  };
}

async function checkDaemonIpc(session: GovernedSession): Promise<DoctorCheck> {
  try {
    const response = await requestGuard(session.socketPath, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "doctor",
      commandLine: "echo termyte-doctor-ipc",
      cwd: session.workspaceRoot,
    });
    return {
      id: "shell.daemon_ipc",
      section: "Shell Runtime",
      label: "Daemon IPC smoke",
      status: response.decision === "allow" ? "PASS" : "FAIL",
      message: response.decision === "allow" ? "Guard daemon accepted a local IPC request." : `Guard returned ${response.decision}: ${response.reason}`,
      details: response,
    };
  } catch (error) {
    return {
      id: "shell.daemon_ipc",
      section: "Shell Runtime",
      label: "Daemon IPC smoke",
      status: "FAIL",
      message: `Daemon IPC failed; shell runtime cannot start: ${errorMessage(error)}`,
    };
  }
}

async function checkShimSmoke(session: GovernedSession, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const shimPath = process.platform === "win32" ? path.join(session.shimDir, "node.cmd") : path.join(session.shimDir, "node");
  const result = await spawnBuffered(shimPath, ["--version"], {
    cwd: session.workspaceRoot,
    env,
    timeoutMs: 10_000,
  });
  return {
    id: "shell.shim_smoke",
    section: "Shell Runtime",
    label: "Shim smoke request",
    status: result.exitCode === 0 ? "PASS" : "FAIL",
    message: result.exitCode === 0
      ? `Shim executed node successfully: ${firstBufferedLine(result)}`
      : `Shim smoke failed; shell runtime cannot govern subprocesses: ${result.errorMessage ?? firstBufferedLine(result)}`,
    details: { shimPath, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
  };
}

export function checkNestedShimResolution(session: GovernedSession): DoctorCheck {
  const fakeOlderShimDir = path.join(session.workspaceRoot, ".termyte", "sessions", "doctor-nested-smoke", "shims");
  const fakePreviewShimDir = path.join(session.workspaceRoot, ".termyte", "preview", "shims");
  const nodeDir = path.dirname(process.execPath);
  const syntheticOriginalPath = [
    fakeOlderShimDir,
    fakePreviewShimDir,
    nodeDir,
    session.originalPath,
  ].join(path.delimiter);
  const resolved = resolveRealExecutable("node", syntheticOriginalPath, session.shimDir);
  const expected = path.resolve(process.execPath);
  const ok = resolved ? path.resolve(resolved).toLowerCase() === expected.toLowerCase() : false;

  return {
    id: "shell.nested_shim_resolution",
    section: "Shell Runtime",
    label: "Nested shim resolution",
    status: ok ? "PASS" : "FAIL",
    message: ok
      ? "Nested runtime resolution skips older Termyte shim directories."
      : `Nested runtime resolution did not find the real Node executable; resolved ${resolved ?? "<missing>"}.`,
    details: {
      expected: process.execPath,
      resolved,
      syntheticShimEntries: [fakeOlderShimDir, fakePreviewShimDir],
    },
  };
}

export function checkStaleShimRows(session: GovernedSession): DoctorCheck {
  const { db } = openDatabase(session.dbPath);
  try {
    const rows = new Ledger(db).listLatest(200);
    const now = Date.now();
    const stalePending = rows.filter((row) => {
      if (row.status !== "planned" || row.decision !== "pending") return false;
      const metadata = safeParseMetadata(row.metadataJson);
      if (metadata.runtime !== "shell-shim" && metadata.shimRuntime !== true) return false;
      if (metadata.sessionId === session.sessionId) return false;
      const lastSeen = typeof metadata.lastHeartbeatAt === "string"
        ? Date.parse(metadata.lastHeartbeatAt)
        : Date.parse(row.createdAt);
      return Number.isFinite(lastSeen) && now - lastSeen > 60_000;
    });
    const recovered = rows.filter((row) => {
      const metadata = safeParseMetadata(row.metadataJson);
      return row.status === "failed" && metadata.recovered === true && typeof metadata.recoveryReason === "string";
    });

    return {
      id: "shell.stale_shim_rows",
      section: "Shell Runtime",
      label: "Stale shim rows",
      status: stalePending.length === 0 ? "PASS" : "WARN",
      message: stalePending.length === 0
        ? recovered.length === 0
          ? "No stale pending shell-shim rows found in recent ledger history."
          : `No stale pending shell-shim rows found; ${recovered.length} recent recovered shim failures remain visible in replay.`
        : `${stalePending.length} stale pending shell-shim row(s) found. Run doctor again; if new stale rows appear, subprocess finalization is unhealthy.`,
      details: {
        inspectedRows: rows.length,
        stalePendingCount: stalePending.length,
        recoveredFailureCount: recovered.length,
        stalePendingIds: stalePending.map((row) => row.id),
        recoveredFailureIds: recovered.map((row) => row.id),
      },
    };
  } finally {
    db.close();
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
      : `${command} is not discoverable. Install ${label} or confirm PATH before launching it through termyte shell.`,
    details: { path: resolved },
  };
}

function checkShellAvailability(command: "bash" | "zsh"): DoctorCheck {
  const resolved = findExecutable(command);
  return {
    id: `shell.${command}`,
    section: "Tools",
    label: `${command} availability`,
    status: resolved ? "PASS" : "WARN",
    message: resolved
      ? `${command} is discoverable at ${resolved}.`
      : `${command} is not discoverable; ${command} hook coverage will not be available on this machine.`,
    details: { path: resolved },
  };
}

function checkWindowsPowerShell(): DoctorCheck {
  if (process.platform !== "win32") {
    return {
      id: "windows.powershell",
      section: "Tools",
      label: "Windows PowerShell",
      status: "PASS",
      message: "Not applicable on this platform.",
    };
  }

  const executable = findExecutable("pwsh") ?? findExecutable("powershell");
  if (!executable) {
    return {
      id: "windows.powershell",
      section: "Tools",
      label: "Windows PowerShell",
      status: "WARN",
      message: "PowerShell not found. Interactive PowerShell hook coverage will be unavailable.",
    };
  }

  const result = runExecutable(executable, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], process.cwd());
  return {
    id: "windows.powershell",
    section: "Tools",
    label: "Windows PowerShell",
    status: result.status === 0 ? "PASS" : "WARN",
    message: result.status === 0
      ? `PowerShell available: ${firstOutputLine(result)}`
      : `PowerShell found at ${executable}, but version check failed: ${firstOutputLine(result)}`,
    details: { path: executable, exitCode: result.status },
  };
}

function checkWindowsPsReadLine(): DoctorCheck {
  if (process.platform !== "win32") {
    return {
      id: "windows.psreadline",
      section: "Tools",
      label: "PSReadLine",
      status: "PASS",
      message: "Not applicable on this platform.",
    };
  }

  const executable = findExecutable("pwsh") ?? findExecutable("powershell");
  if (!executable) {
    return {
      id: "windows.psreadline",
      section: "Tools",
      label: "PSReadLine",
      status: "WARN",
      message: "PowerShell not found; PSReadLine hook coverage may be limited.",
    };
  }

  const result = runExecutable(executable, [
    "-NoProfile",
    "-Command",
    "if (Get-Module -ListAvailable PSReadLine) { 'PSReadLine available' } else { exit 2 }",
  ], process.cwd());
  return {
    id: "windows.psreadline",
    section: "Tools",
    label: "PSReadLine",
    status: result.status === 0 ? "PASS" : "WARN",
    message: result.status === 0
      ? "PSReadLine is available for PowerShell hook coverage."
      : "PSReadLine missing; PowerShell hook coverage may be limited.",
    details: { exitCode: result.status },
  };
}

function checkWsl(): DoctorCheck {
  if (process.platform !== "win32") {
    return {
      id: "windows.wsl",
      section: "Tools",
      label: "WSL bash",
      status: "PASS",
      message: "Not applicable on this platform.",
    };
  }

  const wsl = findExecutable("wsl");
  if (!wsl) {
    return {
      id: "windows.wsl",
      section: "Tools",
      label: "WSL bash",
      status: "PASS",
      message: "WSL is not installed; not required for Termyte.",
    };
  }

  const result = runExecutable(wsl, ["-l", "-q"], process.cwd(), 5_000);
  const output = `${result.stdout}${result.stderr}`.trim();
  return {
    id: "windows.wsl",
    section: "Tools",
    label: "WSL bash",
    status: result.status === 0 && output ? "PASS" : "WARN",
    message: result.status === 0 && output
      ? "WSL has at least one installed distro."
      : "wsl.exe exists but no usable distro was detected; WSL bash launches may fail.",
    details: { exitCode: result.status, output },
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

function waitForListening(server: Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function requestGuard(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const payload = buffer.slice(0, newline).trim();
      if (!payload) {
        reject(new Error("Termyte guard returned an empty response."));
        socket.destroy();
        return;
      }
      try {
        resolve(JSON.parse(payload) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        socket.end();
      }
    });
    socket.on("error", reject);
  });
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

function spawnBuffered(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; errorMessage?: string }> {
  return new Promise((resolve) => {
    const useWindowsBatchShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
    const child = spawn(useWindowsBatchShell ? [quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(" ") : executable, useWindowsBatchShell ? [] : args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useWindowsBatchShell,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ exitCode: null, stdout, stderr, errorMessage: `Timed out after ${options.timeoutMs}ms.` });
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, errorMessage: errorMessage(error) });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: signal ? null : code,
        stdout,
        stderr,
        errorMessage: signal ? `Terminated by signal ${signal}.` : undefined,
      });
    });
  });
}

function firstOutputLine(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
}

function firstBufferedLine(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function safeParseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["^])/g, "^$1")}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
