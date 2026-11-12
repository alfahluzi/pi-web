export interface ToolTiming {
  /** Tool args `timeout` (seconds). */
  timeoutSec?: number;
  /** Sum of every literal `sleep N[smhd]` in a bash command (seconds). */
  sleepSec?: number;
}

const SLEEP_PATTERN = /\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
const UNIT_SEC: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total seconds of all `sleep` calls in a shell command. Assumes they run sequentially. */
export function parseSleepTotalSec(command: string): number {
  let total = 0;
  for (const [, num, unit] of command.matchAll(SLEEP_PATTERN)) {
    total += parseFloat(num) * UNIT_SEC[unit];
  }
  return total;
}

/** Timing hints for a running tool call; null when there is nothing to count. */
export function getToolTiming(toolName: string, args: unknown): ToolTiming | null {
  if (!isObject(args)) return null;
  const timing: ToolTiming = {};
  if (typeof args.timeout === "number" && args.timeout > 0) timing.timeoutSec = args.timeout;
  if (toolName === "bash" && typeof args.command === "string") {
    const sleepSec = parseSleepTotalSec(args.command);
    if (sleepSec > 0) timing.sleepSec = sleepSec;
  }
  return timing.timeoutSec !== undefined || timing.sleepSec !== undefined ? timing : null;
}
