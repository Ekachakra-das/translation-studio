import { NextResponse } from "next/server";

export const runtime = "edge";

import { flattenObject, unflattenObject } from "@/lib/json";
import {
  type BatchPipelineRow,
  type Provider,
  type ThinkingMode,
  runBatchTranslationFast,
  runBatchTranslationQuality,
  runTranslationPipeline
} from "@/lib/llm";

type TextPayload = {
  mode: "text";
  provider: Provider;
  model: string;
  thinkingMode: ThinkingMode;
  sourceLang: string;
  targetLang: string;
  context?: string;
  text: string;
};

type JsonPayload = {
  mode: "json";
  provider: Provider;
  model: string;
  thinkingMode: ThinkingMode;
  jsonQualityMode?: "fast" | "quality" | "precise";
  sourceLang: string;
  targetLang: string;
  context?: string;
  json: Record<string, unknown>;
};

type Payload = TextPayload | JsonPayload;

const JSON_BATCH_CHAR_BUDGET = 28_000;
const JSON_BATCH_SAFETY_CHARS = 4_000;
const JSON_MAX_SINGLE_VALUE_CHARS = 12_000;
const JSON_BATCH_CONCURRENCY = 4;
const JSON_QUALITY_BATCH_CONCURRENCY = 2;
const JSON_PRECISE_CONCURRENCY = 2;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_STATE_TTL_MS = 20 * 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000;
const TRANSLATION_API_TOKEN_COOKIE = "translation_api_token";
const SERVER_DEFAULT_PROVIDER: Provider =
  process.env.NEXT_PUBLIC_DEFAULT_PROVIDER === "nvidia" ? "nvidia" : "gemini";
const SERVER_GEMINI_MODEL =
  process.env.NEXT_PUBLIC_GEMINI_MODEL?.trim() || "gemini-3.1-flash-lite-preview";
const SERVER_NVIDIA_MODEL =
  process.env.NEXT_PUBLIC_NVIDIA_MODEL?.trim() || "stepfun-ai/step-3.5-flash";

type FlatEntry = { key: string; value: string };
type RateLimitState = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

const rateLimitState = new Map<string, RateLimitState>();
let lastRateLimitCleanupAt = 0;

function getServerTranslationConfig(): { provider: Provider; model: string } {
  const provider = SERVER_DEFAULT_PROVIDER;
  return {
    provider,
    model: provider === "gemini" ? SERVER_GEMINI_MODEL : SERVER_NVIDIA_MODEL
  };
}

function getTranslationApiToken(): string {
  const token = process.env.TRANSLATION_API_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing TRANSLATION_API_TOKEN in environment.");
  }
  return token;
}

function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) {
      return rest.join("=").trim();
    }
  }

  return null;
}

function chunkByCharacterBudget(entries: FlatEntry[]): FlatEntry[][] {
  const chunks: FlatEntry[][] = [];
  let current: FlatEntry[] = [];
  let currentSize = 0;
  const effectiveBudget = Math.max(2_000, JSON_BATCH_CHAR_BUDGET - JSON_BATCH_SAFETY_CHARS);

  for (const entry of entries) {
    const itemCost = entry.key.length + entry.value.length + 12;
    const tooLarge = entry.value.length > JSON_MAX_SINGLE_VALUE_CHARS;

    if (tooLarge) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }
      chunks.push([entry]);
      continue;
    }

    if (currentSize + itemCost > effectiveBudget && current.length > 0) {
      chunks.push(current);
      current = [entry];
      currentSize = itemCost;
    } else {
      current.push(entry);
      currentSize += itemCost;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

function getRequestIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwardedFor) {
    return forwardedFor;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  const connectingIp = req.headers.get("cf-connecting-ip")?.trim();
  if (connectingIp) {
    return connectingIp;
  }

  return "unknown";
}

function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");

  if (!origin || !host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function cleanupRateLimitState(now: number): void {
  if (now - lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastRateLimitCleanupAt = now;
  for (const [key, state] of rateLimitState.entries()) {
    if (state.resetAt + RATE_LIMIT_STATE_TTL_MS <= now) {
      rateLimitState.delete(key);
    }
  }
}

function enforceRateLimit(req: Request): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  cleanupRateLimitState(now);

  const key = `${req.headers.get("host") || "unknown-host"}|${getRequestIp(req)}`;
  const existing = rateLimitState.get(key);

  if (!existing || existing.resetAt <= now) {
    rateLimitState.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
      lastSeenAt: now
    });
    return { allowed: true };
  }

  existing.count += 1;
  existing.lastSeenAt = now;

  if (existing.count > RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }

  return { allowed: true };
}

export async function POST(req: Request) {
  try {
    // Only allow browser requests from the same origin as this app.
    if (!isSameOriginRequest(req)) {
      return NextResponse.json(
        { error: "Forbidden: Cross-origin requests are not allowed." },
        { status: 403 }
      );
    }

    const expectedToken = getTranslationApiToken();
    const providedToken =
      req.headers.get("x-translation-api-token")?.trim() ||
      parseCookieValue(req.headers.get("cookie"), TRANSLATION_API_TOKEN_COOKIE);

    if (!providedToken || providedToken !== expectedToken) {
      return NextResponse.json(
        { error: "Unauthorized: Missing or invalid API token." },
        { status: 401 }
      );
    }

    const rateLimit = enforceRateLimit(req);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many translation requests. Please try again later."
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds)
          }
        }
      );
    }

    const translationConfig = getServerTranslationConfig();
    const body = (await req.json()) as Payload;

    if (body.mode === "text") {
      const result = await runTranslationPipeline({
        provider: translationConfig.provider,
        model: translationConfig.model,
        thinkingMode: body.thinkingMode,
        sourceLang: body.sourceLang,
        targetLang: body.targetLang,
        context: body.context,
        text: body.text
      });
      return NextResponse.json(result);
    }

    const flat = flattenObject(body.json);
    const table: Array<{
      key: string;
      original: string;
      initial: string;
      critique: string;
      improved: string;
    }> = [];

    const jsonQualityMode =
      body.jsonQualityMode === "quality" || body.jsonQualityMode === "precise"
        ? body.jsonQualityMode
        : "fast";
    const translatedFlat: Record<string, string> = {};
    const entries = Object.entries(flat).map(([key, value]) => ({ key, value }));
    if (jsonQualityMode === "precise") {
      const preciseRows = await mapWithConcurrency(
        entries,
        JSON_PRECISE_CONCURRENCY,
        async ({ key, value }) => {
          const result = await runTranslationPipeline({
            provider: translationConfig.provider,
            model: translationConfig.model,
            thinkingMode: body.thinkingMode,
            sourceLang: body.sourceLang,
            targetLang: body.targetLang,
            context: body.context,
            text: value
          });
          return {
            key,
            original: value,
            initial: result.initialTranslation,
            critique: result.critique,
            improved: result.improvedTranslation
          };
        }
      );

      for (const row of preciseRows) {
        translatedFlat[row.key] = row.improved;
        table.push(row);
      }
    } else if (jsonQualityMode === "quality") {
      const batches = chunkByCharacterBudget(entries);
      const qualityBatchResults = await mapWithConcurrency(
        batches,
        JSON_QUALITY_BATCH_CONCURRENCY,
        async (batch): Promise<BatchPipelineRow[]> =>
          runBatchTranslationQuality({
            provider: translationConfig.provider,
            model: translationConfig.model,
            thinkingMode: body.thinkingMode,
            sourceLang: body.sourceLang,
            targetLang: body.targetLang,
            context: body.context,
            items: batch.map(({ key, value }) => ({ key, text: value }))
          })
      );

      for (const rows of qualityBatchResults) {
        for (const row of rows) {
          translatedFlat[row.key] = row.improved;
          table.push({
            key: row.key,
            original: flat[row.key] ?? "",
            initial: row.initial,
            critique: row.critique,
            improved: row.improved
          });
        }
      }
    } else {
      const batches = chunkByCharacterBudget(entries);
      const batchResults = await mapWithConcurrency(
        batches,
        JSON_BATCH_CONCURRENCY,
        async (batch) =>
          runBatchTranslationFast({
            provider: translationConfig.provider,
            model: translationConfig.model,
            thinkingMode: body.thinkingMode,
            sourceLang: body.sourceLang,
            targetLang: body.targetLang,
            context: body.context,
            items: batch.map(({ key, value }) => ({ key, text: value }))
          })
      );

      for (const batch of batchResults) {
        Object.assign(translatedFlat, batch);
      }

      for (const { key, value } of entries) {
        const translatedValue = translatedFlat[key] ?? value;
        table.push({
          key,
          original: value,
          initial: translatedValue,
          critique: "Fast JSON mode: critique skipped.",
          improved: translatedValue
        });
      }
    }

    return NextResponse.json({
      table,
      translatedJson: unflattenObject(translatedFlat)
    });
  } catch (error) {
    console.error("Translation error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error. Please try again later.";
    return NextResponse.json(
      { error: message },
      { status: 502 }
    );
  }
}
