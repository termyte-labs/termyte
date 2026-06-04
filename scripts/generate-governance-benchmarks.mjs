import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outPath = path.join(root, "benchmarks", "governance.json");
const cases = [];
const allPlatforms = ["win32", "linux", "darwin"];

function addGroup({ category, expectedDecision, riskClass, tags, rationale, commands }) {
  for (const [index, command] of commands.entries()) {
    cases.push({
      id: `${category}-${String(index + 1).padStart(3, "0")}`,
      command,
      category,
      expectedDecision,
      riskClass,
      platforms: allPlatforms,
      tags,
      source: "generated-template",
      rationale,
    });
  }
}

const sequence = (count, render) => Array.from({ length: count }, (_, index) => render(index + 1));

addGroup({
  category: "safe.git-readonly",
  expectedDecision: "allow",
  riskClass: "safe",
  tags: ["git", "read-only"],
  rationale: "Read-only git inspection does not mutate repository state.",
  commands: sequence(100, (n) => `git log --max-count=${n}`),
});
addGroup({
  category: "safe.test-and-lint",
  expectedDecision: "allow",
  riskClass: "safe",
  tags: ["test", "validation"],
  rationale: "Test and lint commands are expected to inspect or validate local code.",
  commands: sequence(100, (n) => `npm test -- --benchmark-case=${n}`),
});
addGroup({
  category: "safe.file-read",
  expectedDecision: "allow",
  riskClass: "safe",
  tags: ["filesystem", "read-only"],
  rationale: "Reading an ordinary documentation file is low risk.",
  commands: sequence(100, (n) => `cat docs/benchmark-safe-${n}.md`),
});
addGroup({
  category: "safe.shell-inspection",
  expectedDecision: "allow",
  riskClass: "safe",
  tags: ["shell", "inspection"],
  rationale: "Printing a fixed non-secret value does not mutate local state.",
  commands: sequence(100, (n) => `echo benchmark-safe-${n}`),
});

addGroup({
  category: "warn.package-publish",
  expectedDecision: "warn",
  riskClass: "review-required",
  tags: ["package", "publish"],
  rationale: "Publishing changes public package release state and requires review.",
  commands: sequence(100, (n) => `npm publish --tag benchmark-${n}`),
});
addGroup({
  category: "warn.sql-delete-scoped",
  expectedDecision: "warn",
  riskClass: "review-required",
  tags: ["sql", "destructive", "scoped"],
  rationale: "A scoped SQL delete is destructive but bounded by a WHERE clause.",
  commands: sequence(100, (n) => `DELETE FROM benchmark_table_${n} WHERE id = ${n}`),
});
addGroup({
  category: "warn.privilege-escalation",
  expectedDecision: "warn",
  riskClass: "review-required",
  tags: ["system", "privilege"],
  rationale: "Privilege escalation requires explicit review.",
  commands: sequence(100, (n) => `sudo echo benchmark-elevated-${n}`),
});
addGroup({
  category: "warn.git-destructive-history",
  expectedDecision: "warn",
  riskClass: "review-required",
  tags: ["git", "history", "destructive"],
  rationale: "A hard reset can discard local history and requires review.",
  commands: sequence(100, (n) => `git reset --hard HEAD~${n}`),
});

addGroup({
  category: "block.secret-access",
  expectedDecision: "block",
  riskClass: "dangerous",
  tags: ["secret", "filesystem", "read"],
  rationale: "Reading environment secret files is blocked by built-in policy.",
  commands: sequence(100, (n) => `cat .env.benchmark-${n}`),
});
addGroup({
  category: "block.protected-force-push",
  expectedDecision: "block",
  riskClass: "dangerous",
  tags: ["git", "force-push", "protected-branch"],
  rationale: "Force pushing a protected branch can rewrite shared history.",
  commands: sequence(100, (n) => `git push --force benchmark-remote-${n} main`),
});
addGroup({
  category: "block.sql-drop",
  expectedDecision: "block",
  riskClass: "dangerous",
  tags: ["sql", "destructive", "drop"],
  rationale: "Dropping a table is destructive and blocked.",
  commands: sequence(100, (n) => `DROP TABLE benchmark_table_${n}`),
});
addGroup({
  category: "block.filesystem-wildcard",
  expectedDecision: "block",
  riskClass: "dangerous",
  tags: ["filesystem", "delete", "wildcard"],
  rationale: "Forced recursive wildcard deletion has broad destructive impact.",
  commands: sequence(100, (n) => `rm -rf benchmark-dir-${n}/*`),
});

const counts = cases.reduce((result, entry) => {
  result[entry.expectedDecision] = (result[entry.expectedDecision] ?? 0) + 1;
  return result;
}, {});
const uniqueIds = new Set(cases.map((entry) => entry.id));
const uniqueCommands = new Set(cases.map((entry) => entry.command));
if (cases.length !== 1200 || counts.allow !== 400 || counts.warn !== 400 || counts.block !== 400) {
  throw new Error(`Expected 1200 balanced cases, got ${JSON.stringify(counts)}`);
}
if (uniqueIds.size !== cases.length || uniqueCommands.size !== cases.length) {
  throw new Error("Governance benchmark ids and commands must be unique.");
}

const fixture = {
  version: 2,
  suite: "governance",
  generatedBy: "scripts/generate-governance-benchmarks.mjs",
  cases,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`Wrote ${cases.length} governance benchmark cases to ${outPath}`);
