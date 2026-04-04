import { GoogleGenAI } from "@google/genai";

export type PipelineOutput = {
  initialTranslation: string;
  critique: string;
  improvedTranslation: string;
};

export type Provider = "nvidia" | "gemini";
export type ThinkingMode = "standard" | "extended" | "deep";

type PipelineInput = {
  sourceLang: string;
  targetLang: string;
  text: string;
  context?: string;
  provider: Provider;
  model: string;
  thinkingMode: ThinkingMode;
};

type BatchTranslateInput = {
  sourceLang: string;
  targetLang: string;
  context?: string;
  provider: Provider;
  model: string;
  thinkingMode: ThinkingMode;
  items: Array<{ key: string; text: string }>;
};

export type BatchPipelineRow = {
  key: string;
  initial: string;
  critique: string;
  improved: string;
};

type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

const FAST_TEXT_THRESHOLD_CHARS = 4_000;
const FAST_MODE_TIMEOUT_MS = 30_000;
const THINK_MODE_TIMEOUT_MS = 45_000;
const MEDIUM_PROMPT_THRESHOLD_CHARS = 8_000;
const MEDIUM_TIMEOUT_MS = 60_000;
const LARGE_TIMEOUT_STEP_CHARS = 2_000;
const LARGE_TIMEOUT_STEP_MS = 20_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite-preview";
const DEFAULT_NVIDIA_FALLBACK_MODEL =
  process.env.NVIDIA_FALLBACK_MODEL?.trim() || "stepfun-ai/step-3.5-flash";
const MAX_OUTPUT_TOKENS_BY_MODE: Record<ThinkingMode, number> = {
  standard: 30_720,
  extended: 40_960,
  deep: 61_440
};
const CIRCUIT_BREAKER_FAILURES_FOR_5_MIN = 3;
const CIRCUIT_BREAKER_FAILURES_FOR_10_MIN = 5;
const CIRCUIT_BREAKER_FAILURES_FOR_15_MIN = 7;
const CIRCUIT_BREAKER_5_MIN_MS = 5 * 60_000;
const CIRCUIT_BREAKER_10_MIN_MS = 10 * 60_000;
const CIRCUIT_BREAKER_15_MIN_MS = 15 * 60_000;

type NvidiaCircuitState = {
  consecutiveRetryableFailures: number;
  openUntil: number;
};

const nvidiaCircuitState: NvidiaCircuitState = {
  consecutiveRetryableFailures: 0,
  openUntil: 0
};

function getAdaptiveTimeoutMs(thinkingMode: ThinkingMode, promptChars: number): number {
  const normalizedChars = Math.max(0, promptChars);
  if (normalizedChars <= FAST_TEXT_THRESHOLD_CHARS) {
    return thinkingMode === "standard" ? FAST_MODE_TIMEOUT_MS : THINK_MODE_TIMEOUT_MS;
  }

  if (normalizedChars <= MEDIUM_PROMPT_THRESHOLD_CHARS) {
    return MEDIUM_TIMEOUT_MS;
  }

  const overflowChars = normalizedChars - MEDIUM_PROMPT_THRESHOLD_CHARS;
  const steps = Math.ceil(overflowChars / LARGE_TIMEOUT_STEP_CHARS);
  const modeMultiplier = thinkingMode === "deep" ? 1.2 : thinkingMode === "extended" ? 1.1 : 1;
  const extraMs = Math.ceil(steps * LARGE_TIMEOUT_STEP_MS * modeMultiplier);

  return Math.min(MAX_TIMEOUT_MS, MEDIUM_TIMEOUT_MS + extraMs);
}

function getTimeoutGuidance(thinkingMode: ThinkingMode): string {
  if (thinkingMode === "standard") {
    return "Try a shorter text or split the text into smaller parts.";
  }
  if (thinkingMode === "extended") {
    return "Try a shorter text or switch to Standard mode.";
  }
  return "Try a shorter text or switch to Extended or Standard mode.";
}

function formatTokenUsage(usage: TokenUsage): string {
  const parts = [
    usage.promptTokens !== undefined ? `prompt=${usage.promptTokens}` : null,
    usage.completionTokens !== undefined ? `completion=${usage.completionTokens}` : null,
    usage.totalTokens !== undefined ? `total=${usage.totalTokens}` : null
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : "tokens=unknown";
}

function logModelCall(params: {
  provider: Provider;
  model: string;
  durationMs: number;
  usage: TokenUsage;
}): void {
  console.info(
    `[llm] provider=${params.provider} model=${params.model} durationMs=${params.durationMs} ${formatTokenUsage(params.usage)}`
  );
}

function sanitizeProviderReferences(message: string): string {
  const normalized = message
    .replace(/\bNVIDIA\b/gi, "AI")
    .replace(/\bGemini\b/gi, "AI")
    .replace(/\bNVIDIA_API_KEY\b/gi, "AI API key")
    .replace(/\bGEMINI_API_KEY\b/gi, "AI API key")
    .replace(/\bGOOGLE_API_KEY\b/gi, "AI API key");

  const compact = normalized.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();

  if (
    lower.includes("quota exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("you exceeded your current quota")
  ) {
    const retryMatch = compact.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
    if (retryMatch) {
      const seconds = Math.max(1, Math.ceil(Number(retryMatch[1])));
      return `AI rate limit reached. Please retry in about ${seconds} seconds.`;
    }
    return "AI rate limit reached. Please retry shortly.";
  }

  return compact;
}

function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function hasNvidiaApiKey(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY);
}

function getGeminiFallbackModel(): string {
  const envModel = process.env.GEMINI_FALLBACK_MODEL?.trim();
  return envModel && envModel.length > 0 ? envModel : DEFAULT_GEMINI_FALLBACK_MODEL;
}

function getNvidiaFallbackModel(): string {
  return DEFAULT_NVIDIA_FALLBACK_MODEL;
}

function isRetryablePrimaryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("degraded function cannot be invoked") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded")
  );
}

function getCircuitBreakerCooldownMs(failures: number): number {
  if (failures >= CIRCUIT_BREAKER_FAILURES_FOR_15_MIN) {
    return CIRCUIT_BREAKER_15_MIN_MS;
  }
  if (failures >= CIRCUIT_BREAKER_FAILURES_FOR_10_MIN) {
    return CIRCUIT_BREAKER_10_MIN_MS;
  }
  if (failures >= CIRCUIT_BREAKER_FAILURES_FOR_5_MIN) {
    return CIRCUIT_BREAKER_5_MIN_MS;
  }
  return 0;
}

function isNvidiaCircuitOpen(now = Date.now()): boolean {
  return nvidiaCircuitState.openUntil > now;
}

function recordNvidiaRetryableFailure(): void {
  nvidiaCircuitState.consecutiveRetryableFailures += 1;
  const cooldownMs = getCircuitBreakerCooldownMs(
    nvidiaCircuitState.consecutiveRetryableFailures
  );

  if (cooldownMs > 0) {
    nvidiaCircuitState.openUntil = Date.now() + cooldownMs;
  }
}

function recordNvidiaSuccess(): void {
  nvidiaCircuitState.consecutiveRetryableFailures = 0;
  nvidiaCircuitState.openUntil = 0;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getNvidiaApiKey() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing AI API key in environment.");
  }
  return apiKey;
}

function getGeminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing AI API key in environment.");
  }
  return apiKey;
}

async function chatNvidia(
  model: string,
  system: string,
  user: string,
  thinkingMode: ThinkingMode,
  inputChars?: number
): Promise<string> {
  const apiKey = getNvidiaApiKey();
  const heavyMode = thinkingMode === "extended" || thinkingMode === "deep";
  const timeoutMs = getAdaptiveTimeoutMs(thinkingMode, inputChars ?? user.length);
  const startedAt = Date.now();
  const request: Record<string, unknown> = {
    model,
    stream: false,
    temperature: heavyMode ? 0.2 : 0.3,
    max_tokens: MAX_OUTPUT_TOKENS_BY_MODE[thinkingMode],
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  if (heavyMode) {
    request.extra_body = {
      chat_template_kwargs: { enable_thinking: true },
      top_k: 20,
      repetition_penalty: 1
    };
  }

  const response = await fetchWithTimeout(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(request)
    },
    timeoutMs,
    `AI request timed out in ${thinkingMode} mode. ${getTimeoutGuidance(thinkingMode)}`
  );

  const raw = await response.text();
  let data:
    | {
        error?: { message?: string } | string;
        detail?: string;
        message?: string;
        title?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        choices?: Array<{ message?: { content?: string | null } }>;
      }
    | undefined;
  try {
    data = JSON.parse(raw) as {
      error?: { message?: string } | string;
      detail?: string;
      message?: string;
      title?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{ message?: { content?: string | null } }>;
    };
  } catch {
    if (!response.ok) {
      throw new Error(`AI request failed (${response.status}). Please try again.`);
    }
  }

  if (!response.ok) {
    console.info(
      `[llm] provider=nvidia model=${model} durationMs=${Date.now() - startedAt} status=${response.status} tokens=unknown`
    );
    const responseMessage =
      typeof data?.error === "string"
        ? data.error
        : data?.error?.message || data?.detail || data?.message || data?.title || "";
    const normalizedMessage = responseMessage.toLowerCase();
    if (normalizedMessage.includes("degraded function cannot be invoked")) {
      throw new Error(
        "AI provider is temporarily unavailable. Please try again shortly."
      );
    }
    const errorMessage = sanitizeProviderReferences(
      responseMessage || `AI request failed (${response.status}).`
    );
    throw new Error(errorMessage);
  }

  logModelCall({
    provider: "nvidia",
    model,
    durationMs: Date.now() - startedAt,
    usage: {
      promptTokens: data?.usage?.prompt_tokens,
      completionTokens: data?.usage?.completion_tokens,
      totalTokens: data?.usage?.total_tokens
    }
  });

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function chatGemini(
  model: string,
  system: string,
  user: string,
  thinkingMode: ThinkingMode,
  inputChars?: number
): Promise<string> {
  const heavyMode = thinkingMode === "extended" || thinkingMode === "deep";
  const timeoutMs = getAdaptiveTimeoutMs(thinkingMode, inputChars ?? user.length);
  const apiKey = getGeminiApiKey();
  const startedAt = Date.now();
  const ai = new GoogleGenAI({ apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: user,
      config: {
        abortSignal: controller.signal,
        systemInstruction: system,
        temperature: heavyMode ? 0.2 : 0.3,
        maxOutputTokens: MAX_OUTPUT_TOKENS_BY_MODE[thinkingMode]
      }
    });
  } catch (error) {
    console.info(
      `[llm] provider=gemini model=${model} durationMs=${Date.now() - startedAt} tokens=unknown`
    );
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new Error(`AI request timed out in ${thinkingMode} mode. ${getTimeoutGuidance(thinkingMode)}`);
      }
      throw new Error(sanitizeProviderReferences(error.message));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  logModelCall({
    provider: "gemini",
    model,
    durationMs: Date.now() - startedAt,
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount
    }
  });

  return response.text?.trim() || "";
}

async function chat(
  provider: Provider,
  model: string,
  system: string,
  user: string,
  thinkingMode: ThinkingMode,
  inputChars?: number
): Promise<string> {
  if (provider === "gemini") {
    if (!hasGeminiApiKey() && hasNvidiaApiKey()) {
      return chatNvidia(
        getNvidiaFallbackModel(),
        system,
        user,
        thinkingMode,
        inputChars
      );
    }

    try {
      return await chatGemini(model, system, user, thinkingMode, inputChars);
    } catch (primaryError) {
      const isRetryable =
        primaryError instanceof Error &&
        (isRetryablePrimaryError(primaryError) ||
          primaryError.message === "Missing AI API key in environment.");

      if (!isRetryable || !hasNvidiaApiKey()) {
        throw primaryError;
      }

      return chatNvidia(
        getNvidiaFallbackModel(),
        system,
        user,
        thinkingMode,
        inputChars
      );
    }
  }

  if (isNvidiaCircuitOpen() && hasGeminiApiKey()) {
    return chatGemini(getGeminiFallbackModel(), system, user, thinkingMode, inputChars);
  }

  try {
    const result = await chatNvidia(model, system, user, thinkingMode, inputChars);
    recordNvidiaSuccess();
    return result;
  } catch (primaryError) {
    const isRetryable = isRetryablePrimaryError(primaryError);
    if (isRetryable) {
      recordNvidiaRetryableFailure();
    }
    const shouldTryFallback = hasGeminiApiKey() && isRetryable;

    if (!shouldTryFallback) {
      throw primaryError;
    }

    try {
      return await chatGemini(
        getGeminiFallbackModel(),
        system,
        user,
        thinkingMode,
        inputChars
      );
    } catch (fallbackError) {
      if (fallbackError instanceof Error) {
        throw new Error(sanitizeProviderReferences(fallbackError.message));
      }
      throw fallbackError;
    }
  }
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore and try fenced/raw extraction below.
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const jsonSlice = raw.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonSlice) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function readStringMapFromJson(
  raw: string,
  keys: string[],
  errorPrefix: string
): Record<string, string> {
  const parsed = tryParseJsonObject(raw);
  if (!parsed) {
    throw new Error(`${errorPrefix}: model did not return valid JSON.`);
  }

  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value !== "string") {
      throw new Error(`${errorPrefix}: missing string value for key "${key}".`);
    }
    out[key] = value;
  }
  return out;
}

export async function runBatchTranslationFast(input: BatchTranslateInput): Promise<Record<string, string>> {
  if (input.items.length === 0) {
    return {};
  }

  const baseContext = input.context?.trim() ? `Context: ${input.context.trim()}\n\n` : "";
  const payload = input.items.reduce<Record<string, string>>((acc, item) => {
    acc[item.key] = item.text;
    return acc;
  }, {});

  const raw = await chat(
    input.provider,
    input.model,
    `You are a professional localization translator from ${input.sourceLang} to ${input.targetLang}.`,
    `${baseContext}Translate all values in this JSON object from ${input.sourceLang} to ${input.targetLang}.
Rules:
- Keep keys unchanged.
- Return strict JSON object only.
- Do not add or remove keys.
- Translate values only.

JSON:
${JSON.stringify(payload)}`,
    input.thinkingMode
  );

  const parsed = tryParseJsonObject(raw);
  if (!parsed) {
    throw new Error("Fast JSON batch translation failed: model did not return valid JSON.");
  }

  const translated: Record<string, string> = {};
  for (const item of input.items) {
    const value = parsed[item.key];
    translated[item.key] = typeof value === "string" ? value : item.text;
  }
  return translated;
}

export async function runBatchTranslationQuality(input: BatchTranslateInput): Promise<BatchPipelineRow[]> {
  if (input.items.length === 0) {
    return [];
  }

  const baseContext = input.context?.trim() ? `Context: ${input.context.trim()}\n\n` : "";
  const payload = input.items.reduce<Record<string, string>>((acc, item) => {
    acc[item.key] = item.text;
    return acc;
  }, {});
  const keys = input.items.map((item) => item.key);

  const initialRaw = await chat(
    input.provider,
    input.model,
    `You are a professional localization translator from ${input.sourceLang} to ${input.targetLang}.`,
    `${baseContext}Translate all values in this JSON object from ${input.sourceLang} to ${input.targetLang}.
Rules:
- Keep keys unchanged.
- Return strict JSON object only.
- Do not add or remove keys.
- Translate values only.

JSON:
${JSON.stringify(payload)}`,
    input.thinkingMode
  );
  const initial = readStringMapFromJson(initialRaw, keys, "Quality JSON initial step failed");

  const critiqueRaw = await chat(
    input.provider,
    input.model,
    `You are a senior localization reviewer for ${input.targetLang}.`,
    `${baseContext}Review each translation in this JSON object.
Return strict JSON object only where each key maps to concise critique bullet points as a single string.
Rules:
- Keep keys unchanged.
- Do not add or remove keys.
- Focus on meaning accuracy, grammar, context, UI suitability, and tone consistency.

SOURCE JSON:
${JSON.stringify(payload)}

TRANSLATION JSON:
${JSON.stringify(initial)}`,
    input.thinkingMode
  );
  const critique = readStringMapFromJson(critiqueRaw, keys, "Quality JSON critique step failed");

  const improvedRaw = await chat(
    input.provider,
    input.model,
    `You are a professional translation editor from ${input.sourceLang} to ${input.targetLang}.`,
    `${baseContext}Improve each translation using its critique.
Return strict JSON object only with the final improved translation for each key.
Rules:
- Keep keys unchanged.
- Do not add or remove keys.
- Return translation values only.

SOURCE JSON:
${JSON.stringify(payload)}

INITIAL JSON:
${JSON.stringify(initial)}

CRITIQUE JSON:
${JSON.stringify(critique)}`,
    input.thinkingMode
  );
  const improved = readStringMapFromJson(improvedRaw, keys, "Quality JSON improve step failed");

  return keys.map((key) => ({
    key,
    initial: initial[key],
    critique: critique[key],
    improved: improved[key]
  }));
}

export async function runTranslationPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const baseContext = input.context?.trim() ? `Context: ${input.context.trim()}\n\n` : "";
  const inputChars = input.text.length;

  const initialTranslation = await chat(
    input.provider,
    input.model,
    `You are a professional translator from ${input.sourceLang} to ${input.targetLang}. Return only translation.`,
    `${baseContext}Translate the following text.\n\n${input.sourceLang}: ${input.text}\n\n${input.targetLang}:`,
    input.thinkingMode,
    inputChars
  );

  const critique = await chat(
    input.provider,
    input.model,
    `You are a senior localization reviewer for ${input.targetLang}.`,
    `${baseContext}Review the translation quality for grammar, meaning accuracy, context correctness, UI suitability, and tone consistency.\nReturn concise, actionable bullet points only.\n\nSOURCE:\n${input.text}\n\nTRANSLATION:\n${initialTranslation}`,
    input.thinkingMode,
    inputChars
  );

  const improvedTranslation = await chat(
    input.provider,
    input.model,
    `You are a professional translation editor from ${input.sourceLang} to ${input.targetLang}.`,
    `${baseContext}Improve the translation using the critique. Return only the final improved translation.\n\nSOURCE:\n${input.text}\n\nINITIAL:\n${initialTranslation}\n\nCRITIQUE:\n${critique}`,
    input.thinkingMode,
    inputChars
  );

  return { initialTranslation, critique, improvedTranslation };
}
