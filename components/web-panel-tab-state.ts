/**
 * Tab identity for package-provided right panels. One tab per panel id, so
 * reopening the same plugin button focuses the existing panel instead of
 * stacking duplicates.
 */
import type { WebPanelInfo } from "@/lib/api-types";

export interface WebPanelTab {
  id: string;
  panelId: string;
  url: string;
  title: string;
  /** Set by the plugin through the bridge so a dynamic title wins over the manifest. */
  titleOverride?: string;
  icon?: string;
  iconSvgPath?: string;
  order: number;
}

export function webPanelTabId(panelId: string): string {
  return `web-panel:${panelId}`;
}

export function newWebPanelTab(panel: WebPanelInfo): WebPanelTab {
  return {
    id: webPanelTabId(panel.id),
    panelId: panel.id,
    url: panel.url,
    title: panel.title,
    icon: panel.icon,
    iconSvgPath: panel.iconSvgPath,
    order: panel.order,
  };
}

/** Apply a newer panel listing to an open tab without discarding bridge state. */
export function reconcileWebPanelTab(tab: WebPanelTab, panel: WebPanelInfo): WebPanelTab {
  return {
    ...tab,
    url: panel.url,
    title: tab.titleOverride ?? panel.title,
    icon: panel.icon,
    iconSvgPath: panel.iconSvgPath,
    order: panel.order,
  };
}
