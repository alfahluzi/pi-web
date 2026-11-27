import { useSyncExternalStore } from "react";

/**
 * How the sidebar lays its projects out: one flat list of groups (the way it
 * has always been), or nested by the projects' paths, where a folder above
 * two projects is a row of its own.
 */
export type SidebarLayoutMode = "flat" | "tree";

export const SIDEBAR_LAYOUT_STORAGE_KEY = "pi-web:sidebar-layout";
export const SIDEBAR_LAYOUT_DEFAULT: SidebarLayoutMode = "tree";

export function parseSidebarLayout(raw: string | null): SidebarLayoutMode {
  return raw === "flat" ? "flat" : SIDEBAR_LAYOUT_DEFAULT;
}

function readStoredLayout(): SidebarLayoutMode {
  try {
    return parseSidebarLayout(window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY));
  } catch {
    return SIDEBAR_LAYOUT_DEFAULT;
  }
}

let layout: SidebarLayoutMode | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): SidebarLayoutMode {
  if (layout === null) layout = readStoredLayout();
  return layout;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== SIDEBAR_LAYOUT_STORAGE_KEY) return;
  const next = readStoredLayout();
  if (next === layout) return;
  layout = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    layout = readStoredLayout();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setSidebarLayout(next: SidebarLayoutMode): void {
  if (next === getSnapshot()) return;
  layout = next;
  try {
    window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, next);
  } catch {
    // Persistence is best-effort: the choice still holds for this page.
  }
  notify();
}

export function useSidebarLayout(): SidebarLayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => SIDEBAR_LAYOUT_DEFAULT);
}
