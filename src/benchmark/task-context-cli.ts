import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evaluateTaskContextCorpus, parseTaskContextCorpus, renderTaskContextReport } from "./task-context.js";

const input = process.argv[2];
const output = resolve(process.argv[3] ?? "task-context-results");
if (!input) throw new Error("Usage: task-context-cli <corpus.json> [output-directory]");
const corpus = parseTaskContextCorpus(await readFile(resolve(input), "utf8"));
const evaluation = evaluateTaskContextCorpus(corpus);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, "metrics.json"), JSON.stringify(evaluation.metrics, null, 2) + "\n"),
  writeFile(join(output, "results.json"), JSON.stringify(evaluation.rows, null, 2) + "\n"),
  writeFile(join(output, "report.md"), renderTaskContextReport(corpus, evaluation.metrics)),
]);
console.log(renderTaskContextReport(corpus, evaluation.metrics));
