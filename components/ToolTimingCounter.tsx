"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ToolTiming } from "@/lib/tool-timing";

/** Live elapsed/remaining counter for a running tool. Ticks locally so the chat does not re-render each second. */
export function ToolTimingCounter({ startedAt, timing }: { startedAt: number; timing: ToolTiming }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsedSec = Math.floor((now - startedAt) / 1000);
  const parts: string[] = [];
  if (timing.timeoutSec !== undefined) {
    parts.push(t("chat.toolTimeoutCounter", { elapsed: elapsedSec, timeout: Math.ceil(timing.timeoutSec) }));
  }
  if (timing.sleepSec !== undefined) {
    const remaining = Math.max(0, Math.ceil(timing.sleepSec - (now - startedAt) / 1000));
    parts.push(t("chat.toolSleepEstimate", { remaining }));
  }

  return <span className="tabular-nums">{parts.join(" · ")}</span>;
}
