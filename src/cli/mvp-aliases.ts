export const MVP_COMMAND_ALIASES = {
  capture: "start",
  learn: "synth",
  remember: "context",
  inspect: "viewer",
  evaluate: "eval",
} as const;

export type MvpCommandAlias = keyof typeof MVP_COMMAND_ALIASES;
export type MvpCommandTarget = typeof MVP_COMMAND_ALIASES[MvpCommandAlias];

export function resolveMvpCommand(command: string): MvpCommandTarget | null {
  if (Object.prototype.hasOwnProperty.call(MVP_COMMAND_ALIASES, command)) {
    return MVP_COMMAND_ALIASES[command as MvpCommandAlias];
  }
  return null;
}

export function renderMvpCommandGuide(): string {
  return [
    "MVP aliases:",
    "  capture   -> start",
    "  learn     -> synth",
    "  remember  -> context",
    "  inspect   -> viewer",
    "  evaluate  -> eval",
  ].join("\n");
}
