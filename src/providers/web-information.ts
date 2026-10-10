export type WebProvider = "exa" | "firecrawl";
export type ProviderErrorCategory = "auth" | "quota" | "rate_limit" | "transient" | "unknown";
export type RequestOutcome = "not_sent" | "rejected" | "unknown";

export interface UsageObservation {
  known: true;
  value: { credits?: number; costUsd?: number };
  source: "provider-response";
}

export interface UnknownUsage {
  known: false;
  reason: string;
}

export type ObservedUsage = UsageObservation | UnknownUsage;

export class WebInformationProviderError extends Error {
  readonly name = "WebInformationProviderError";

  constructor(
    readonly provider: WebProvider,
    readonly category: ProviderErrorCategory,
    readonly requestOutcome: RequestOutcome,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class WebInformationInputError extends TypeError {
  readonly name = "WebInformationInputError";
}

export interface SearchRequest<Options> {
  query: string;
  maxResults?: number;
  providerOptions?: Options;
  signal?: AbortSignal;
}

export interface ExtractRequest<Options> {
  url: string;
  providerOptions?: Options;
  signal?: AbortSignal;
}

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  score?: number;
}

export interface ExtractResult {
  url: string;
  title?: string;
  content?: string;
  contentByFormat?: Record<string, string>;
}

export interface SearchResponse {
  provider: WebProvider;
  results: SearchResult[];
  usage: ObservedUsage;
}

export interface ExtractResponse {
  provider: WebProvider;
  results: ExtractResult[];
  usage: ObservedUsage;
}

export interface WebInformationAdapter<SearchOptions, ExtractOptions> {
  readonly provider: WebProvider;
  readonly capabilities: Readonly<{ search: true; extract: true }>;
  search(request: SearchRequest<SearchOptions>): Promise<SearchResponse>;
  extract(request: ExtractRequest<ExtractOptions>): Promise<ExtractResponse>;
}

export interface ExaSearchOptions {
  type?: "auto" | "neural" | "keyword" | "fast" | "deep";
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  highlights?: boolean;
}

export interface ExaExtractOptions {
  text?: boolean;
  highlights?: boolean;
}

export type FirecrawlFormat = "markdown" | "html" | "rawHtml" | "links";

export interface FirecrawlScrapeOptions {
  formats?: readonly FirecrawlFormat[];
  onlyMainContent?: boolean;
}

export interface FirecrawlSearchOptions {
  scrapeOptions?: FirecrawlScrapeOptions;
}

export type FirecrawlExtractOptions = FirecrawlScrapeOptions;

export interface AdapterDependencies {
  /** Network access is always supplied by the caller. */
  fetch: typeof globalThis.fetch;
  /** Credentials remain in caller memory and are never persisted or logged here. */
  resolveCredential(provider: WebProvider): string | Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const WEB_INFORMATION_LIMITS = Object.freeze({
  queryChars: 2_000,
  urlChars: 2_048,
  maxResults: 20,
  maxSnippetChars: 20_000,
  maxContentChars: 100_000,
  maxResponseBytes: 1_000_000,
  maxTimeoutMs: 30_000,
  maxRequestBytes: 32_000,
});

const EXA_ORIGIN = "https://api.exa.ai";
const FIRECRAWL_ORIGIN = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = WEB_INFORMATION_LIMITS.maxResponseBytes;
const FIRECRAWL_FORMATS = new Set<FirecrawlFormat>(["markdown", "html", "rawHtml", "links"]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebInformationInputError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function onlyKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new WebInformationInputError(`${label} contains an unsupported option`);
}

function validateQuery(query: unknown): string {
  if (typeof query !== "string" || query.trim().length === 0 || query.length > WEB_INFORMATION_LIMITS.queryChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) {
    throw new WebInformationInputError(`query must be non-empty and at most ${WEB_INFORMATION_LIMITS.queryChars} characters`);
  }
  return query;
}

function validateUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > WEB_INFORMATION_LIMITS.urlChars) {
    throw new WebInformationInputError(`url must be at most ${WEB_INFORMATION_LIMITS.urlChars} characters`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebInformationInputError("url must be an absolute HTTP(S) URL");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password) {
    throw new WebInformationInputError("url must be an absolute HTTP(S) URL without embedded credentials");
  }
  return url.toString();
}

function responseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > WEB_INFORMATION_LIMITS.urlChars) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

function validateMaxResults(value: unknown): number {
  const count = value === undefined ? 10 : value;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > WEB_INFORMATION_LIMITS.maxResults) {
    throw new WebInformationInputError(`maxResults must be an integer from 1 to ${WEB_INFORMATION_LIMITS.maxResults}`);
  }
  return count as number;
}

function validateDomainList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 253 || /[\r\n\u0000]/.test(entry))) {
    throw new WebInformationInputError(`${label} must contain at most 20 non-empty domain strings`);
  }
  return [...value] as string[];
}

function validateDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new WebInformationInputError(`${label} must be an ISO calendar date`);
  }
  return value;
}

function validateExaSearchOptions(input: unknown): ExaSearchOptions {
  const options = input === undefined ? {} : record(input, "Exa search options");
  onlyKeys(options, ["type", "includeDomains", "excludeDomains", "startPublishedDate", "endPublishedDate", "highlights"], "Exa search options");
  const searchType = options.type;
  if (searchType !== undefined && !["auto", "neural", "keyword", "fast", "deep"].includes(searchType as string)) {
    throw new WebInformationInputError("Exa type is unsupported");
  }
  if (options.highlights !== undefined && typeof options.highlights !== "boolean") {
    throw new WebInformationInputError("Exa highlights must be boolean");
  }
  return {
    ...(searchType ? { type: searchType as ExaSearchOptions["type"] } : {}),
    ...(options.includeDomains !== undefined ? { includeDomains: validateDomainList(options.includeDomains, "includeDomains") } : {}),
    ...(options.excludeDomains !== undefined ? { excludeDomains: validateDomainList(options.excludeDomains, "excludeDomains") } : {}),
    ...(options.startPublishedDate !== undefined ? { startPublishedDate: validateDate(options.startPublishedDate, "startPublishedDate") } : {}),
    ...(options.endPublishedDate !== undefined ? { endPublishedDate: validateDate(options.endPublishedDate, "endPublishedDate") } : {}),
    ...(options.highlights !== undefined ? { highlights: options.highlights as boolean } : {}),
  };
}

function validateExaExtractOptions(input: unknown): ExaExtractOptions {
  const options = input === undefined ? {} : record(input, "Exa extract options");
  onlyKeys(options, ["text", "highlights"], "Exa extract options");
  for (const key of ["text", "highlights"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw new WebInformationInputError(`Exa ${key} must be boolean`);
  }
  return { ...(options.text !== undefined ? { text: options.text as boolean } : {}), ...(options.highlights !== undefined ? { highlights: options.highlights as boolean } : {}) };
}

function validateFirecrawlScrapeOptions(input: unknown, label: string): FirecrawlScrapeOptions {
  const options = input === undefined ? {} : record(input, label);
  onlyKeys(options, ["formats", "onlyMainContent"], label);
  let formats: FirecrawlFormat[] | undefined;
  if (options.formats !== undefined) {
    if (!Array.isArray(options.formats) || options.formats.length < 1 || options.formats.length > 4 || options.formats.some((format) => !FIRECRAWL_FORMATS.has(format as FirecrawlFormat))) {
      throw new WebInformationInputError(`${label}.formats contains an unsupported format`);
    }
    formats = [...new Set(options.formats as FirecrawlFormat[])];
  }
  if (options.onlyMainContent !== undefined && typeof options.onlyMainContent !== "boolean") {
    throw new WebInformationInputError(`${label}.onlyMainContent must be boolean`);
  }
  return { ...(formats ? { formats } : {}), ...(options.onlyMainContent !== undefined ? { onlyMainContent: options.onlyMainContent as boolean } : {}) };
}

function validateFirecrawlSearchOptions(input: unknown): FirecrawlSearchOptions {
  const options = input === undefined ? {} : record(input, "Firecrawl search options");
  onlyKeys(options, ["scrapeOptions"], "Firecrawl search options");
  return options.scrapeOptions === undefined ? {} : { scrapeOptions: validateFirecrawlScrapeOptions(options.scrapeOptions, "Firecrawl search scrapeOptions") };
}

function requestTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1) throw new WebInformationInputError("timeoutMs must be a positive finite number");
  return Math.min(WEB_INFORMATION_LIMITS.maxTimeoutMs, Math.floor(value));
}

function responseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RESPONSE_BYTES;
  if (!Number.isFinite(value) || value < 1) throw new WebInformationInputError("maxResponseBytes must be a positive finite number");
  return Math.min(WEB_INFORMATION_LIMITS.maxResponseBytes, Math.floor(value));
}

async function credentialFor(deps: AdapterDependencies, provider: WebProvider): Promise<string> {
  let credential: string;
  try {
    credential = await deps.resolveCredential(provider);
  } catch {
    throw new WebInformationProviderError(provider, "auth", "not_sent", "provider credential is unavailable");
  }
  if (typeof credential !== "string" || credential.length === 0 || credential.length > 8_192 || /[\r\n]/.test(credential)) {
    throw new WebInformationProviderError(provider, "auth", "not_sent", "provider credential is invalid");
  }
  return credential;
}

function providerError(provider: WebProvider, status: number, headers: Headers): WebInformationProviderError {
  let category: ProviderErrorCategory = "unknown";
  if (status === 401 || status === 403) category = "auth";
  else if (status === 402) category = "quota";
  else if (status === 429) category = "rate_limit";
  else if (status === 408 || status === 425 || status >= 500) category = "transient";
  const outcome: RequestOutcome = status >= 500 || status === 408 || status === 425 ? "unknown" : "rejected";
  const retryAfter = headers.get("retry-after");
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : undefined;
  return new WebInformationProviderError(
    provider,
    category,
    outcome,
    `provider request failed (${category})`,
    status,
    seconds !== undefined && Number.isFinite(seconds) ? Math.min(seconds * 1_000, 300_000) : undefined,
  );
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* response cleanup is best effort */ }
}

async function readBoundedJson(response: Response, provider: WebProvider, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelBody(response);
    throw new WebInformationProviderError(provider, "unknown", "unknown", "provider response exceeded the configured size limit", response.status);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WebInformationProviderError(provider, "unknown", "unknown", "provider response exceeded the configured size limit", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebInformationProviderError(provider, "unknown", "unknown", "provider returned invalid JSON", response.status);
  }
}

async function postJson(
  deps: AdapterDependencies,
  provider: WebProvider,
  url: string,
  body: JsonRecord,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new WebInformationProviderError(provider, "transient", "not_sent", "request cancelled before sending");
  const credential = await credentialFor(deps, provider);
  if (signal?.aborted) throw new WebInformationProviderError(provider, "transient", "not_sent", "request cancelled before sending");
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > WEB_INFORMATION_LIMITS.maxRequestBytes) throw new WebInformationInputError("request exceeds the configured size limit");
  const timeoutMs = requestTimeout(deps.timeoutMs);
  const maxBytes = responseLimit(deps.maxResponseBytes);
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(provider === "exa" ? { "x-api-key": credential } : { authorization: `Bearer ${credential}` }),
      },
      body: serialized,
      signal: requestSignal,
      redirect: "error",
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const timedOut = timeoutController.signal.aborted;
    const cancelled = signal?.aborted;
    throw new WebInformationProviderError(
      provider,
      "transient",
      "unknown",
      cancelled ? "provider request was cancelled" : timedOut ? "provider request timed out" : "provider request failed before a response",
    );
  }
  try {
    if (!response.ok) {
      await cancelBody(response);
      throw providerError(provider, response.status, response.headers);
    }
    return await readBoundedJson(response, provider, maxBytes);
  } catch (error) {
    if (error instanceof WebInformationProviderError) throw error;
    throw new WebInformationProviderError(provider, "unknown", "unknown", "provider response could not be read", response.status);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function safeString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxChars) : undefined;
}

function responseRecord(provider: WebProvider, value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebInformationProviderError(provider, "unknown", "unknown", `${label} had an unexpected shape`);
  }
  return value as JsonRecord;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFrom(payload: unknown): ObservedUsage {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { known: false, reason: "provider response did not include usage" };
  const value = payload as JsonRecord;
  const nested = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data as JsonRecord : {};
  const credits = finite(value.creditsUsed) ?? finite(value.creditsCost) ?? finite(nested.creditsUsed) ?? finite(nested.creditsCost);
  const costUsd = finite(value.costDollars) ?? finite(nested.costDollars);
  if (credits === undefined && costUsd === undefined) return { known: false, reason: "provider response did not include usage" };
  return { known: true, value: { ...(credits !== undefined ? { credits } : {}), ...(costUsd !== undefined ? { costUsd } : {}) }, source: "provider-response" };
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, WEB_INFORMATION_LIMITS.maxResults) : [];
}

function exaSearchResults(payload: unknown, maxResults: number): SearchResult[] {
  const root = responseRecord("exa", payload, "Exa search response");
  if (!Array.isArray(root.results)) throw new WebInformationProviderError("exa", "unknown", "unknown", "Exa returned an unexpected search shape");
  return arrayFrom(root.results).slice(0, maxResults).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as JsonRecord;
    const url = responseUrl(row.url);
    if (!url) return [];
    const highlights = Array.isArray(row.highlights) ? row.highlights.filter((part): part is string => typeof part === "string").join("\n") : undefined;
    return [{
      url,
      ...(safeString(row.title, 500) ? { title: safeString(row.title, 500) } : {}),
      ...(safeString(highlights ?? row.text, WEB_INFORMATION_LIMITS.maxSnippetChars) ? { snippet: safeString(highlights ?? row.text, WEB_INFORMATION_LIMITS.maxSnippetChars) } : {}),
      ...(safeString(row.publishedDate, 100) ? { publishedAt: safeString(row.publishedDate, 100) } : {}),
      ...(finite(row.score) !== undefined ? { score: finite(row.score) } : {}),
    }];
  });
}

function firecrawlSearchResults(payload: unknown, maxResults: number): SearchResult[] {
  const root = responseRecord("firecrawl", payload, "Firecrawl search response");
  const items = Array.isArray(root.web) ? root.web : Array.isArray(root.results) ? root.results : undefined;
  if (!items) throw new WebInformationProviderError("firecrawl", "unknown", "unknown", "Firecrawl returned an unexpected search shape");
  return arrayFrom(items).slice(0, maxResults).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as JsonRecord;
    const url = responseUrl(row.url);
    if (!url) return [];
    return [{
      url,
      ...(safeString(row.title, 500) ? { title: safeString(row.title, 500) } : {}),
      ...(safeString(row.description ?? row.snippet, WEB_INFORMATION_LIMITS.maxSnippetChars) ? { snippet: safeString(row.description ?? row.snippet, WEB_INFORMATION_LIMITS.maxSnippetChars) } : {}),
      ...(safeString(row.publishedDate, 100) ? { publishedAt: safeString(row.publishedDate, 100) } : {}),
      ...(finite(row.score) !== undefined ? { score: finite(row.score) } : {}),
    }];
  });
}

function exaExtractResults(payload: unknown, url: string): ExtractResult[] {
  const root = responseRecord("exa", payload, "Exa contents response");
  if (!Array.isArray(root.results)) throw new WebInformationProviderError("exa", "unknown", "unknown", "Exa returned an unexpected contents shape");
  return arrayFrom(root.results).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as JsonRecord;
    const actualUrl = responseUrl(row.url) ?? url;
    const highlights = Array.isArray(row.highlights) ? row.highlights.filter((part): part is string => typeof part === "string").join("\n") : undefined;
    const content = safeString(row.text, WEB_INFORMATION_LIMITS.maxContentChars) ?? safeString(highlights, WEB_INFORMATION_LIMITS.maxContentChars) ?? safeString(row.summary, WEB_INFORMATION_LIMITS.maxContentChars);
    return [{ url: actualUrl, ...(safeString(row.title, 500) ? { title: safeString(row.title, 500) } : {}), ...(content ? { content } : {}) }];
  });
}

function firecrawlExtractResults(payload: unknown, url: string, formats: FirecrawlFormat[]): ExtractResult[] {
  const root = responseRecord("firecrawl", payload, "Firecrawl scrape response");
  if (root.success === false) throw new WebInformationProviderError("firecrawl", "unknown", "unknown", "Firecrawl reported an unsuccessful scrape");
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as JsonRecord : root;
  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata as JsonRecord : {};
  const contentByFormat: Record<string, string> = {};
  for (const format of formats) {
    const content = safeString(data[format], WEB_INFORMATION_LIMITS.maxContentChars);
    if (content !== undefined) contentByFormat[format] = content;
  }
  const firstContent = Object.values(contentByFormat)[0];
  const sourceUrl = responseUrl(metadata.sourceURL ?? metadata.url) ?? url;
  return [{
    url: sourceUrl,
    ...(safeString(metadata.title, 500) ? { title: safeString(metadata.title, 500) } : {}),
    ...(firstContent ? { content: firstContent } : {}),
    ...(Object.keys(contentByFormat).length ? { contentByFormat } : {}),
  }];
}

function depsWithLimits(deps: AdapterDependencies): AdapterDependencies {
  if (!deps || typeof deps.fetch !== "function" || typeof deps.resolveCredential !== "function") {
    throw new WebInformationInputError("fetch and resolveCredential dependencies are required");
  }
  requestTimeout(deps.timeoutMs);
  responseLimit(deps.maxResponseBytes);
  return deps;
}

export function createExaWebInformationAdapter(dependencies: AdapterDependencies): WebInformationAdapter<ExaSearchOptions, ExaExtractOptions> {
  const deps = depsWithLimits(dependencies);
  const capabilities = Object.freeze({ search: true as const, extract: true as const });
  return {
    provider: "exa",
    capabilities,
    async search(request) {
      const query = validateQuery(request?.query);
      const maxResults = validateMaxResults(request.maxResults);
      const options = validateExaSearchOptions(request.providerOptions);
      const body: JsonRecord = {
        query,
        type: options.type ?? "auto",
        numResults: maxResults,
        contents: { highlights: options.highlights ?? true },
        ...(options.includeDomains ? { includeDomains: options.includeDomains } : {}),
        ...(options.excludeDomains ? { excludeDomains: options.excludeDomains } : {}),
        ...(options.startPublishedDate ? { startPublishedDate: options.startPublishedDate } : {}),
        ...(options.endPublishedDate ? { endPublishedDate: options.endPublishedDate } : {}),
      };
      const payload = await postJson(deps, "exa", `${EXA_ORIGIN}/search`, body, request.signal);
      return { provider: "exa", results: exaSearchResults(payload, maxResults), usage: usageFrom(payload) };
    },
    async extract(request) {
      const url = validateUrl(request?.url);
      const options = validateExaExtractOptions(request.providerOptions);
      const body: JsonRecord = { ids: [url], text: options.text ?? true, highlights: options.highlights ?? true };
      const payload = await postJson(deps, "exa", `${EXA_ORIGIN}/contents`, body, request.signal);
      return { provider: "exa", results: exaExtractResults(payload, url), usage: usageFrom(payload) };
    },
  };
}

export function createFirecrawlWebInformationAdapter(dependencies: AdapterDependencies): WebInformationAdapter<FirecrawlSearchOptions, FirecrawlExtractOptions> {
  const deps = depsWithLimits(dependencies);
  const capabilities = Object.freeze({ search: true as const, extract: true as const });
  return {
    provider: "firecrawl",
    capabilities,
    async search(request) {
      const query = validateQuery(request?.query);
      const maxResults = validateMaxResults(request.maxResults);
      const options = validateFirecrawlSearchOptions(request.providerOptions);
      const scrapeOptions = options.scrapeOptions ? validateFirecrawlScrapeOptions(options.scrapeOptions, "Firecrawl search scrapeOptions") : undefined;
      const body: JsonRecord = { query, limit: maxResults, ...(scrapeOptions ? { scrapeOptions } : {}) };
      const payload = await postJson(deps, "firecrawl", `${FIRECRAWL_ORIGIN}/v2/search`, body, request.signal);
      return { provider: "firecrawl", results: firecrawlSearchResults(payload, maxResults), usage: usageFrom(payload) };
    },
    async extract(request) {
      const url = validateUrl(request?.url);
      const options = validateFirecrawlScrapeOptions(request.providerOptions, "Firecrawl scrape options");
      const formats: FirecrawlFormat[] = options.formats ? [...options.formats] : ["markdown"];
      const body: JsonRecord = {
        url,
        formats,
        ...(options.onlyMainContent !== undefined ? { onlyMainContent: options.onlyMainContent } : {}),
      };
      const payload = await postJson(deps, "firecrawl", `${FIRECRAWL_ORIGIN}/v2/scrape`, body, request.signal);
      return { provider: "firecrawl", results: firecrawlExtractResults(payload, url, formats), usage: usageFrom(payload) };
    },
  };
}
