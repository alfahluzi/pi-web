"use client";

import { createElement, type CSSProperties, type SVGProps } from "react";
import { WEB_PANEL_ICON_NAMES } from "@/lib/web-panel-manifest";

/**
 * Icons a plugin can pick by name in its manifest (`piWeb.panels[].icon`).
 * A plugin that wants its own artwork passes `iconSvgPath`, a single 24×24
 * path `d` string, which is validated server-side before it reaches this
 * component.
 */

type IconTag = "path" | "circle" | "line" | "rect" | "polyline" | "ellipse";

interface IconNode {
  tag: IconTag;
  attrs: Record<string, string | number>;
}

const ICONS: Record<string, IconNode[]> = {
  plugin: [
    {
      tag: "path",
      attrs: {
        d: "M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.94.94.94 2.46 0 3.4l-1.61 1.62a.98.98 0 0 1-.84.27c-.47-.07-.8-.48-.97-.92a2.5 2.5 0 1 0-3.21 3.21c.44.17.85.5.92.97a.98.98 0 0 1-.27.84l-1.61 1.61a2.4 2.4 0 0 1-3.41 0l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.08-.84.51-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.89-.53.97-1.02a1.03 1.03 0 0 0-.29-.88L2.7 13.71a2.4 2.4 0 0 1 0-3.41L4.23 8.77c.24-.24.58-.35.92-.3.51.08.87.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07a1.03 1.03 0 0 1 .3-.92l1.53-1.53a2.4 2.4 0 0 1 3.7.4l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.89.53-.97 1.02Z",
      },
    },
  ],
  clipboard: [
    { tag: "path", attrs: { d: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" } },
    { tag: "rect", attrs: { x: 9, y: 3, width: 6, height: 4, rx: 1 } },
    { tag: "path", attrs: { d: "M9 12h6M9 16h4" } },
  ],
  list: [
    { tag: "path", attrs: { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" } },
  ],
  folder: [
    { tag: "path", attrs: { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" } },
  ],
  file: [
    { tag: "path", attrs: { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" } },
    { tag: "path", attrs: { d: "M14 2v5h6" } },
  ],
  globe: [
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 10 } },
    { tag: "path", attrs: { d: "M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" } },
  ],
  terminal: [
    { tag: "polyline", attrs: { points: "4 17 10 11 4 5" } },
    { tag: "line", attrs: { x1: 12, y1: 19, x2: 20, y2: 19 } },
  ],
  settings: [
    {
      tag: "path",
      attrs: {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
      },
    },
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 3 } },
  ],
  table: [
    { tag: "rect", attrs: { x: 3, y: 3, width: 18, height: 18, rx: 2 } },
    { tag: "path", attrs: { d: "M12 3v18M3 9h18M3 15h18" } },
  ],
  calendar: [
    { tag: "rect", attrs: { x: 3, y: 4, width: 18, height: 18, rx: 2 } },
    { tag: "path", attrs: { d: "M16 2v4M8 2v4M3 10h18" } },
  ],
  chart: [
    { tag: "path", attrs: { d: "M3 3v18h18" } },
    { tag: "path", attrs: { d: "M18 17V9M13 17V5M8 17v-3" } },
  ],
  code: [
    { tag: "polyline", attrs: { points: "16 18 22 12 16 6" } },
    { tag: "polyline", attrs: { points: "8 6 2 12 8 18" } },
  ],
  book: [
    { tag: "path", attrs: { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" } },
    { tag: "path", attrs: { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" } },
  ],
  sparkles: [
    { tag: "path", attrs: { d: "m12 3-1.9 5.8a2 2 0 0 1-1.29 1.29L3 12l5.8 1.9a2 2 0 0 1 1.29 1.29L12 21l1.9-5.8a2 2 0 0 1 1.29-1.29L21 12l-5.8-1.9a2 2 0 0 1-1.29-1.29Z" } },
  ],
  layers: [
    { tag: "path", attrs: { d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" } },
    { tag: "path", attrs: { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" } },
    { tag: "path", attrs: { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" } },
  ],
  "git-branch": [
    { tag: "line", attrs: { x1: 6, y1: 3, x2: 6, y2: 15 } },
    { tag: "circle", attrs: { cx: 18, cy: 6, r: 3 } },
    { tag: "circle", attrs: { cx: 6, cy: 18, r: 3 } },
    { tag: "path", attrs: { d: "M18 9a9 9 0 0 1-9 9" } },
  ],
  database: [
    { tag: "ellipse", attrs: { cx: 12, cy: 5, rx: 9, ry: 3 } },
    { tag: "path", attrs: { d: "M3 5v14a9 3 0 0 0 18 0V5" } },
    { tag: "path", attrs: { d: "M3 12a9 3 0 0 0 18 0" } },
  ],
  "external-link": [
    { tag: "path", attrs: { d: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" } },
  ],
  message: [
    { tag: "path", attrs: { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" } },
  ],
  lightbulb: [
    { tag: "path", attrs: { d: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.8.8 1.3 1.5 1.5 2.5" } },
    { tag: "path", attrs: { d: "M9 18h6M10 22h4" } },
  ],
  rocket: [
    { tag: "path", attrs: { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z" } },
    { tag: "path", attrs: { d: "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" } },
    { tag: "path", attrs: { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" } },
    { tag: "path", attrs: { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" } },
  ],
  search: [
    { tag: "circle", attrs: { cx: 11, cy: 11, r: 8 } },
    { tag: "path", attrs: { d: "m21 21-4.3-4.3" } },
  ],
  box: [
    { tag: "path", attrs: { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" } },
    { tag: "path", attrs: { d: "m3.3 7 8.7 5 8.7-5M12 22V12" } },
  ],
};

const FALLBACK = ICONS.plugin;

const KNOWN_ICONS = new Set<string>(WEB_PANEL_ICON_NAMES);

export interface WebPanelIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  /** Named icon from the manifest. Unknown names fall back to the puzzle icon. */
  name?: string;
  /** Raw 24×24 path `d`; validated server-side, wins over `name`. */
  svgPath?: string;
  /** Rendered size in pixels. */
  size?: number;
  /** Applied to the `<svg>` element. */
  style?: CSSProperties;
}

export function WebPanelIcon({ name, svgPath, size = 16, style, ...rest }: WebPanelIconProps) {
  const nodes: IconNode[] = svgPath
    ? [{ tag: "path", attrs: { d: svgPath } }]
    : ICONS[name && KNOWN_ICONS.has(name) ? name : "plugin"] ?? FALLBACK;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
      {...rest}
    >
      {nodes.map((node, index) => createElement(node.tag, { key: index, ...node.attrs }))}
    </svg>
  );
}
