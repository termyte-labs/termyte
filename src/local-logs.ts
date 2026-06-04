import { appendJsonlRow, ensureLocalStateDir, getLocalStatePaths, readJsonlFile } from "./local-state.js";
import type { LocalLogEvent } from "./types.js";

let eventCounter = 0;

export interface LocalLogFilters {
  blocked?: boolean;
  warned?: boolean;
  agent?: string;
  today?: boolean;
}

export function listLocalLogs(cwd = process.cwd(), filters: LocalLogFilters = {}): LocalLogEvent[] {
  let events = readJsonlFile<LocalLogEvent>(getLocalStatePaths(cwd).logsPath);
  events = events.sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  if (filters.blocked) {
    events = events.filter((event) => event.decision === "block");
  }
  if (filters.warned) {
    events = events.filter((event) => event.decision === "warn");
  }
  if (filters.agent) {
    events = events.filter((event) => event.agent === filters.agent);
  }
  if (filters.today) {
    const today = localDateKey(new Date().toISOString());
    events = events.filter((event) => localDateKey(event.timestamp) === today);
  }

  return events;
}

export function writeLocalLog(event: Omit<LocalLogEvent, "event_id" | "timestamp">, cwd = process.cwd()): LocalLogEvent {
  const paths = ensureLocalStateDir(cwd);
  const stored: LocalLogEvent = {
    event_id: createEventId(),
    timestamp: new Date().toISOString(),
    ...event,
  };
  appendJsonlRow(paths.logsPath, stored);
  return stored;
}

export function formatLocalLogsHuman(events: LocalLogEvent[]): string {
  if (events.length === 0) {
    return "Recent Termyte events\n\nNo events yet.";
  }

  return [
    "Recent Termyte events",
    "",
    ...events.flatMap((event, index) => {
      const lines = [
        `[${event.decision.toUpperCase()}] ${event.command}`,
        `Reason: ${event.reason}`,
        ...(event.agent ? [`Agent: ${event.agent}`] : []),
        `Time: ${formatLocalTime(event.timestamp)}`,
      ];
      if (index < events.length - 1) {
        lines.push("");
      }
      return lines;
    }),
  ].join("\n");
}

function createEventId(): string {
  eventCounter += 1;
  return `evt_${Date.now()}_${eventCounter}`;
}

function localDateKey(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatLocalTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
