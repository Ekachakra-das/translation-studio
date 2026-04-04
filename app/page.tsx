"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

type Mode = "text" | "json";
type JsonQualityMode = "fast" | "quality" | "precise";
const DEFAULT_PROVIDER: "nvidia" | "gemini" =
  process.env.NEXT_PUBLIC_DEFAULT_PROVIDER === "gemini" ? "gemini" : "nvidia";
const LEGACY_DEFAULT_MODEL = process.env.NEXT_PUBLIC_DEFAULT_MODEL?.trim() || "";
const DEFAULT_NVIDIA_MODEL =
  process.env.NEXT_PUBLIC_NVIDIA_MODEL?.trim() ||
  LEGACY_DEFAULT_MODEL ||
  "qwen/qwen3.5-122b-a10b";
const DEFAULT_GEMINI_MODEL =
  process.env.NEXT_PUBLIC_GEMINI_MODEL?.trim() ||
  LEGACY_DEFAULT_MODEL ||
  "gemini-2.5-flash";
const DEFAULT_MODEL =
  DEFAULT_PROVIDER === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_NVIDIA_MODEL;
const THINKING_LABELS = {
  standard: "Standard",
  extended: "Think More"
} as const;
const JSON_QUALITY_LABELS: Record<JsonQualityMode, string> = {
  fast: "Fast",
  quality: "Quality",
  precise: "Precise"
};
type ThinkingMode = keyof typeof THINKING_LABELS;
const MANUAL_CONTEXT_VALUE = "__manual__";
const CONTEXT_OPTIONS = [
  "Literary / Philosophical",
  "General",
  "UI / Product",
  "Marketing",
  "Technical Documentation",
  "Legal",
  "E-commerce",
  "Customer Support",
  "Social Media",
  "Blog / Editorial",
  "Academic"
] as const;
type ContextPreset = (typeof CONTEXT_OPTIONS)[number] | typeof MANUAL_CONTEXT_VALUE;

type TextResponse = {
  initialTranslation: string;
  critique: string;
  improvedTranslation: string;
};

type JsonRow = {
  key: string;
  original: string;
  initial: string;
  critique: string;
  improved: string;
};

type JsonResponse = {
  table: JsonRow[];
  translatedJson: Record<string, unknown>;
};

const SETTINGS_STORAGE_KEY = "translation-improver-settings-v1";

type PersistedSettings = {
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  contextPreset: ContextPreset;
  customContext: string;
  thinkingMode: ThinkingMode;
  jsonQualityMode: JsonQualityMode;
};

function isThinkingMode(value: unknown): value is ThinkingMode {
  return value === "standard" || value === "extended";
}

function isContextPreset(value: unknown): value is ContextPreset {
  return (
    value === MANUAL_CONTEXT_VALUE ||
    CONTEXT_OPTIONS.includes(value as (typeof CONTEXT_OPTIONS)[number])
  );
}

function isJsonQualityMode(value: unknown): value is JsonQualityMode {
  return value === "fast" || value === "quality" || value === "precise";
}

function getNextJsonQualityMode(current: JsonQualityMode): JsonQualityMode {
  if (current === "fast") return "quality";
  if (current === "quality") return "precise";
  return "fast";
}

export default function HomePage() {
  const [mode, setMode] = useState<Mode>("text");
  const [sourceLang, setSourceLang] = useState("English");
  const [targetLang, setTargetLang] = useState("Russian");
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("standard");
  const [jsonQualityMode, setJsonQualityMode] = useState<JsonQualityMode>("fast");
  const [contextPreset, setContextPreset] = useState<ContextPreset>(CONTEXT_OPTIONS[0]);
  const [customContext, setCustomContext] = useState("");
  const [textInput, setTextInput] = useState("");
  const [jsonInput, setJsonInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [textResult, setTextResult] = useState<TextResponse | null>(null);
  const [jsonResult, setJsonResult] = useState<JsonResponse | null>(null);
  const [copyState, setCopyState] = useState("Copy to Clipboard");
  const [jsonCopyState, setJsonCopyState] = useState("Copy JSON");
  const [jsonDownloadClicked, setJsonDownloadClicked] = useState(false);
  const [jsonCopyClicked, setJsonCopyClicked] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const settingsRestoredRef = useRef(false);

  const translatedJsonString = useMemo(() => {
    if (!jsonResult) {
      return "";
    }
    return JSON.stringify(jsonResult.translatedJson, null, 2);
  }, [jsonResult]);

  const context = useMemo(() => {
    if (contextPreset === MANUAL_CONTEXT_VALUE) {
      return customContext.trim();
    }
    return contextPreset;
  }, [contextPreset, customContext]);

  const isTranslateDisabled = useMemo(() => {
    if (loading) {
      return true;
    }
    if (mode === "text") {
      return textInput.trim().length === 0;
    }
    return jsonInput.trim().length === 0;
  }, [loading, mode, textInput, jsonInput]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) {
        settingsRestoredRef.current = true;
        return;
      }

      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      const savedMode =
        parsed.mode === "json" || parsed.mode === "text" ? parsed.mode : "text";

      setMode(savedMode);
      if (typeof parsed.sourceLang === "string") setSourceLang(parsed.sourceLang);
      if (typeof parsed.targetLang === "string") setTargetLang(parsed.targetLang);
      if (isThinkingMode(parsed.thinkingMode)) {
        setThinkingMode(parsed.thinkingMode);
      }
      if (isJsonQualityMode(parsed.jsonQualityMode)) {
        setJsonQualityMode(parsed.jsonQualityMode);
      }
      if (isContextPreset(parsed.contextPreset)) {
        setContextPreset(parsed.contextPreset);
      }
      if (typeof parsed.customContext === "string") {
        setCustomContext(parsed.customContext);
      }
      // Backward compatibility for old localStorage payloads.
      if (typeof (parsed as { context?: string }).context === "string") {
        const legacyContext = (parsed as { context?: string }).context || "";
        if (isContextPreset(legacyContext) && legacyContext !== MANUAL_CONTEXT_VALUE) {
          setContextPreset(legacyContext);
          setCustomContext("");
        } else {
          setContextPreset(MANUAL_CONTEXT_VALUE);
          setCustomContext(legacyContext);
        }
      }
    } catch {
      // Ignore broken localStorage payloads and continue with defaults.
    } finally {
      settingsRestoredRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!settingsRestoredRef.current) {
      return;
    }

    const settings: PersistedSettings = {
      mode,
      sourceLang,
      targetLang,
      thinkingMode,
      jsonQualityMode,
      contextPreset,
      customContext
    };

    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore localStorage write failures (private mode / quota issues).
    }
  }, [
    mode,
    sourceLang,
    targetLang,
    thinkingMode,
    jsonQualityMode,
    contextPreset,
    customContext
  ]);

  async function parseApiResponse<T>(response: Response): Promise<T & { error?: string }> {
    const raw = await response.text();
    try {
      return JSON.parse(raw) as T & { error?: string };
    } catch {
      throw new Error(
        `API returned non-JSON response (${response.status}). ${raw.slice(0, 180)}`
      );
    }
  }

  async function handleTranslate() {
    if (mode === "text" && textInput.trim().length === 0) {
      return;
    }
    if (mode === "json" && jsonInput.trim().length === 0) {
      return;
    }

    setError("");
    setLoading(true);
    setTextResult(null);
    setJsonResult(null);
    setShowDetails(false);

    try {
      if (mode === "text") {
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            provider: DEFAULT_PROVIDER,
            model: DEFAULT_MODEL,
            thinkingMode,
            sourceLang,
            targetLang,
            context,
            text: textInput
          })
        });

        const data = await parseApiResponse<TextResponse>(response);
        if (!response.ok) {
          throw new Error(data.error || "Failed to translate text.");
        }
        setTextResult(data);
        return;
      }

      let parsedJson: Record<string, unknown>;
      try {
        parsedJson = JSON.parse(jsonInput);
      } catch {
        throw new Error("Invalid JSON input.");
      }

      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          provider: DEFAULT_PROVIDER,
          model: DEFAULT_MODEL,
          thinkingMode,
          jsonQualityMode,
          sourceLang,
          targetLang,
          context,
          json: parsedJson
        })
      });

      const data = await parseApiResponse<JsonResponse>(response);
      if (!response.ok) {
        throw new Error(data.error || "Failed to process JSON.");
      }

      setJsonResult(data);
    } catch (err) {
      if (err instanceof TypeError && err.message === "Failed to fetch") {
        setError(
          "Cannot reach /api/translate. Make sure Next dev server is running and open the same host/port shown in terminal."
        );
      } else {
        setError(err instanceof Error ? err.message : "Unexpected error");
      }
    } finally {
      setLoading(false);
    }
  }

  function handleDownloadJson() {
    if (!translatedJsonString) {
      return;
    }
    setJsonDownloadClicked(true);
    setTimeout(() => setJsonDownloadClicked(false), 260);
    const blob = new Blob([translatedJsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "translated.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopyImproved() {
    if (!textResult?.improvedTranslation) {
      return;
    }
    await navigator.clipboard.writeText(textResult.improvedTranslation);
    setCopyState("Copied!");
    setTimeout(() => setCopyState("Copy to Clipboard"), 2000);
  }

  async function handleCopyJson() {
    if (!translatedJsonString) {
      return;
    }
    setJsonCopyClicked(true);
    setTimeout(() => setJsonCopyClicked(false), 260);
    await navigator.clipboard.writeText(translatedJsonString);
    setJsonCopyState("Copied!");
    setTimeout(() => setJsonCopyState("Copy JSON"), 1800);
  }

  return (
    <main className="page-shell">
      <div className="demo-notice" role="note" aria-live="polite">
        Demo notice: This version uses free AI models. Responses may be slower, and
        temporary errors can occur.
      </div>

      <header className="page-header">
        <div className="brand-header">
          <div className="title-icon-wrap" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="28"
              height="28"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <h1 className="title">
              Translation <span className="title-brand">Studio</span>
            </h1>
            <p className="subtitle">Advanced Translation & Linguistic Improvement Engine</p>
          </div>
        </div>

        <div className="mode-toggle" role="tablist" aria-label="mode selector">
          <button
            className={mode === "text" ? "is-active" : ""}
            onClick={() => setMode("text")}
            type="button"
          >
            Text Mode
          </button>
          <button
            className={mode === "json" ? "is-active" : ""}
            onClick={() => setMode("json")}
            type="button"
          >
            JSON Mode
          </button>
        </div>
      </header>

      <section className="card-clean editor-card">
        <div className="config-grid">
          <label>
            <span>Source Language</span>
            <input value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} />
          </label>

          <label>
            <span>Target Language</span>
            <input value={targetLang} onChange={(e) => setTargetLang(e.target.value)} />
          </label>

          <label>
            <span>Context</span>
            <select
              value={contextPreset}
              onChange={(e) => setContextPreset(e.target.value as ContextPreset)}
            >
              {CONTEXT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              <option value={MANUAL_CONTEXT_VALUE}>Manual…</option>
            </select>
          </label>
        </div>

        {contextPreset === MANUAL_CONTEXT_VALUE ? (
          <label className="input-block context-manual">
            <span>Custom Context</span>
            <input
              value={customContext}
              onChange={(e) => setCustomContext(e.target.value)}
              placeholder="Type your context manually"
            />
          </label>
        ) : null}

        {mode === "text" ? (
          <label className="input-block">
            <span>Source Text</span>
            <textarea
              rows={8}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Enter text to translate..."
            />
          </label>
        ) : (
          <label className="input-block">
            <span>JSON Input</span>
            <textarea
              rows={12}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder="Paste localization JSON..."
            />
          </label>
        )}

        <div className="action-row">
          {mode === "json" ? (
            <div className={`thinking-picker ${jsonQualityMode !== "fast" ? "is-on" : ""}`}>
              <button
                type="button"
                className={`thinking-toggle ${jsonQualityMode !== "fast" ? "is-on" : ""}`}
                onClick={() =>
                  setJsonQualityMode((prev) => getNextJsonQualityMode(prev))
                }
              >
                <Icon icon="solar:tuning-square-2-outline" width="15" height="15" />
                {JSON_QUALITY_LABELS[jsonQualityMode]}
              </button>
            </div>
          ) : null}
          <div className={`thinking-picker ${thinkingMode !== "standard" ? "is-on" : ""}`}>
            <button
              type="button"
              className={`thinking-toggle ${thinkingMode !== "standard" ? "is-on" : ""}`}
              onClick={() =>
                setThinkingMode((prev) =>
                  prev === "standard" ? "extended" : "standard"
                )
              }
            >
              <Icon icon="solar:lightbulb-bolt-outline" width="15" height="15" />
              {thinkingMode === "standard" ? "Think More" : THINKING_LABELS[thinkingMode]}
            </button>
          </div>
          <button
            onClick={handleTranslate}
            disabled={isTranslateDisabled}
            className="btn-primary"
            type="button"
          >
            <span>{loading ? "Processing..." : "Translate & Improve"}</span>
            <Icon
              icon={loading ? "line-md:loading-twotone-loop" : "solar:arrow-right-line-duotone"}
              width="18"
              height="18"
            />
          </button>
        </div>

        {error ? <p className="error-line">{error}</p> : null}
      </section>

      {loading ? (
        <section className="card-clean loading-card" aria-live="polite">
          <div className="loading-head">
            <div>
              <h2>Processing...</h2>
              <p>Translating and improving your text.</p>
            </div>
          </div>

          <div className="loading-steps">
            <div className="loading-step">
              <span className="step-dot" />
              <span>Initial translation</span>
              <span className="step-bar" />
            </div>
            <div className="loading-step">
              <span className="step-dot" />
              <span>AI critique and analysis</span>
              <span className="step-bar" />
            </div>
            <div className="loading-step">
              <span className="step-dot" />
              <span>Optimized final translation</span>
              <span className="step-bar" />
            </div>
          </div>
        </section>
      ) : null}

      {mode === "text" && textResult ? (
        <div className="result-stack">
          {showDetails ? (
            <>
              <section className="card-clean result-card">
                <h2>
                  <span className="result-icon icon-initial" aria-hidden="true">
                    <Icon icon="mdi:translate" width="18" height="18" />
                  </span>
                  Initial Translation
                </h2>
                <pre>{textResult.initialTranslation}</pre>
              </section>

              <section className="card-clean result-card">
                <h2>
                  <span className="result-icon icon-critique" aria-hidden="true">
                    <Icon icon="solar:lightbulb-bolt-outline" width="18" height="18" />
                  </span>
                  AI Critique & Analysis
                </h2>
                <pre>{textResult.critique}</pre>
              </section>
            </>
          ) : null}

          <section className="card-clean optimized-card">
            <div className="optimized-topbar">
              <div className="optimized-title-wrap">
                <span className="result-icon icon-optimized status-badge-glow" aria-hidden="true">
                  <Icon icon="solar:verified-check-outline" width="18" height="18" />
                </span>
                <h3>Optimized Translation</h3>
              </div>
              <div className="result-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setShowDetails((value) => !value)}
                >
                  {showDetails ? "Hide analysis" : "View analysis"}
                </button>
                <button type="button" className="btn-ghost" onClick={handleCopyImproved}>
                  <Icon icon="solar:copy-outline" width="16" height="16" />
                  {copyState}
                </button>
              </div>
            </div>
            <div className="optimized-body">
              <p className="optimized-text">{textResult.improvedTranslation}</p>
            </div>
          </section>
        </div>
      ) : null}

      {mode === "json" && jsonResult ? (
        <div className="result-stack">
          <section className="card-clean result-card">
            <div className="result-card-head">
              <h2>Translation Table</h2>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setShowDetails((value) => !value)}
              >
                {showDetails ? "Hide analysis" : "View analysis"}
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Original</th>
                    {showDetails ? <th>Initial Translation</th> : null}
                    {showDetails ? <th>Critique</th> : null}
                    <th>Improved Translation</th>
                  </tr>
                </thead>
                <tbody>
                  {jsonResult.table.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td>{row.original}</td>
                      {showDetails ? <td className="table-cell-pre">{row.initial}</td> : null}
                      {showDetails ? <td className="table-cell-pre">{row.critique}</td> : null}
                      <td>{row.improved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card-clean result-card">
            <h2>Translated JSON</h2>
            <pre>{translatedJsonString}</pre>
            <div className="json-actions">
              <button
                type="button"
                className={`json-action-btn ${jsonDownloadClicked ? "is-clicked" : ""}`}
                onClick={handleDownloadJson}
              >
                Download JSON
              </button>
              <button
                type="button"
                className={`json-action-btn ${jsonCopyClicked ? "is-clicked" : ""}`}
                onClick={handleCopyJson}
              >
                {jsonCopyState}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <footer className="page-footer">Powered by multi-step AI translation</footer>
    </main>
  );
}
