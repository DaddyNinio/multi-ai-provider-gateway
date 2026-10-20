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

/** Known Kiro model identifiers (runtime.kiro.dev has no ListAvailableModels endpoint). */
export const KIRO_MODELS = [
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
}

/** Kiro authentication credentials extracted from SQLite DB. */
interface KiroCredentials {
  accessToken: string;
  profileArn: string;
  region: string;
}

/** Kiro runtime API request body structure (GenerateAssistantResponse). */
interface KiroRequestBody {
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: {
      userInputMessage: {
        content: string;
        modelId: string;
        origin: "AI_EDITOR";
        userInputMessageContext?: {
          tools?: unknown[];
        };
      };
    };
    history?: Array<
      | { userInputMessage: { content: string; modelId: string; origin: "AI_EDITOR" } }
      | { assistantResponseMessage: { content: string } }
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
      .filter(block => block.type === "text")
      .map(block => block.text || "")
      .join("");
  }
  
  return "";
}

/**
 * Convert Anthropic Messages API payload to Kiro runtime request body.
 * 
 * Kiro API structure (from converters_core.py analysis):
 * - conversationState.currentMessage.userInputMessage: the current user message
 * - conversationState.history: alternating userInputMessage and assistantResponseMessage
 * - conversationState.conversationId: stable ID based on message hash (using UUID for simplicity)
 * - profileArn: AWS CodeWhisperer profile ARN
 * 
 * Simplifications for this initial implementation:
 * - Tools are not yet supported (would go in userInputMessageContext.tools)
 * - Images are not yet supported (would go in userInputMessage.images)
 * - System prompt is prepended to first user message (matches Python implementation)
 * 
 * @param payload - Anthropic Messages API request
 * @param credentials - Kiro credentials
 * @returns Kiro runtime request body
 */
function convertAnthropicToKiro(
  payload: AnthropicMessagesRequest,
  credentials: KiroCredentials
): KiroRequestBody {
  const { messages, system, model } = payload;
  
  // Generate conversation ID (could be made stable based on message hash)
  const conversationId = crypto.randomUUID();
  
  // Build history (all messages except the last one)
  const history: KiroRequestBody["conversationState"]["history"] = [];
  const historyMessages = messages.slice(0, -1);
  
  // If we have a system prompt, prepend it to the first user message
  let systemPrepended = false;
  
  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    const content = extractTextContent(msg.content);
    
    if (msg.role === "user") {
      let userContent = content;
      
      // Prepend system prompt to the first user message
      if (!systemPrepended && system) {
        userContent = `${system}\n\n${content}`;
        systemPrepended = true;
      }
      
      history.push({
        userInputMessage: {
          content: userContent || "(empty placeholder)",
          modelId: model,
          origin: "AI_EDITOR",
        },
      });
    } else if (msg.role === "assistant") {
      history.push({
        assistantResponseMessage: {
          content: content || "(empty placeholder)",
        },
      });
    }
  }
  
  // Current message (the last one)
  const currentMsg = messages[messages.length - 1];
  let currentContent = extractTextContent(currentMsg.content);
  
  // If the current message is assistant, we need to add it to history and create a placeholder user message
  if (currentMsg.role === "assistant") {
    history.push({
      assistantResponseMessage: {
        content: currentContent || "(empty placeholder)",
      },
    });
    currentContent = "(empty placeholder)";
  } else {
    // Prepend system prompt to current message if not yet prepended and history is empty
    if (!systemPrepended && system) {
      currentContent = `${system}\n\n${currentContent}`;
    }
  }
  
  // Build the request body
  const body: KiroRequestBody = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: {
        userInputMessage: {
          content: currentContent || "(empty placeholder)",
          modelId: model,
          origin: "AI_EDITOR",
        },
      },
    },
    profileArn: credentials.profileArn,
  };
  
  // Add history if not empty
  if (history.length > 0) {
    body.conversationState.history = history;
  }
  
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
  // body, extract the assistant text, and return it in Anthropic shape.
  const raw = new Uint8Array(await response.arrayBuffer());
  const text = decodeKiroEventStream(raw);

  if (payload.stream) {
    // Re-emit as a minimal Anthropic SSE stream so clients that asked for
    // streaming still get the expected event sequence.
    return new Response(toAnthropicSse(text, payload.model), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: payload.model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Decode an AWS event-stream (vnd.amazon.eventstream) response body and
 * concatenate the assistant text it carries.
 *
 * Rather than fully parsing the binary frame CRCs, we decode the bytes and
 * extract the JSON event payloads embedded in the stream. Each content event
 * looks like {"content":"..."}; assistantResponseEvent chunks are concatenated
 * in order. This is resilient to the exact framing and is how the text is
 * reconstructed for a non-streaming reply.
 */
export function decodeKiroEventStream(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const asText = decoder.decode(bytes);

  let out = "";
  // Match "content":"..." allowing escaped quotes inside the value.
  const re = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(asText)) !== null) {
    try {
      // Unescape JSON string escapes by wrapping and parsing.
      out += JSON.parse(`"${m[1]}"`);
    } catch {
      out += m[1];
    }
  }
  return out;
}

/** Build a minimal Anthropic Messages SSE stream for a complete text. */
function toAnthropicSse(text: string, model: string): string {
  const id = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev("message_start", {
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
    }) +
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 0 },
    }) +
    ev("message_stop", { type: "message_stop" })
  );
}

// ============================================================================
// Export for convenience
// ============================================================================

export default {
  listModels,
  chat,
  getKiroCredentials,
  getKiroBaseUrl,
  KIRO_MODELS,
};
