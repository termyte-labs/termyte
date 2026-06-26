/**
 * Shared types for the installer layer. Mirrors the relevant parts of
 * claude-mem's `src/services/integrations/types.ts`.
 */

export interface CursorMcpConfig {
  mcpServers: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

export type CursorInstallTarget = "project" | "user" | "enterprise";

/** Host OS family used to pick absolute paths. */
export type Platform = "windows" | "unix";

export interface CursorHooksJson {
  version: number;
  hooks: {
    beforeSubmitPrompt?: Array<{ command: string }>;
    afterMCPExecution?: Array<{ command: string }>;
    afterShellExecution?: Array<{ command: string }>;
    afterFileEdit?: Array<{ command: string }>;
    stop?: Array<{ command: string }>;
  };
}

export interface McpJsonConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  servers?: Record<string, { command: string; args?: string[] }>;
}

export interface McpInstallerConfig {
  ideId: string;
  ideLabel: string;
  configPath: string;
  configKey: "servers" | "mcpServers";
  contextFile?: { path: string; isWorkspaceRelative: boolean };
}
