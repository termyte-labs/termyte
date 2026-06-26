/**
 * `observation` handler — PostToolUse / AfterTool / post_*_code /
 * post_run_command. The trace is already written by the runner; this
 * handler just confirms and stays out of the way.
 */
import type { EventHandler } from "../handler-types.js";

export const observationHandler: EventHandler = async () => {
  return { handled: true, result: { continue: true, suppressOutput: true } };
};
