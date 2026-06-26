/**
 * `file-edit` handler — PostToolUse on Edit/Write. Currently a no-op
 * stub; future versions can record a richer "what changed" observation.
 */
import type { EventHandler } from "../handler-types.js";

export const fileEditHandler: EventHandler = async () => {
  return { handled: true, result: { continue: true, suppressOutput: true } };
};
