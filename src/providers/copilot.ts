/**
 * GitHub Copilot API Provider
 * 
 * This module provides direct access to GitHub Copilot's chat completion API.
 * It handles GitHub OAuth token exchange, Copilot token caching with auto-refresh,
 * and provides streaming and non-streaming chat completion capabilities.
 * 
 * @module providers/copilot
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

/**
 * Response from GitHub Copilot token exchange endpoint
 */
export interface CopilotTokenResponse {
  /** The Copilot access token */
  token: string;
  /** Unix timestamp (seconds) when the token expires */
  expires_at: number;
  /** Optional per-SKU endpoints for isolated infrastructure */
  endpoints?: {
    /** Base API URL for Copilot requests */
    api?: string;
    /** Proxy endpoint */
    proxy?: string;
    /** Telemetry endpoint */
    telemetry?: string;
  };
  /** Optional quota snapshots (chat / completions / premium interactions). */
  quota_snapshots?: Record<string, unknown>;
  /** Optional reset timestamp for quotas (unix seconds). */
  quota_reset_date?: string;
  /** Any other fields the token endpoint returns. */
  [key: string]: unknown;
}

/** Best-effort quota/credit snapshot for the dashboard. */
export interface CopilotQuota {
  /** Whether Copilot is currently authenticated. */
  available: boolean;
  /** When the current Copilot token expires (ISO string), if known. */
  tokenExpiresAt?: string;
  /** Raw quota snapshots from the token endpoint, if present. */
  quotaSnapshots?: Record<string, unknown>;
  /** Quota reset date, if present. */
  quotaResetDate?: string;
}

/**
 * Model information from the /models endpoint
 */
export interface CopilotModel {
  /** Model identifier (e.g., "gpt-4", "gpt-4o") */
  id: string;
  /** Additional model metadata */
  [key: string]: unknown;
}

/**
 * Response from the /models endpoint
 */
export interface CopilotModelsResponse {
  /** Array of available models */
  data: CopilotModel[];
}

/**
 * Chat completion request payload (OpenAI-compatible format)
 */
export interface ChatCompletionPayload {
  /** Model identifier */
  model: string;
  /** Array of conversation messages */
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    [key: string]: unknown;
  }>;
  /** Enable streaming responses */
  stream?: boolean;
  /** Sampling temperature */
  temperature?: number;
  /** Maximum tokens to generate */
  max_tokens?: number;
  /** Additional parameters */
  [key: string]: unknown;
}

/**
 * Options for chat completion requests
 */
export interface ChatCompletionOptions {
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
}

// ============================================================================
// Configuration & State
// ============================================================================

const GITHUB_API_BASE = 'https://api.github.com';
const COPILOT_DEFAULT_BASE = 'https://api.githubcopilot.com';
const GITHUB_TOKEN_PATH = join(homedir(), '.local/share/copilot-api/github_token');

// Token refresh buffer: refresh when within 60 seconds of expiration
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * Cached Copilot token state
 */
interface TokenCache {
  token: string;
  expiresAt: number;
  baseUrl: string;
  quotaSnapshots?: Record<string, unknown>;
  quotaResetDate?: string;
}

let tokenCache: TokenCache | null = null;

// ============================================================================
// GitHub Token Management
// ============================================================================

/**
 * Reads the GitHub OAuth token from file or environment variable.
 * 
 * Priority:
 * 1. GITHUB_TOKEN environment variable (if set)
 * 2. ~/.local/share/copilot-api/github_token file
 * 
 * @returns The GitHub OAuth token
 * @throws Error if token is not found or cannot be read
 */
async function getGitHubToken(): Promise<string> {
  // Check environment variable first
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    return envToken.trim();
  }

  // Read from file
  try {
    const fileContent = await readFile(GITHUB_TOKEN_PATH, 'utf-8');
    const token = fileContent.trim();
    if (!token) {
      throw new Error('GitHub token file is empty');
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `GitHub token not found. Set GITHUB_TOKEN environment variable or create ${GITHUB_TOKEN_PATH}`
      );
    }
    throw new Error(`Failed to read GitHub token: ${(error as Error).message}`);
  }
}

// ============================================================================
// Copilot Token Exchange & Caching
// ============================================================================

/**
 * Exchanges a GitHub OAuth token for a Copilot access token.
 * 
 * @param githubToken - The GitHub OAuth token
 * @returns Copilot token response with token and metadata
 * @throws Error if the exchange fails
 */
async function exchangeCopilotToken(githubToken: string): Promise<CopilotTokenResponse> {
  const url = `${GITHUB_API_BASE}/copilot_internal/v2/token`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'authorization': `token ${githubToken}`,
      'user-agent': 'GitHubCopilotChat/0.68.0',
      'editor-version': 'vscode/1.95.0',
      'editor-plugin-version': 'copilot-chat/0.68.0',
      'x-github-api-version': '2025-04-01',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Failed to exchange Copilot token: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  const data = await response.json() as CopilotTokenResponse;
  
  if (!data.token || !data.expires_at) {
    throw new Error('Invalid Copilot token response: missing token or expires_at');
  }

  return data;
}

/**
 * Checks if the cached token needs refresh.
 * 
 * @param cache - The cached token state
 * @returns true if token should be refreshed
 */
function shouldRefreshToken(cache: TokenCache | null): boolean {
  if (!cache) {
    return true;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const bufferSeconds = Math.floor(TOKEN_REFRESH_BUFFER_MS / 1000);
  
  return nowSeconds >= (cache.expiresAt - bufferSeconds);
}

/**
 * Gets a valid Copilot token, using cache or refreshing as needed.
 * 
 * This function automatically manages token caching and refresh:
 * - Returns cached token if still valid (more than 60s until expiration)
 * - Fetches new token from GitHub if cache is missing or expired
 * - Extracts base URL from token response for routing
 * 
 * @returns Promise resolving to a valid Copilot access token
 * @throws Error if token exchange fails
 */
export async function getCopilotToken(): Promise<string> {
  if (!shouldRefreshToken(tokenCache)) {
    return tokenCache!.token;
  }

  const githubToken = await getGitHubToken();
  const response = await exchangeCopilotToken(githubToken);

  tokenCache = {
    token: response.token,
    expiresAt: response.expires_at,
    baseUrl: response.endpoints?.api || COPILOT_DEFAULT_BASE,
    quotaSnapshots:
      response.quota_snapshots && typeof response.quota_snapshots === "object"
        ? (response.quota_snapshots as Record<string, unknown>)
        : undefined,
    quotaResetDate:
      typeof response.quota_reset_date === "string" ? response.quota_reset_date : undefined,
  };

  return tokenCache.token;
}

/**
 * Gets the current Copilot API base URL.
 * 
 * @returns The base URL for Copilot API requests
 */
function getCopilotBaseUrl(): string {
  return tokenCache?.baseUrl || COPILOT_DEFAULT_BASE;
}

/**
 * Best-effort quota/credit snapshot for the dashboard. Forces a token fetch so
 * authentication state is accurate; returns { available:false } if not signed in.
 */
export async function getCopilotQuota(): Promise<CopilotQuota> {
  try {
    await getCopilotToken();
  } catch {
    return { available: false };
  }
  const c = tokenCache;
  return {
    available: true,
    tokenExpiresAt: c?.expiresAt ? new Date(c.expiresAt * 1000).toISOString() : undefined,
    quotaSnapshots: c?.quotaSnapshots,
    quotaResetDate: c?.quotaResetDate,
  };
}

// ============================================================================
// Copilot API Headers
// ============================================================================

/**
 * Creates standard headers for Copilot API requests.
 * 
 * @param copilotToken - The Copilot access token
 * @param extraHeaders - Additional headers to merge
 * @returns Headers object for fetch requests
 */
function createCopilotHeaders(
  copilotToken: string,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  return {
    'authorization': `Bearer ${copilotToken}`,
    'editor-version': 'vscode/1.95.0',
    'editor-plugin-version': 'copilot-chat/0.68.0',
    'copilot-integration-id': 'vscode-chat',
    'user-agent': 'GitHubCopilotChat/0.68.0',
    ...extraHeaders,
  };
}

// ============================================================================
// Public API Functions
// ============================================================================

/**
 * Lists available Copilot models.
 * 
 * Fetches the list of AI models available through GitHub Copilot.
 * Each model object includes at minimum an `id` field.
 * 
 * @returns Promise resolving to array of model objects
 * @throws Error if the request fails
 * 
 * @example
 * ```typescript
 * const models = await listModels();
 * console.log(models.map(m => m.id)); // ['gpt-4', 'gpt-4o', ...]
 * ```
 */
export async function listModels(): Promise<CopilotModel[]> {
  const token = await getCopilotToken();
  const baseUrl = getCopilotBaseUrl();
  
  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: createCopilotHeaders(token, {
      'x-github-api-version': '2026-08-01',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Failed to list models: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  const data = await response.json() as CopilotModelsResponse;
  return data.data || [];
}

/**
 * Determines the x-initiator header value based on the last message role.
 * 
 * @param payload - The chat completion payload
 * @returns 'agent' if last message is assistant/tool, 'user' otherwise
 */
function getInitiator(payload: ChatCompletionPayload): 'user' | 'agent' {
  const lastMessage = payload.messages[payload.messages.length - 1];
  if (!lastMessage) {
    return 'user';
  }
  
  const role = lastMessage.role;
  return (role === 'assistant' || role === 'tool') ? 'agent' : 'user';
}

/**
 * Creates a chat completion request to Copilot.
 * 
 * Supports both streaming and non-streaming modes:
 * - If `payload.stream` is true, returns the raw Response for SSE streaming
 * - Otherwise, returns the parsed JSON response
 * 
 * @param payload - The chat completion request payload (OpenAI-compatible)
 * @param options - Optional request options (signal for cancellation)
 * @returns Promise resolving to Response (streaming) or parsed JSON (non-streaming)
 * @throws Error if the request fails
 * 
 * @example
 * ```typescript
 * // Non-streaming
 * const result = await chatCompletions({
 *   model: 'gpt-4',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * console.log(result);
 * 
 * // Streaming
 * const response = await chatCompletions({
 *   model: 'gpt-4',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   stream: true,
 * });
 * // Pipe response.body as SSE stream
 * ```
 */
export async function chatCompletions(
  payload: ChatCompletionPayload,
  options?: ChatCompletionOptions
): Promise<Response | unknown> {
  const token = await getCopilotToken();
  const baseUrl = getCopilotBaseUrl();
  const initiator = getInitiator(payload);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: createCopilotHeaders(token, {
      'content-type': 'application/json',
      'openai-intent': 'conversation-edits',
      'x-initiator': initiator,
      'x-github-api-version': '2026-08-01',
    }),
    body: JSON.stringify(payload),
    signal: options?.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Chat completion request failed: ${response.status} ${response.statusText}. ${errorText}`
    );
  }

  // Return raw Response for streaming, parsed JSON otherwise
  if (payload.stream) {
    return response;
  }

  return await response.json();
}
