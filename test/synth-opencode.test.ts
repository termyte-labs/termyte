import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInvocationError } from "../src/synth/types.js";

let fakeOpenCodePath: string;
let originalOpenCodePath: string | undefined;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "termyte-opencode-"));
  const event = JSON.stringify({
    type: "text",
    part: { type: "text", text: "<skip_summary />", time: { start: 1, end: 2 } },
  });
  fakeOpenCodePath = join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") {
    writeFileSync(fakeOpenCodePath, `@echo off\r\nif not "%TERMYTE_INTERNAL_SYNTHESIS%"=="1" exit /b 9\r\nif not "%1"=="run" exit /b 8\r\nif not "%2"=="--format" exit /b 7\r\nif not "%3"=="json" exit /b 6\r\necho ${event}\r\n`, "utf-8");
  } else {
    writeFileSync(fakeOpenCodePath, `#!/bin/sh\n[ "$TERMYTE_INTERNAL_SYNTHESIS" = "1" ] || exit 9\n[ "$1" = "run" ] || exit 8\n[ "$2" = "--format" ] || exit 7\n[ "$3" = "json" ] || exit 6\nprintf '%s\\n' '${event}'\n`, "utf-8");
    chmodSync(fakeOpenCodePath, 0o755);
  }
  originalOpenCodePath = process.env.OPENCODE_PATH;
  process.env.OPENCODE_PATH = fakeOpenCodePath;
});

afterEach(() => {
  if (originalOpenCodePath === undefined) delete process.env.OPENCODE_PATH;
  else process.env.OPENCODE_PATH = originalOpenCodePath;
  rmSync(join(fakeOpenCodePath, ".."), { recursive: true, force: true });
});

describe("OpenCodeAdapter", () => {
  it("runs OpenCode non-interactively and parses text events", async () => {
    const { OpenCodeAdapter } = await import("../src/synth/opencode.js");
    const adapter = new OpenCodeAdapter();
    expect(await adapter.isAvailable()).toBe(true);
    await expect(adapter.invoke("synthesize", { timeoutMs: 10_000 })).resolves.toMatchObject({ text: "<skip_summary />" });
  });

  it("rejects output without a text event", async () => {
    const event = JSON.stringify({ type: "step_finish", part: { type: "step-finish" } });
    if (process.platform === "win32") writeFileSync(fakeOpenCodePath, `@echo off\r\necho ${event}\r\n`, "utf-8");
    else {
      writeFileSync(fakeOpenCodePath, `#!/bin/sh\nprintf '%s\\n' '${event}'\n`, "utf-8");
      chmodSync(fakeOpenCodePath, 0o755);
    }
    const { OpenCodeAdapter } = await import("../src/synth/opencode.js");
    await expect(new OpenCodeAdapter().invoke("x", { timeoutMs: 10_000 })).rejects.toBeInstanceOf(AgentInvocationError);
  });
});
