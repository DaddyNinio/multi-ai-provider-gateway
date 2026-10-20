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
 * Usage (wired in main.ts):
 *   multi-ai-provider-gateway --model            # interactive picker
 *   multi-ai-provider-gateway --model kiro/glm-5 # set directly, non-interactive
 */
import { createInterface } from "node:readline/promises";
import type { Config } from "./config.js";
import { getMergedModels, type ModelEntry } from "./upstreams.js";
import { setClaudeModel, describeSetModel } from "./claude-setup.js";
import { box, c } from "./ui.js";

/** Short, human label for a provider owner string. */
function providerLabel(ownedBy: unknown): string {
  if (ownedBy === "kiro-gateway") return "kiro";
  if (ownedBy === "copilot-api") return "copilot";
  return String(ownedBy ?? "other");
}

/** Group models by provider, preserving catalog order within each group. */
function groupByProvider(models: ModelEntry[]): Map<string, ModelEntry[]> {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const key = providerLabel(m.owned_by);
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  return groups;
}

/**
 * Print the numbered catalog and return a flat, index-aligned list of ids so a
 * numeric choice maps back to a model id.
 */
function renderCatalog(groups: Map<string, ModelEntry[]>): string[] {
  const order: string[] = [];
  const lines: string[] = [];
  let n = 0;
  for (const [provider, list] of groups) {
    lines.push("");
    lines.push(c.bold(c.cyan(provider)));
    for (const m of list) {
      n += 1;
      order.push(m.id);
      lines.push(`  ${c.gray(String(n).padStart(3))}  ${m.id}`);
    }
  }
  console.log(
    "\n" +
      box(
        [
          `${c.bold("Pick a model for Claude Code")}`,
          c.gray("the full catalog — including non-Anthropic models"),
          ...lines,
        ],
        { title: "model picker", borderColor: c.cyan },
      ) +
      "\n",
  );
  return order;
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

/**
 * Resolve a user-typed selection (a 1-based index or a model id) against the
 * ordered id list. Returns the model id, or null if the input is invalid.
 */
function resolveSelection(input: string, order: string[]): string | null {
  const s = input.trim();
  if (!s) return null;
  // Numeric index?
  if (/^\d+$/.test(s)) {
    const idx = Number(s);
    if (idx >= 1 && idx <= order.length) return order[idx - 1];
    return null;
  }
  // Exact id match.
  if (order.includes(s)) return s;
  // Case-insensitive / suffix convenience (e.g. "glm-5" -> "kiro/glm-5").
  const lower = s.toLowerCase();
  const exactCI = order.find((id) => id.toLowerCase() === lower);
  if (exactCI) return exactCI;
  const suffix = order.filter((id) => id.toLowerCase().endsWith("/" + lower));
  if (suffix.length === 1) return suffix[0];
  return null;
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

  const groups = groupByProvider(models);
  const order = renderCatalog(groups);

  if (!process.stdin.isTTY) {
    console.log(
      c.gray(
        "  Not a TTY — pass a model id directly, e.g. --model kiro/glm-5\n",
      ),
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ans = await rl.question(
        `${c.bold("Enter a number or model id")} ${c.gray("(blank to cancel)")}: `,
      );
      if (!ans.trim()) {
        console.log(c.gray("  Cancelled — model unchanged.\n"));
        return false;
      }
      const chosen = resolveSelection(ans, order);
      if (chosen) {
        rl.close();
        applyAndReport(chosen);
        return process.exitCode !== 1;
      }
      console.log(c.yellow("  Not a valid choice — try again."));
    }
    console.log(c.gray("  No valid selection — model unchanged.\n"));
    return false;
  } finally {
    rl.close();
  }
}
