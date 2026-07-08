import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CompetitorExecutionAdapter {
  source: "agentmemory" | "mem0" | "claude-mem";
  repository: string;
  executable: boolean;
  commands: string[];
  publicArtifacts: string[];
  notes: string;
}

export interface CompetitorBenchmarkRequest {
  source: CompetitorExecutionAdapter["source"];
  benchmark: "quality" | "scale" | "real-embeddings" | "load-100k" | "beam";
  rootDirectory: string;
  mode?: "bm25" | "vector" | "hybrid";
  projectName?: string;
  backend?: "oss" | "cloud";
  mem0ApiKey?: string;
  mem0Host?: string;
  dryRun?: boolean;
}

export interface CompetitorBenchmarkPlan {
  source: CompetitorExecutionAdapter["source"];
  executable: boolean;
  reason?: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  expectedArtifacts: string[];
}

export interface CompetitorBenchmarkRunResult {
  plan: CompetitorBenchmarkPlan;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function loadCompetitorExecutionAdapters(rootDirectory: string): Promise<CompetitorExecutionAdapter[]> {
  const root = resolve(rootDirectory);
  const adapters: CompetitorExecutionAdapter[] = [];

  if (await exists(join(root, "agentmemory", "package.json"))) {
    adapters.push({
      source: "agentmemory",
      repository: join(root, "agentmemory"),
      executable: true,
      commands: [
        "npm run bench:quality",
        "npm run bench:scale",
        "npm run bench:real-embeddings",
      ],
      publicArtifacts: [
        "benchmark/results/load-100k-*.json",
        "benchmark/LONGMEMEVAL.md",
        "benchmark/QUALITY.md",
        "benchmark/REAL-EMBEDDINGS.md",
        "benchmark/SCALE.md",
      ],
      notes: "Node-based benchmark scripts are present in the local checkout.",
    });
  }

  if (await exists(join(root, "mem0", "pyproject.toml"))) {
    adapters.push({
      source: "mem0",
      repository: join(root, "mem0"),
      executable: true,
      commands: [
        "python -m benchmarks.beam.run --project-name <name> --chat-sizes 1M|10M --conversations 0-99 --top-k 200",
      ],
      publicArtifacts: [
        "results/[benchmark]/",
        "docs/core-concepts/memory-evaluation.mdx",
      ],
      notes: "The public evaluation framework is documented in the local checkout; Termyte can compare published outputs and mirror the runner contract.",
    });
  }

  if (await exists(join(root, "claude-mem", "package.json"))) {
    adapters.push({
      source: "claude-mem",
      repository: join(root, "claude-mem"),
      executable: false,
      commands: [],
      publicArtifacts: [
        "docs/public/smart-explore-benchmark.mdx",
      ],
      notes: "No standalone benchmark runner was found in the local checkout; only the published Smart Explore report is machine-readable here.",
    });
  }

  return adapters;
}

export async function planCompetitorBenchmarkRun(request: CompetitorBenchmarkRequest): Promise<CompetitorBenchmarkPlan> {
  const root = resolve(request.rootDirectory);
  const source = request.source;

  if (source === "agentmemory") {
    const repo = join(root, "agentmemory");
    if (!(await exists(join(repo, "package.json")))) {
      return unavailable(source, repo, "agentmemory checkout not found");
    }
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = benchmarkArgsForAgentMemory(request.benchmark, request.mode);
    return {
      source,
      executable: true,
      cwd: repo,
      command,
      args,
      env: {},
      expectedArtifacts: artifactsForAgentMemory(request.benchmark, request.mode),
    };
  }

  if (source === "mem0") {
    const repo = join(root, "mem0");
    const evaluation = join(repo, "evaluation");
    if (!(await exists(join(repo, "pyproject.toml")))) {
      return unavailable(source, repo, "mem0 checkout not found");
    }
    if (!(await exists(evaluation))) {
      return unavailable(source, repo, "mem0 evaluation submodule is missing; run git submodule update --init evaluation");
    }
    const command = process.platform === "win32" ? "python" : "python3";
    const args = benchmarkArgsForMem0(request.benchmark, request.projectName ?? "termyte-bench", request.backend ?? "oss", request.mem0ApiKey, request.mem0Host);
    return {
      source,
      executable: true,
      cwd: evaluation,
      command,
      args,
      env: {},
      expectedArtifacts: artifactsForMem0(request.benchmark),
    };
  }

  return unavailable("claude-mem", join(root, "claude-mem"), "claude-mem exposes published benchmark results but no local benchmark runner");
}

export async function runCompetitorBenchmark(request: CompetitorBenchmarkRequest): Promise<CompetitorBenchmarkRunResult> {
  const plan = await planCompetitorBenchmarkRun(request);
  if (request.dryRun || !plan.executable) {
    return { plan, exitCode: plan.executable ? 0 : 1, stdout: "", stderr: plan.reason ?? "" };
  }
  const { code, stdout, stderr } = await spawnFile(plan.command, plan.args, plan.cwd, plan.env);
  return { plan, exitCode: code, stdout, stderr };
}

function benchmarkArgsForAgentMemory(benchmark: CompetitorBenchmarkRequest["benchmark"], mode?: "bm25" | "vector" | "hybrid"): string[] {
  switch (benchmark) {
    case "quality":
      return ["run", "bench:quality"];
    case "scale":
      return ["run", "bench:scale"];
    case "real-embeddings":
      return ["run", "bench:real-embeddings"];
    case "load-100k":
      return ["run", "bench:load"];
    default:
      throw new Error(`Unsupported agentmemory benchmark: ${benchmark}`);
  }
}

function artifactsForAgentMemory(benchmark: CompetitorBenchmarkRequest["benchmark"], mode?: "bm25" | "vector" | "hybrid"): string[] {
  switch (benchmark) {
    case "quality":
      return ["benchmark/QUALITY.md"];
    case "scale":
      return ["benchmark/SCALE.md"];
    case "real-embeddings":
      return ["benchmark/REAL-EMBEDDINGS.md"];
    case "load-100k":
      return ["benchmark/results/load-100k-<git-sha>.json"];
    default:
      throw new Error(`Unsupported agentmemory benchmark: ${benchmark}`);
  }
}

function benchmarkArgsForMem0(
  benchmark: CompetitorBenchmarkRequest["benchmark"],
  projectName: string,
  backend: "oss" | "cloud",
  mem0ApiKey?: string,
  mem0Host?: string,
): string[] {
  const common = ["-m", `benchmarks.${benchmark}.run`, "--project-name", projectName, "--top-k", "200"];
  if (backend === "cloud") {
    const args = [...common, "--backend", "cloud"];
    if (mem0ApiKey) args.push("--mem0-api-key", mem0ApiKey);
    if (mem0Host) args.push("--mem0-host", mem0Host);
    return args;
  }
  return common;
}

function artifactsForMem0(benchmark: CompetitorBenchmarkRequest["benchmark"]): string[] {
  switch (benchmark) {
    case "beam":
      return ["results/beam/"];
    default:
      return [`results/${benchmark}/`];
  }
}

function unavailable(source: CompetitorExecutionAdapter["source"], cwd: string, reason: string): CompetitorBenchmarkPlan {
  return {
    source,
    executable: false,
    reason,
    cwd,
    command: "",
    args: [],
    env: {},
    expectedArtifacts: [],
  };
}

async function spawnFile(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
