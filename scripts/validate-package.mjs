import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-package-proof-"));
const packDir = path.join(tempRoot, "pack");
const prefixDir = path.join(tempRoot, "prefix");
const smokeDir = path.join(tempRoot, "smoke");
const demoDir = path.join(tempRoot, "demo");
const homeDir = path.join(tempRoot, "home");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const requiredPackageFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "benchmarks/commands.json",
  "benchmarks/governance.json",
  "dist/agent-hook.js",
  "dist/agent-runner.js",
  "dist/cli.js",
  "dist/mcp.js",
  "dist/proof.js",
  "docs/benchmark.md",
  "docs/demo.md",
  "package.json",
];
const forbiddenPackagePatterns = [
  /^\.termyte(?:\/|$)/,
  /^plans(?:\/|$)/,
  /^Progress(?:\/|$)/,
  /^src(?:\/|$)/,
  /^test(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(logs|memory)\.jsonl$/,
  /\.log$/,
  /\.tgz$/,
];

for (const directory of [packDir, prefixDir, smokeDir, demoDir, homeDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

try {
  run(npm, ["run", "build"], { cwd: root });

  const dryPack = run(npm, ["pack", "--dry-run", "--json"], { cwd: root });
  const dryPackEntry = parsePackEntry(dryPack.stdout);
  const packedFiles = dryPackEntry.files.map((entry) => normalizePath(entry.path));
  assertPackageContents(packedFiles);

  const pack = run(npm, ["pack", "--json", "--pack-destination", packDir], { cwd: root });
  const packEntry = parsePackEntry(pack.stdout);
  const tarball = path.join(packDir, packEntry.filename);
  assertFile(tarball, "packed tarball");

  run(npm, ["install", "--global", tarball, "--prefix", prefixDir, "--no-audit", "--no-fund"], {
    cwd: root,
    timeoutMs: 120_000,
  });

  const packageRoot = installedPackageRoot(prefixDir);
  const installedBin = installedBinary(prefixDir);
  for (const requiredFile of requiredPackageFiles) {
    assertFile(path.join(packageRoot, ...requiredFile.split("/")), `installed ${requiredFile}`);
  }
  assertFile(installedBin, "installed termyte binary");

  const env = {
    ...process.env,
    TERMYTE_HOME: homeDir,
  };

  const help = run(installedBin, ["--help"], { cwd: smokeDir, env });
  assertIncludes(help.stdout, "termyte policy presets", "help output");
  assertIncludes(help.stdout, "termyte run", "help output");
  assertIncludes(help.stdout, "termyte install", "help output");

  const presets = run(installedBin, ["policy", "presets"], { cwd: smokeDir, env });
  assertIncludes(presets.stdout, "safe-default", "policy presets output");

  const blockedCheck = run(installedBin, ["check", "cat .env", "--json"], {
    cwd: smokeDir,
    env,
    expectedStatuses: [1],
  });
  const blockedJson = JSON.parse(blockedCheck.stdout);
  assertEqual(blockedJson.decision, "block", "blocked check decision");
  assertEqual(blockedJson.executed, false, "blocked check execution state");

  const dryPolicy = run(installedBin, ["policy", "local", "add", "Ask before touching auth or payments", "--dry-run"], {
    cwd: smokeDir,
    env,
  });
  assertIncludes(dryPolicy.stdout, "Dry run only. No policy file was changed.", "policy dry-run output");
  assertMissing(path.join(smokeDir, "termyte.policy.yaml"), "policy dry-run output file");

  run(installedBin, ["mark-unsafe", "npm publish"], { cwd: smokeDir, env });
  const memory = run(installedBin, ["memory"], { cwd: smokeDir, env });
  assertIncludes(memory.stdout, "npm publish", "memory output");

  const logs = run(installedBin, ["logs"], { cwd: smokeDir, env });
  assertIncludes(logs.stdout, "cat .env", "logs output");

  const doctor = run(installedBin, ["doctor", "--json"], { cwd: smokeDir, env, timeoutMs: 120_000 });
  const doctorJson = JSON.parse(doctor.stdout);
  assertEqual(doctorJson.summary?.fail, 0, "packaged doctor failure count");

  const proof = run(installedBin, ["prove-runtime", "--json"], { cwd: smokeDir, env, timeoutMs: 120_000 });
  const proofJson = JSON.parse(proof.stdout);
  assertEqual(proofJson.summary?.fail, 0, "packaged runtime proof failure count");
  assertEqual(proofJson.summary?.warn, 1, "packaged runtime proof boundary warning count");

  const mcpInstall = run(installedBin, ["mcp", "install", "codex"], { cwd: smokeDir, env });
  assertIncludes(mcpInstall.stdout, '"termyte"', "mcp install output");
  assertIncludes(mcpInstall.stdout, '"mcp"', "mcp install output");
  assertIncludes(mcpInstall.stdout, '"serve"', "mcp install output");

  const mcpInstallJson = run(installedBin, ["mcp", "install", "codex", "--json"], { cwd: smokeDir, env });
  const mcpInstallConfig = JSON.parse(mcpInstallJson.stdout);
  assertEqual(mcpInstallConfig.mcpServers?.termyte?.env?.TERMYTE_WORKSPACE, smokeDir, "mcp install workspace binding");

  const mcpExchange = runMcpExchange(installedBin, smokeDir, env);
  assertIncludes(mcpExchange.stdout, '"termyte.git.status"', "mcp tools/list output");
  const mcpResponses = parseJsonLines(mcpExchange.stdout);
  const policyExplainText = mcpResponses.find((entry) => entry.id === 3)?.result?.content?.[0]?.text;
  const policyExplain = JSON.parse(policyExplainText ?? "{}");
  assertEqual(policyExplain.semanticId, "git.push.force", "mcp policy.explain semantic id");
  assertEqual(policyExplain.finalDecision, "block", "mcp policy.explain final decision");

  const missingAgent = run(installedBin, ["run", "definitely-missing-agent"], {
    cwd: smokeDir,
    env,
    expectedStatuses: [1],
  });
  assertIncludes(missingAgent.stderr, "Unknown agent: definitely-missing-agent", "missing agent output");
  assertExcludes(missingAgent.stderr, "ENOENT", "missing agent output");

  const agentDryRun = run(installedBin, ["run", "--dry-run", "codex"], { cwd: smokeDir, env });
  assertIncludes(agentDryRun.stdout, "Termyte agent run plan", "codex dry-run output");

  const installCodex = run(installedBin, ["install", "codex"], { cwd: smokeDir, env });
  assertIncludes(installCodex.stdout, "Installed Termyte codex hooks", "codex install output");
  const codexHookConfigPath = path.join(smokeDir, ".codex", "hooks.json");
  assertFile(codexHookConfigPath, "codex hook config");
  const codexHookConfig = JSON.parse(fs.readFileSync(codexHookConfigPath, "utf8"));
  const codexPreHook = codexHookConfig.hooks?.PreToolUse?.[0]?.hooks?.[0];
  assertEqual(Object.keys(codexPreHook ?? {}).sort().join(","), "command,commandWindows", "codex hook command fields");
  assertIncludes(codexPreHook.command, "node", "codex hook command");
  assertIncludes(normalizePath(codexPreHook.command), "dist/cli.js", "codex hook command");
  assertIncludes(codexPreHook.command, "agent hook codex", "codex hook command");
  assertEqual(codexPreHook.commandWindows, codexPreHook.command, "codex hook commandWindows");
  assertExcludes(JSON.stringify(codexHookConfig), "command_windows", "codex hook config");
  assertExcludes(JSON.stringify(codexHookConfig), "termyte agent hook codex", "codex hook config");

  const installCodexAgain = run(installedBin, ["install", "codex"], { cwd: smokeDir, env });
  assertIncludes(installCodexAgain.stdout, "Installed Termyte codex hooks", "codex reinstall output");
  assertEqual(fs.readFileSync(codexHookConfigPath, "utf8"), JSON.stringify(codexHookConfig, null, 2) + "\n", "codex install idempotency");

  const hookInput = JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: smokeDir,
    tool_name: "Bash",
    tool_input: {
      command: "git push --force origin main",
    },
  });
  const hookSmoke = runGeneratedHookCommand(codexPreHook.commandWindows, {
    cwd: smokeDir,
    env: {
      ...env,
      TERMYTE_SESSION_ID: "tm_package",
      TERMYTE_DB_PATH: path.join(smokeDir, ".termyte", "termyte.db"),
    },
    input: hookInput,
  });
  const hookJson = JSON.parse(hookSmoke.stdout);
  assertEqual(hookJson.hookSpecificOutput?.permissionDecision, "deny", "agent hook deny decision");

  const allowHookInput = JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd: smokeDir,
    tool_name: "Bash",
    tool_input: {
      command: "git status --short",
    },
  });
  const allowHookSmoke = runGeneratedHookCommand(codexPreHook.commandWindows, {
    cwd: smokeDir,
    env: {
      ...env,
      TERMYTE_SESSION_ID: "tm_package_allow",
      TERMYTE_DB_PATH: path.join(smokeDir, ".termyte", "termyte.db"),
    },
    input: allowHookInput,
  });
  assertEqual(allowHookSmoke.stdout.trim(), "{}", "agent hook allow output");

  const uninstallCodex = run(installedBin, ["uninstall", "codex"], { cwd: smokeDir, env });
  assertIncludes(uninstallCodex.stdout, "Removed Termyte codex hooks", "codex uninstall output");
  assertMissing(codexHookConfigPath, "codex hook config after uninstall");

  const bench = run(installedBin, ["bench", "--json"], { cwd: smokeDir, env, timeoutMs: 120_000 });
  const benchJson = JSON.parse(bench.stdout);
  if ((benchJson.summary?.total ?? 0) < 1200 || benchJson.summary?.falseSafe !== 0) {
    throw new Error(`packaged bench failed reliability expectations: ${JSON.stringify(benchJson.summary)}`);
  }

  verifyDemo(installedBin, demoDir, env);
  assertNoStateLeak(packageRoot);

  console.log(JSON.stringify({
    ok: true,
    package: {
      id: dryPackEntry.id,
      filename: packEntry.filename,
      size: packEntry.size,
      unpackedSize: packEntry.unpackedSize,
      files: packedFiles.length,
    },
    installedBinary: installedBin,
    doctor: doctorJson.summary,
    bench: benchJson.summary,
    smoke: {
      help: "pass",
      policyPresets: "pass",
      blockedCheck: "pass",
      policyDryRun: "pass",
      memory: "pass",
      logs: "pass",
      proof: "pass",
      mcpInstall: "pass",
      mcpExchange: "pass",
      missingAgent: "pass",
      agentInstall: "pass",
      agentHook: "pass",
      agentUninstall: "pass",
      demo: "pass",
    },
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function verifyDemo(installedBin, workspace, env) {
  const secret = run(installedBin, ["check", "cat .env"], { cwd: workspace, env, expectedStatuses: [1] });
  assertIncludes(secret.stdout, "Decision: block", "demo secret check");

  const forcePush = run(installedBin, ["check", "git push --force origin main"], {
    cwd: workspace,
    env,
    expectedStatuses: [1],
  });
  assertIncludes(forcePush.stdout, "Decision: block", "demo force-push check");

  const publish = run(installedBin, ["check", "npm publish"], { cwd: workspace, env });
  assertIncludes(publish.stdout, "Decision: warn", "demo package publish check");

  run(installedBin, ["policy", "test", "cat .env"], { cwd: workspace, env, expectedStatuses: [1] });

  run(installedBin, ["policy", "local", "add", "Ask before touching auth or payments", "--dry-run"], { cwd: workspace, env });
  assertMissing(path.join(workspace, "termyte.policy.yaml"), "demo policy dry-run output file");

  run(installedBin, ["policy", "local", "add", "Ask before touching auth or payments", "--yes"], { cwd: workspace, env });
  assertFile(path.join(workspace, "termyte.policy.yaml"), "demo local policy");

  const blockedLogs = run(installedBin, ["logs", "--blocked"], { cwd: workspace, env });
  assertIncludes(blockedLogs.stdout, "cat .env", "demo blocked logs");

  run(installedBin, ["mark-unsafe", "npm test"], { cwd: workspace, env });
  const memoryWarn = run(installedBin, ["check", "npm test"], { cwd: workspace, env });
  assertIncludes(memoryWarn.stdout, "Decision: warn", "demo memory-influenced check");

  const memory = run(installedBin, ["memory"], { cwd: workspace, env });
  assertIncludes(memory.stdout, "npm test", "demo memory output");
}

function runMcpExchange(installedBin, cwd, env) {
  const stdin = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "termyte.policy.explain",
        arguments: {
          command: "git push --force origin main",
        },
      },
    }),
    "",
  ].join("\n");
  return run(installedBin, ["mcp", "serve"], {
    cwd,
    env,
    input: stdin,
    timeoutMs: 30_000,
  });
}

function runGeneratedHookCommand(commandLine, options = {}) {
  const result = spawnSync(commandLine, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error([
      `Generated hook command failed: ${commandLine}`,
      `exit: ${result.status}`,
      `stdout: ${result.stdout ?? ""}`.trimEnd(),
      `stderr: ${result.stderr ?? ""}`.trimEnd(),
      result.error ? `error: ${result.error.message}` : "",
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function assertPackageContents(files) {
  for (const required of requiredPackageFiles) {
    if (!files.includes(required)) {
      throw new Error(`Packed package is missing required file: ${required}`);
    }
  }
  for (const file of files) {
    for (const pattern of forbiddenPackagePatterns) {
      if (pattern.test(file)) {
        throw new Error(`Packed package contains forbidden file: ${file}`);
      }
    }
  }
}

function assertNoStateLeak(packageRoot) {
  const packageFiles = walkFiles(packageRoot, new Set(["node_modules"])).map((file) => normalizePath(path.relative(packageRoot, file)));
  for (const file of packageFiles) {
    if (forbiddenPackagePatterns.some((pattern) => pattern.test(file))) {
      throw new Error(`Installed package contains forbidden state or source file: ${file}`);
    }
  }
}

function walkFiles(directory, skippedDirectories = new Set()) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      return [];
    }
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath, skippedDirectories) : [fullPath];
  });
}

function run(command, args, options = {}) {
  const expectedStatuses = options.expectedStatuses ?? [0];
  const isWindowsCommandScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const result = isWindowsCommandScript ? spawnSync([quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" "), {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    shell: true,
  }) : spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
  });
  if (!expectedStatuses.includes(result.status)) {
    throw new Error([
      `Command failed: ${command} ${args.join(" ")}`,
      `exit: ${result.status}`,
      `expected: ${expectedStatuses.join(", ")}`,
      `stdout: ${result.stdout ?? ""}`.trimEnd(),
      `stderr: ${result.stderr ?? ""}`.trimEnd(),
      result.error ? `error: ${result.error.message}` : "",
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function parsePackEntry(value) {
  const entries = JSON.parse(value);
  const entry = Array.isArray(entries) ? entries[0] : undefined;
  if (!entry || typeof entry.filename !== "string" || !Array.isArray(entry.files)) {
    throw new Error("npm pack did not return a valid package manifest");
  }
  return entry;
}

function parseJsonLines(value) {
  return String(value)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function installedPackageRoot(prefix) {
  return process.platform === "win32"
    ? path.join(prefix, "node_modules", "termyte")
    : path.join(prefix, "lib", "node_modules", "termyte");
}

function installedBinary(prefix) {
  return process.platform === "win32"
    ? path.join(prefix, "termyte.cmd")
    : path.join(prefix, "bin", "termyte");
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function assertMissing(filePath, label) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Unexpected ${label}: ${filePath}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!String(value).includes(expected)) {
    throw new Error(`${label} did not include ${expected}`);
  }
}

function assertExcludes(value, unexpected, label) {
  if (String(value).includes(unexpected)) {
    throw new Error(`${label} unexpectedly included ${unexpected}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function quoteCmdArg(value) {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/(["^])/g, "^$1")}"`;
}
