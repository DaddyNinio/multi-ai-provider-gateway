/**
 * Interactive model picker for the gateway's own CLI.
 *
 * Claude Code's built-in `/model` picker only lists gateway models whose id
 * begins with "claude-", which hides non-Anthropic models (GLM, GPT, Grok, …).
 * This picker has no such restriction: it lists the FULL merged catalog from
 * both providers and writes the chosen id to Claude Code's `"model"` setting in
 * ~/.claude/settings.json, which Claude Code honors directly — so you can pin
 * any model, Anthropic or not, without fighting the built-in picker.
 *
 * The interactive UI is a keyboard-driven selector — arrow keys (or j/k) to
 * move, Enter to choose, Esc/q to cancel — so you never type a number. Typing
 * letters filters the list. No external dependencies: it uses raw-mode stdin
 * and ANSI redraw.
 *
 * Usage (wired in main.ts):
 *   multi-ai-provider-gateway --model            # interactive picker
 *   multi-ai-provider-gateway --model kiro/glm-5 # set directly, non-interactive
 */
import type { Config } from "./config.js";
import { getMergedModels, type ModelEntry } from "./upstreams.js";
import { setClaudeModel, describeSetModel } from "./claude-setup.js";
import { box, c } from "./ui.js";

/** A selectable entry plus its provider label. */
interface Item {
  id: string;
  provider: string;
}

/** Short, human label for a provider owner string. */
function providerLabel(ownedBy: unknown): string {
  if (ownedBy === "kiro-gateway") return "kiro";
  if (ownedBy === "copilot-api") return "copilot";
  return String(ownedBy ?? "other");
}

/** Flatten the catalog into provider-grouped selectable items (stable order). */
function toItems(models: ModelEntry[]): Item[] {
  const byProvider = new Map<string, Item[]>();
  for (const m of models) {
    const provider = providerLabel(m.owned_by);
    const list = byProvider.get(provider) ?? [];
    list.push({ id: m.id, provider });
    byProvider.set(provider, list);
  }
  const items: Item[] = [];
  for (const list of byProvider.values()) items.push(...list);
  return items;
}

/** Apply a selected model id and print the result; sets process exit code. */
function applyAndReport(model: string): void {
  try {
    const result = setClaudeModel(model);
    console.log(
      "\n" +
        box(describeSetModel(result).split("\n"), {
          title: "model set",
          borderColor: c.green,
        }) +
        "\n",
    );
  } catch (err) {
    console.error(
      "\n" +
        box([`${c.red("✗")} ${String((err as Error).message)}`], {
          title: "could not set model",
          borderColor: c.red,
        }) +
        "\n",
    );
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------------------- //
// Arrow-key selector
// --------------------------------------------------------------------------- //

/** Keys we recognize, decoded from raw stdin byte sequences. */
type Key =
  | { type: "up" }
  | { type: "down" }
  | { type: "enter" }
  | { type: "cancel" }
  | { type: "backspace" }
  | { type: "char"; value: string };

/** Decode a raw input chunk into a single logical key. */
function decodeKey(buf: Buffer): Key | null {
  const s = buf.toString("utf8");
  // Control sequences
  if (s === "\u0003" || s === "\u001b" || s === "q") return { type: "cancel" }; // Ctrl-C, Esc, q
  if (s === "\r" || s === "\n") return { type: "enter" };
  if (s === "\u007f" || s === "\b") return { type: "backspace" };
  if (s === "\u001b[A" || s === "k") return { type: "up" };
  if (s === "\u001b[B" || s === "j") return { type: "down" };
  if (s === "\u001b[D" || s === "\u001b[C") return null; // ignore left/right
  // Printable single char (for type-to-filter)
  if (s.length === 1 && s >= " " && s <= "~") return { type: "char", value: s };
  return null;
}

/**
 * Run a fullscreen-ish, in-place arrow-key picker over `items`.
 * Returns the chosen id, or null if cancelled.
 */
function selectInteractively(items: Item[]): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    let filter = "";
    let cursor = 0; // index into the *filtered* list
    let lastLineCount = 0;

    const filtered = (): Item[] => {
      if (!filter) return items;
      const f = filter.toLowerCase();
      return items.filter((it) => it.id.toLowerCase().includes(f));
    };

    const maxRows = Math.max(5, (stdout.rows ?? 24) - 8);

    const render = (): void => {
      const list = filtered();
      if (cursor >= list.length) cursor = Math.max(0, list.length - 1);

      // Window the list around the cursor so long catalogs scroll.
      let start = 0;
      if (list.length > maxRows) {
        start = Math.min(
          Math.max(0, cursor - Math.floor(maxRows / 2)),
          list.length - maxRows,
        );
      }
      const windowed = list.slice(start, start + maxRows);

      const lines: string[] = [];
      lines.push(
        `${c.bold("Pick a model for Claude Code")}  ${c.gray("↑/↓ move · Enter select · Esc cancel")}`,
      );
      lines.push(
        c.gray(
          filter
            ? `filter: ${c.reset(c.bold(filter))}${c.gray("  (type to filter, Backspace to clear)")}`
            : "type to filter · the full catalog, including non-Anthropic models",
        ),
      );
      lines.push("");

      if (list.length === 0) {
        lines.push(c.yellow("  no models match that filter"));
      } else {
        let prevProvider = "";
        for (let i = 0; i < windowed.length; i++) {
          const it = windowed[i];
          const absolute = start + i;
          if (it.provider !== prevProvider) {
            prevProvider = it.provider;
            lines.push(c.bold(c.cyan(it.provider)));
          }
          const selected = absolute === cursor;
          const pointer = selected ? c.brightCyan("❯ ") : "  ";
          const label = selected ? c.brightGreen(it.id) : it.id;
          lines.push(`${pointer}${label}`);
        }
        if (list.length > maxRows) {
          lines.push(
            c.gray(`  … ${cursor + 1}/${list.length}`),
          );
        }
      }

      const rendered =
        "\n" + box(lines, { title: "model picker", borderColor: c.cyan }) + "\n";

      // Erase the previous frame, then draw the new one.
      if (lastLineCount > 0) {
        stdout.write(`\u001b[${lastLineCount}A`); // cursor up N lines
        stdout.write("\u001b[0J"); // clear from cursor to end of screen
      }
      stdout.write(rendered);
      lastLineCount = rendered.split("\n").length - 1;
    };

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    const finish = (value: string | null): void => {
      cleanup();
      resolve(value);
    };

    const onData = (buf: Buffer): void => {
      const key = decodeKey(buf);
      if (!key) return;
      const list = filtered();
      switch (key.type) {
        case "cancel":
          finish(null);
          return;
        case "up":
          if (list.length) cursor = (cursor - 1 + list.length) % list.length;
          render();
          return;
        case "down":
          if (list.length) cursor = (cursor + 1) % list.length;
          render();
          return;
        case "enter":
          if (list.length) finish(list[cursor].id);
          else finish(null);
          return;
        case "backspace":
          filter = filter.slice(0, -1);
          cursor = 0;
          render();
          return;
        case "char":
          filter += key.value;
          cursor = 0;
          render();
          return;
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}

/**
 * Run the model selector.
 *
 * @param cfg     loaded gateway config (for prefixes/catalog)
 * @param preset  optional model id to set directly without prompting
 * @returns true on success (model written), false otherwise
 */
export async function pickModel(cfg: Config, preset?: string): Promise<boolean> {
  // Non-interactive: a model id was supplied on the command line.
  if (preset && preset.trim()) {
    applyAndReport(preset.trim());
    return process.exitCode !== 1;
  }

  // Fetch the merged catalog (Copilot part is best-effort; kiro is static).
  let models: ModelEntry[] = [];
  try {
    models = await getMergedModels(cfg);
  } catch {
    models = [];
  }
  if (models.length === 0) {
    console.error(
      "\n" +
        box(
          [
            `${c.red("✗")} No models available.`,
            c.gray("Sign in to a provider first: --login"),
          ],
          { title: "model picker", borderColor: c.red },
        ) +
        "\n",
    );
    process.exitCode = 1;
    return false;
  }

  const items = toItems(models);

  // Without a TTY we can't run the interactive selector; guide the user to the
  // direct form instead of failing silently.
  if (!process.stdin.isTTY) {
    const lines = [
      `${c.bold("Pick a model for Claude Code")}`,
      c.gray("no interactive terminal — pass an id directly:"),
      "",
      c.gray("  multi-ai-provider-gateway --model <id>"),
      "",
      ...items.map((it) => `  ${it.id}`),
    ];
    console.log("\n" + box(lines, { title: "model picker", borderColor: c.cyan }) + "\n");
    return false;
  }

  const chosen = await selectInteractively(items);
  if (!chosen) {
    console.log(c.gray("  Cancelled — model unchanged.\n"));
    return false;
  }
  applyAndReport(chosen);
  return process.exitCode !== 1;
}
