/**
 * Tiny, dependency-free terminal UI helpers: ANSI colors and box drawing.
 *
 * Colors auto-disable when stdout is not a TTY, when NO_COLOR is set, or when
 * TERM=dumb, so piped/CI output stays clean.
 */

const colorEnabled =
  process.stdout.isTTY === true &&
  !("NO_COLOR" in process.env) &&
  process.env.TERM !== "dumb";

type Style = (s: string) => string;

function wrap(open: number, close: number): Style {
  if (!colorEnabled) return (s) => s;
  return (s) => `\u001b[${open}m${s}\u001b[${close}m`;
}

export const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),

  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),

  // bright
  brightGreen: wrap(92, 39),
  brightCyan: wrap(96, 39),
};

/** Visible length of a string, ignoring ANSI escape codes. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Pad a string to `width` visible columns (left-aligned). */
export function padEndVisible(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

export interface BoxOptions {
  title?: string;
  /** A style applied to the border characters. */
  borderColor?: Style;
  padding?: number;
}

/**
 * Render an array of (already-colored) lines inside a rounded box.
 * Lines may contain ANSI codes; width is computed on visible length.
 */
export function box(lines: string[], opts: BoxOptions = {}): string {
  const pad = opts.padding ?? 1;
  const border = opts.borderColor ?? c.gray;
  const title = opts.title ?? "";

  const contentWidth = Math.max(
    visibleLength(title) + 2,
    ...lines.map((l) => visibleLength(l)),
  );
  const innerWidth = contentWidth + pad * 2;

  const horizontal = "─".repeat(innerWidth);
  const top = title
    ? border("╭─") +
      " " +
      c.bold(title) +
      " " +
      border("─".repeat(Math.max(0, innerWidth - visibleLength(title) - 3)) + "╮")
    : border("╭" + horizontal + "╮");
  const bottom = border("╰" + horizontal + "╯");

  const padStr = " ".repeat(pad);
  const body = lines.map(
    (l) => border("│") + padStr + padEndVisible(l, contentWidth) + padStr + border("│"),
  );

  return [top, ...body, bottom].join("\n");
}

/** A green check, red cross, or yellow dot status glyph. */
export function statusGlyph(state: "ok" | "off" | "pending"): string {
  if (state === "ok") return c.brightGreen("●");
  if (state === "pending") return c.yellow("●");
  return c.gray("○");
}
