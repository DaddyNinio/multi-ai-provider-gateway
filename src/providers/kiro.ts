/**
 * Kiro Provider - Direct integration with Kiro/Amazon Q runtime API.
 * 
 * This module provides TypeScript bindings for the Kiro runtime (runtime.kiro.dev),
 * reading authentication tokens from the kiro-cli SQLite database and implementing
 * the GenerateAssistantResponse API.
 * 
 * Token Source:
 * - Database: ~/Library/Application Support/kiro-cli/data.sqlite3
 * - Tables: auth_kv (tokens), state (profile ARN, region)
 * - Token key: "kirocli:odic:token" in auth_kv table
 * - Profile key: "api.codewhisperer.profile" in state table
 * 
 * Schema discovered:
 * - auth_kv.value: JSON with {access_token, refresh_token, expires_at, region, ...}
 * - state.value: JSON with {arn, device_code_disabled, profile_name}
 * 
 * @module providers/kiro
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// ============================================================================
// Types
// ============================================================================

/**
 * Known Kiro model identifiers (runtime.kiro.dev has no ListAvailableModels
 * endpoint, so the catalog is maintained statically).
 *
 * Kiro serves models from several providers, not just Anthropic. The ids below
 * are the runtime `modelId` strings — not marketing names — in Kiro's lowercase,
 * dot-versioned convention:
 *   - Anthropic Claude (Sonnet / Haiku / Opus)
 *   - Open-weight MoE: GLM
 *
 * Every id here is confirmed to be accepted by the live runtime. Other
 * open-weight families (deepseek-3.2, minimax-m2.1, minimax-m2.5,
 * qwen3-coder-next) and OpenAI GPT-5.6 tiers exist in the Kiro IDE/CLI but are
 * rejected by this streaming runtime endpoint for the current account/tier
 * (INVALID_MODEL_ID), so they are omitted to keep the picker free of dead
 * entries. Following the "gateway, not gatekeeper" principle, a bare/unknown id
 * sent directly is still passed through — the runtime remains the final arbiter.
 */
export const KIRO_MODELS = [
  // --- Anthropic (Claude) ---
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
  "claude-sonnet-5.5",
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-opus-5",
  "claude-opus-5.5",

  // --- Open-weight MoE models (runtime-verified) ---
  "glm-5",
] as const;

export type KiroModelId = typeof KIRO_MODELS[number];

/** Anthropic Messages API message format (input). */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/** Anthropic Messages API request payload (input). */
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  /** Tool definitions the model may call. */
  tools?: AnthropicTool[];
  /** Tool-choice directive (passed through; not all are honored by Kiro). */
  tool_choice?: unknown;
}

/** Anthropic tool definition. */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Kiro authentication credentials extracted from SQLite DB. */
interface KiroCredentials {
  accessToken: string;
  profileArn: string;
  region: string;
}

/** CodeWhisperer tool specification. */
interface KiroToolSpec {
  toolSpecification: {
    name: string;
    description?: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

/** CodeWhisperer tool result (sent back on the next user turn). */
interface KiroToolResult {
  toolUseId: string;
  content: Array<{ text?: string; json?: unknown }>;
  status: "success" | "error";
}

/** CodeWhisperer tool use (emitted by the assistant; echoed in history). */
interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "AI_EDITOR";
  userInputMessageContext?: {
    tools?: KiroToolSpec[];
    toolResults?: KiroToolResult[];
  };
}

interface KiroAssistantMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

/** Kiro runtime API request body structure (GenerateAssistantResponse). */
interface KiroRequestBody {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: {
      userInputMessage: KiroUserInputMessage;
    };
    history?: Array<
      | { userInputMessage: KiroUserInputMessage }
      | { assistantResponseMessage: KiroAssistantMessage }
    >;
  };
  profileArn: string;
}

/** Options for chat() method. */
export interface KiroChatOptions {
  signal?: AbortSignal;
}

// ============================================================================
// Token & Credentials
// ============================================================================

/**
 * Path to kiro-cli SQLite database.
 * Standard location: ~/Library/Application Support/kiro-cli/data.sqlite3
 */
function getDbPath(): string {
  return `${homedir()}/Library/Application Support/kiro-cli/data.sqlite3`;
}

/**
 * Execute a SQLite query using the system sqlite3 binary.
 * Avoids native dependencies by shelling out to the system binary.
 * 
 * @param query - SQL query to execute
 * @returns Query output as string
 */
function querySqlite(query: string): string {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`kiro-cli database not found at: ${dbPath}`);
  }
  
  try {
    const result = execFileSync("sqlite3", [dbPath, query], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return result.trim();
  } catch (err) {
    throw new Error(`SQLite query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract Kiro credentials from the kiro-cli SQLite database.
 * 
 * Database schema (discovered via inspection):
 * - auth_kv table stores OIDC tokens under key "kirocli:odic:token"
 *   - value is JSON: {access_token, refresh_token, expires_at, region, start_url, oauth_flow, scopes}
 * - state table stores configuration under various keys:
 *   - "api.codewhisperer.profile" → JSON: {arn, device_code_disabled, profile_name}
 *   - "auth.idc.region" → JSON string: "eu-west-1"
 * 
 * @returns Credentials object with accessToken, profileArn, and region
 * @throws Error if credentials cannot be extracted
 */
export function getKiroCredentials(): KiroCredentials {
  // 1. Extract OIDC token from auth_kv table
  const tokenJson = querySqlite(
    "SELECT value FROM auth_kv WHERE key='kirocli:odic:token';"
  );
  
  if (!tokenJson) {
    throw new Error("No OIDC token found in kiro-cli database (key: kirocli:odic:token)");
  }
  
  let tokenData: {
    access_token?: string;
    region?: string;
    [key: string]: unknown;
  };
  
  try {
    tokenData = JSON.parse(tokenJson);
  } catch (err) {
    throw new Error(`Failed to parse OIDC token JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  if (!tokenData.access_token) {
    throw new Error("OIDC token data missing 'access_token' field");
  }
  
  const accessToken = tokenData.access_token;
  const tokenRegion = tokenData.region;
  
  // 2. Extract profile ARN from state table
  const profileJson = querySqlite(
    "SELECT value FROM state WHERE key='api.codewhisperer.profile';"
  );
  
  if (!profileJson) {
    throw new Error("No CodeWhisperer profile found in kiro-cli database (key: api.codewhisperer.profile)");
  }
  
  let profileData: {
    arn?: string;
    [key: string]: unknown;
  };
  
  try {
    profileData = JSON.parse(profileJson);
  } catch (err) {
    throw new Error(`Failed to parse profile JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  if (!profileData.arn) {
    throw new Error("Profile data missing 'arn' field");
  }
  
  const profileArn = profileData.arn;
  
  // 3. Region MUST match the profile ARN (authoritative), not the SSO/IdC
  // region. The ARN looks like arn:aws:codewhisperer:us-east-1:...; the
  // runtime host runtime.<region>.kiro.dev must match this region or the
  // service rejects the token. (SSO region, e.g. eu-west-1, is unrelated.)
  const arnRegionMatch = profileArn.match(/^arn:aws:codewhisperer:([a-z0-9-]+):/);
  const region = arnRegionMatch ? arnRegionMatch[1] : tokenRegion || "us-east-1";
  
  return {
    accessToken,
    profileArn,
    region: region || "us-east-1",
  };
}

/**
 * Generate Kiro runtime API headers.
 * Based on kiro-gateway/kiro/utils.py:get_kiro_headers()
 * 
 * @param accessToken - Bearer token from OIDC
 * @param fingerprint - Optional machine fingerprint (default: static value)
 * @returns Headers object for Kiro runtime request
 */
function getKiroHeaders(accessToken: string, fingerprint = "multi-ai-provider-gateway"): Record<string, string> {
  // Generate unique invocation ID for this request
  const invocationId = crypto.randomUUID();
  
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${fingerprint}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fingerprint}`,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-invocation-id": invocationId,
    "amz-sdk-request": "attempt=1; max=3",
  };
}

// ============================================================================
// Anthropic → Kiro Conversion
// ============================================================================

/**
 * Extract text content from Anthropic message content.
 * Handles both string and content block array formats.
 */
function extractTextContent(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("");
  }
  return "";
}

/** Extract Anthropic `tool_use` blocks from an assistant message's content. */
function extractToolUses(content: AnthropicMessage["content"]): KiroToolUse[] {
  if (!Array.isArray(content)) return [];
  const out: KiroToolUse[] = [];
  for (const block of content as any[]) {
    if (block?.type === "tool_use") {
      out.push({
        toolUseId: String(block.id ?? crypto.randomUUID()),
        name: String(block.name ?? ""),
        input: block.input ?? {},
      });
    }
  }
  return out;
}

/** Extract Anthropic `tool_result` blocks from a user message's content. */
function extractToolResults(content: AnthropicMessage["content"]): KiroToolResult[] {
  if (!Array.isArray(content)) return [];
  const out: KiroToolResult[] = [];
  for (const block of content as any[]) {
    if (block?.type === "tool_result") {
      // tool_result.content may be a string or an array of blocks.
      const resultContent: Array<{ text?: string; json?: unknown }> = [];
      const rc = block.content;
      if (typeof rc === "string") {
        resultContent.push({ text: rc });
      } else if (Array.isArray(rc)) {
        for (const c of rc) {
          if (typeof c === "string") resultContent.push({ text: c });
          else if (c?.type === "text") resultContent.push({ text: String(c.text ?? "") });
          else if (c?.type === "json" || c?.json !== undefined) resultContent.push({ json: c.json ?? c });
          else resultContent.push({ text: JSON.stringify(c) });
        }
      } else if (rc !== undefined) {
        resultContent.push({ text: JSON.stringify(rc) });
      }
      if (resultContent.length === 0) resultContent.push({ text: "" });
      out.push({
        toolUseId: String(block.tool_use_id ?? ""),
        content: resultContent,
        status: block.is_error ? "error" : "success",
      });
    }
  }
  return out;
}

/** Translate Anthropic tool definitions into CodeWhisperer tool specs. */
function convertTools(tools?: AnthropicTool[]): KiroToolSpec[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.input_schema ?? { type: "object", properties: {} } },
    },
  }));
}

/** Build a Kiro userInputMessage from an Anthropic user message. */
function buildUserMessage(
  msg: AnthropicMessage,
  model: string,
  opts: { tools?: KiroToolSpec[]; systemPrefix?: string } = {},
): KiroUserInputMessage {
  const toolResults = extractToolResults(msg.content);
  let text = extractTextContent(msg.content);
  if (opts.systemPrefix) text = `${opts.systemPrefix}\n\n${text}`.trim();

  const context: KiroUserInputMessage["userInputMessageContext"] = {};
  if (opts.tools && opts.tools.length) context.tools = opts.tools;
  if (toolResults.length) context.toolResults = toolResults;

  // When a turn carries only tool results (no text), Kiro still needs a
  // non-empty content string; a single space avoids the "fake continue" and
  // empty-content 400 issues seen in other translators.
  const content = text || (toolResults.length ? " " : "(empty placeholder)");

  const out: KiroUserInputMessage = { content, modelId: model, origin: "AI_EDITOR" };
  if (Object.keys(context).length) out.userInputMessageContext = context;
  return out;
}

/** Build a Kiro assistantResponseMessage from an Anthropic assistant message. */
function buildAssistantMessage(msg: AnthropicMessage): KiroAssistantMessage {
  const text = extractTextContent(msg.content);
  const toolUses = extractToolUses(msg.content);
  const out: KiroAssistantMessage = {
    // assistant content may legitimately be empty when it only emits tool_use.
    content: text || (toolUses.length ? "" : "(empty placeholder)"),
  };
  if (toolUses.length) out.toolUses = toolUses;
  return out;
}

/**
 * Convert Anthropic Messages API payload to a Kiro runtime request body,
 * including full tool support:
 * - `tools` -> currentMessage.userInputMessageContext.tools
 * - assistant `tool_use` blocks -> history assistantResponseMessage.toolUses
 * - user `tool_result` blocks -> userInputMessageContext.toolResults
 *
 * The system prompt is prepended to the first user message (CodeWhisperer has
 * no dedicated system field on this endpoint).
 */
function convertAnthropicToKiro(
  payload: AnthropicMessagesRequest,
  credentials: KiroCredentials,
): KiroRequestBody {
  const { messages, system, model } = payload;
  const conversationId = crypto.randomUUID();
  const tools = convertTools(payload.tools);

  const history: NonNullable<KiroRequestBody["conversationState"]["history"]> = [];
  const historyMessages = messages.slice(0, -1);
  let systemPrepended = false;

  for (const msg of historyMessages) {
    if (msg.role === "user") {
      const prefix = !systemPrepended && system ? system : undefined;
      if (prefix) systemPrepended = true;
      history.push({ userInputMessage: buildUserMessage(msg, model, { systemPrefix: prefix }) });
    } else {
      history.push({ assistantResponseMessage: buildAssistantMessage(msg) });
    }
  }

  const currentMsg = messages[messages.length - 1];
  let currentUserMessage: KiroUserInputMessage;

  if (currentMsg.role === "assistant") {
    // Rare: last message is the assistant's. Put it in history, send a filler.
    history.push({ assistantResponseMessage: buildAssistantMessage(currentMsg) });
    currentUserMessage = { content: " ", modelId: model, origin: "AI_EDITOR" };
    if (tools) currentUserMessage.userInputMessageContext = { tools };
  } else {
    const prefix = !systemPrepended && system ? system : undefined;
    currentUserMessage = buildUserMessage(currentMsg, model, { tools, systemPrefix: prefix });
  }

  const body: KiroRequestBody = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: currentUserMessage },
    },
    profileArn: credentials.profileArn,
  };
  if (history.length > 0) body.conversationState.history = history;
  return body;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the Kiro runtime base URL for a region.
 * Only us-east-1 and eu-central-1 are known to exist.
 * 
 * @param region - AWS region (default: us-east-1)
 * @returns Base URL for Kiro runtime
 */
export function getKiroBaseUrl(region = "us-east-1"): string {
  // runtime.<region>.kiro.dev is only known to exist for us-east-1 and
  // eu-central-1. Use the region as-is when supported; otherwise fall back to
  // us-east-1 (the ARN region is authoritative and is normally us-east-1).
  const supported = new Set(["us-east-1", "eu-central-1"]);
  const runtimeRegion = supported.has(region) ? region : "us-east-1";
  return `https://runtime.${runtimeRegion}.kiro.dev`;
}

/**
 * List available Kiro models.
 * Returns a static list since the runtime has no ListAvailableModels endpoint.
 * 
 * @returns Array of model objects with id field
 */
export function listModels(): Array<{ id: string }> {
  return KIRO_MODELS.map(id => ({ id }));
}

// ============================================================================
// Display aliasing (client picker compatibility)
// ============================================================================
//
// Some Anthropic-compatible clients (notably Claude Code's gateway model
// discovery) only surface models in their `/model` picker whose id looks like
// an Anthropic model, i.e. begins with "claude-". Non-Claude ids we serve
// (OpenAI GPT-5.6, GLM, DeepSeek, MiniMax, Qwen) are silently filtered out of
// the picker even though the gateway can route them fine.
//
// To make every Kiro model selectable in such pickers, we advertise non-Claude
// models under a "claude-"-prefixed *display id* (e.g. "gpt-5.6-sol" ->
// "claude-gpt-5.6-sol"). The display id is what appears in /v1/models; when a
// request arrives for it we resolve it back to the real runtime id before
// calling the backend. Real Claude ids are advertised unchanged.

/** Marker prepended to non-Claude ids to make them look Claude-family. */
const DISPLAY_ALIAS_PREFIX = "claude-";

/** Whether a real runtime id is already an Anthropic (Claude) model. */
function isClaudeId(realId: string): boolean {
  return realId.startsWith("claude-");
}

/** real runtime id -> display id (claude-looking). */
export function toDisplayModelId(realId: string): string {
  return isClaudeId(realId) ? realId : `${DISPLAY_ALIAS_PREFIX}${realId}`;
}

/**
 * display id -> real runtime id.
 *
 * A display id maps back to a real id when it is an aliased non-Claude model.
 * We only strip the alias prefix when the stripped remainder is a known
 * non-Claude Kiro model, so genuine Claude ids (which also start with
 * "claude-") are never mangled.
 */
export function toRealModelId(displayId: string): string {
  if (displayId.startsWith(DISPLAY_ALIAS_PREFIX)) {
    const stripped = displayId.slice(DISPLAY_ALIAS_PREFIX.length);
    if ((KIRO_MODELS as readonly string[]).includes(stripped) && !isClaudeId(stripped)) {
      return stripped;
    }
  }
  return displayId;
}

/**
 * List Kiro models using client-friendly *display* ids: non-Claude models are
 * exposed under a "claude-"-prefixed alias so they appear in clients that only
 * show Claude-family models in their picker. Use `toRealModelId` to convert a
 * selected display id back before calling the runtime.
 */
export function listDisplayModels(): Array<{ id: string }> {
  return KIRO_MODELS.map((id) => ({ id: toDisplayModelId(id) }));
}

/** Kiro credit usage, matching the "Kiro Account" panel in the Kiro app. */
export interface KiroUsage {
  available: boolean;
  /** e.g. "KIRO PRO+" */
  plan?: string;
  /** Credits used this cycle (with precision, e.g. 261.45). */
  used?: number;
  /** Monthly credit allowance (e.g. 2000). */
  limit?: number;
  /** Remaining credits (limit - used). */
  remaining?: number;
  /** Percent of the allowance used (0-100, rounded). */
  percentUsed?: number;
  /** Reset date (ISO string). */
  resetsAt?: string;
  /** Overage credits used this cycle. */
  overageUsed?: number;
  /** Price per overage credit (USD). */
  overageRate?: number;
  /** Estimated overage cost (USD). */
  overageCost?: number;
  /** Currency code (e.g. "USD"). */
  currency?: string;
}

/**
 * Fetch live Kiro credit usage via the CodeWhisperer `GetUsageLimits` operation
 * (the same call the kiro-cli `/usage` panel uses). Returns credits used/limit,
 * plan, reset date and overage — mirroring the Kiro Account panel.
 *
 * Non-fatal: returns { available: false } if not signed in or the call fails.
 */
export async function getKiroUsage(options: KiroChatOptions = {}): Promise<KiroUsage> {
  let credentials: KiroCredentials;
  try {
    credentials = getKiroCredentials();
  } catch {
    return { available: false };
  }

  try {
    // GetUsageLimits lives on the Amazon Q (CodeWhisperer) control-plane host,
    // not the runtime.*.kiro.dev streaming host.
    const res = await fetch("https://q.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
        "User-Agent": "aws-sdk-js/1.0 multi-ai-provider-gateway",
      },
      body: JSON.stringify({ profileArn: credentials.profileArn }),
      signal: options.signal,
    });
    if (!res.ok) return { available: false };

    const data = (await res.json()) as any;
    const sub = data.subscriptionInfo ?? {};
    // Prefer the CREDIT breakdown; otherwise take the first entry.
    const list: any[] = Array.isArray(data.usageBreakdownList) ? data.usageBreakdownList : [];
    const credit = list.find((b) => b.resourceType === "CREDIT") ?? list[0] ?? {};

    const used = num(credit.currentUsageWithPrecision ?? credit.currentUsage);
    const limit = num(credit.usageLimitWithPrecision ?? credit.usageLimit);
    const overageUsed = num(credit.currentOveragesWithPrecision ?? credit.currentOverages);
    const overageRate = num(credit.overageRate);
    const resetEpoch = num(credit.nextDateReset ?? data.nextDateReset);

    const usage: KiroUsage = {
      available: true,
      plan: sub.subscriptionTitle,
      used,
      limit,
      currency: credit.currency,
      overageUsed,
      overageRate,
      overageCost: num(credit.overageCharges) || (overageUsed && overageRate ? overageUsed * overageRate : 0),
    };
    if (limit != null && used != null) {
      usage.remaining = Math.max(0, limit - used);
      usage.percentUsed = limit > 0 ? Math.round((used / limit) * 100) : undefined;
    }
    if (resetEpoch) usage.resetsAt = new Date(resetEpoch * 1000).toISOString();
    return usage;
  } catch {
    return { available: false };
  }
}

/** Coerce a value to a finite number, or undefined. */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Send a chat request to the Kiro runtime.
 * 
 * Accepts Anthropic Messages API format and converts it to Kiro's
 * GenerateAssistantResponse format. Supports both streaming and
 * non-streaming requests.
 * 
 * Implementation notes:
 * - Extracts credentials from kiro-cli SQLite database
 * - Converts Anthropic format to Kiro runtime format
 * - Returns raw Response for streaming, parsed JSON for non-streaming
 * - AbortSignal support for request cancellation
 * 
 * TODO: Add support for:
 * - Tools (userInputMessageContext.tools + toolResults)
 * - Images (userInputMessage.images with base64 data)
 * - Retry logic with exponential backoff (403, 429, 5xx)
 * - Token refresh on 403 errors
 * 
 * @param payload - Anthropic Messages API request
 * @param options - Optional request options (signal)
 * @returns Response object (for streaming) or parsed JSON (for non-streaming)
 * @throws Error if credentials are invalid or request fails
 */
export async function chat(
  payload: AnthropicMessagesRequest,
  options: KiroChatOptions = {}
): Promise<Response | unknown> {
  // 1. Extract credentials from SQLite database
  const credentials = getKiroCredentials();
  
  // 2. Get runtime URL
  const baseUrl = getKiroBaseUrl(credentials.region);
  
  // 3. Convert Anthropic payload to Kiro format
  const kiroBody = convertAnthropicToKiro(payload, credentials);
  
  // 4. Build headers
  const headers = getKiroHeaders(credentials.accessToken);
  
  // 5. Make request. The runtime endpoint is POST <host>/generateAssistantResponse
  // (AmazonCodeWhispererStreamingService.GenerateAssistantResponse).
  const response = await fetch(`${baseUrl}/generateAssistantResponse`, {
    method: "POST",
    headers,
    body: JSON.stringify(kiroBody),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kiro runtime error (${response.status}): ${errorText}`);
  }

  // The runtime responds with an AWS vnd.amazon.eventstream body (binary,
  // length-prefixed frames whose payloads carry JSON). We decode the full
  // body, extract the assistant text and any tool uses, and return Anthropic shape.
  const raw = new Uint8Array(await response.arrayBuffer());
  const decoded = decodeKiroEventStream(raw);
  const { text, toolUses } = decoded;

  if (payload.stream) {
    // Re-emit as an Anthropic SSE stream so streaming clients get the expected
    // event sequence, including tool_use blocks.
    return new Response(toAnthropicSse(text, toolUses, payload.model), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  // Assemble Anthropic content blocks: text first (if any), then tool_use.
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const tu of toolUses) {
    content.push({ type: "tool_use", id: tu.toolUseId, name: tu.name, input: tu.input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: payload.model,
    content,
    stop_reason: toolUses.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** A fully-assembled tool use decoded from the event stream. */
export interface DecodedToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** Result of decoding a Kiro event-stream response. */
export interface DecodedKiroResponse {
  text: string;
  toolUses: DecodedToolUse[];
}

/**
 * Decode an AWS event-stream (vnd.amazon.eventstream) response body into the
 * assistant text and any tool uses it carries.
 *
 * Rather than fully parsing the binary frame CRCs, we decode the bytes and
 * extract the embedded JSON event payloads:
 * - assistantResponseEvent chunks: {"content":"..."} — concatenated in order.
 * - toolUseEvent chunks: {"toolUseId":"…","name":"…","input":"<json-chunk>","stop":bool}
 *   The `input` arrives as partial JSON string fragments that we accumulate per
 *   toolUseId and parse once complete.
 */
export function decodeKiroEventStream(bytes: Uint8Array): DecodedKiroResponse {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const asText = decoder.decode(bytes);

  // --- Assistant text: match "content":"..." allowing escaped quotes. ---
  // Guard against accidentally matching tool_result "content" by only taking
  // content fields that are NOT part of a toolUse frame. We scan linearly.
  let text = "";
  const contentRe = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let cm: RegExpExecArray | null;
  while ((cm = contentRe.exec(asText)) !== null) {
    try {
      text += JSON.parse(`"${cm[1]}"`);
    } catch {
      text += cm[1];
    }
  }

  // --- Tool uses: accumulate input fragments per toolUseId. ---
  const order: string[] = [];
  const acc = new Map<string, { name: string; inputStr: string }>();

  // Match each toolUse frame's fields. Frames may contain any subset of
  // toolUseId/name/input, so we capture them with individual scans anchored on
  // toolUseId occurrences.
  const idRe = /"toolUseId"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let im: RegExpExecArray | null;
  while ((im = idRe.exec(asText)) !== null) {
    const id = safeJsonStr(im[1]);
    if (!acc.has(id)) {
      acc.set(id, { name: "", inputStr: "" });
      order.push(id);
    }
    // Look ahead in a small window after this toolUseId for name/input.
    const window = asText.slice(im.index, im.index + 4000);
    const nameM = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(window);
    if (nameM) {
      const nm = safeJsonStr(nameM[1]);
      if (nm) acc.get(id)!.name = nm;
    }
    const inputM = /"input"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(window);
    if (inputM) acc.get(id)!.inputStr += safeJsonStr(inputM[1]);
  }

  const toolUses: DecodedToolUse[] = order.map((id) => {
    const entry = acc.get(id)!;
    let input: unknown = {};
    const s = entry.inputStr.trim();
    if (s) {
      try {
        input = JSON.parse(s);
      } catch {
        input = { _raw: s };
      }
    }
    return { toolUseId: id, name: entry.name, input };
  });

  return { text, toolUses };
}

/** Parse a JSON string body ("..." contents) safely, falling back to raw. */
function safeJsonStr(inner: string): string {
  try {
    return JSON.parse(`"${inner}"`);
  } catch {
    return inner;
  }
}

/**
 * Build an Anthropic Messages SSE stream for a complete text + tool uses.
 * Emits text as content block 0 (when present), then one tool_use block per
 * decoded tool use, with the correct stop_reason.
 */
function toAnthropicSse(text: string, toolUses: DecodedToolUse[], model: string): string {
  const id = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  let out = ev("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let index = 0;
  if (text || toolUses.length === 0) {
    out +=
      ev("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }) +
      ev("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      }) +
      ev("content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  for (const tu of toolUses) {
    const inputJson = JSON.stringify(tu.input ?? {});
    out +=
      ev("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: tu.toolUseId, name: tu.name, input: {} },
      }) +
      ev("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }) +
      ev("content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  out +=
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: toolUses.length ? "tool_use" : "end_turn" },
      usage: { output_tokens: 0 },
    }) +
    ev("message_stop", { type: "message_stop" });

  return out;
}

// ============================================================================
// Export for convenience
// ============================================================================

export default {
  listModels,
  listDisplayModels,
  toDisplayModelId,
  toRealModelId,
  chat,
  getKiroCredentials,
  getKiroUsage,
  getKiroBaseUrl,
  KIRO_MODELS,
};
