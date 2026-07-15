import { describe, expect, it } from "vitest";
import { MVP_COMMAND_ALIASES, resolveMvpCommand, renderMvpCommandGuide } from "../src/cli/mvp-aliases.js";

describe("MVP command aliases", () => {
  it("maps the public product names onto the existing runtime commands", () => {
    expect(MVP_COMMAND_ALIASES).toEqual({
      capture: "start",
      remember: "context",
      inspect: "viewer",
      evaluate: "eval",
    });
    expect(resolveMvpCommand("capture")).toBe("start");
    expect(resolveMvpCommand("learn")).toBeNull();
    expect(resolveMvpCommand("remember")).toBe("context");
    expect(resolveMvpCommand("inspect")).toBe("viewer");
    expect(resolveMvpCommand("evaluate")).toBe("eval");
    expect(resolveMvpCommand("missing")).toBeNull();
  });

  it("renders a concise guide for the CLI help output", () => {
    expect(renderMvpCommandGuide()).toContain("capture   -> start");
    expect(renderMvpCommandGuide()).not.toContain("learn");
  });
});
