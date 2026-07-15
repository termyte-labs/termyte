import { runEval, type EvalSuiteName, type EvalReport } from "../eval/harness.js";
import { pathToFileURL } from "node:url";

export interface EvalCommandOptions {
  suite?: string;
  json?: boolean;
  corpus?: string;
}

export async function evalCommand(options: EvalCommandOptions = {}): Promise<EvalReport> {
  const suite = parseSuite(options.suite);
  const report = await runEval({
    suite,
    corpusPath: options.corpus,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderEvalReport(report));
  }

  return report;
}

export function parseSuite(value: string | undefined): EvalSuiteName {
  if (!value) return "all";
  if (value === "all" || value === "retrieval" || value === "durability" || value === "lifecycle" || value === "correction") {
    return value;
  }
  throw new Error(`Invalid eval suite "${value}". Expected all, retrieval, durability, lifecycle, or correction.`);
}

export function renderEvalReport(report: EvalReport): string {
  const lines = [
    `${title(report.suite)} Eval`,
    ...Object.entries(report.metrics).map(([key, value]) => `${key}: ${formatMetric(value)}`),
    report.passed ? "PASS" : "FAIL",
  ];

  if (report.failures.length > 0) {
    lines.push("", "Failures:");
    for (const failure of report.failures) {
      lines.push(`- ${failure.caseId}: ${failure.message}`);
    }
  }

  return lines.join("\n") + "\n";
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  evalCommand({ suite: value("--suite"), corpus: value("--corpus"), json: args.includes("--json") })
    .then((report) => { process.exitCode = report.passed ? 0 : 1; })
    .catch((error) => {
      process.stderr.write(`termyte eval: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
