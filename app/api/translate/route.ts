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

type FlatEntry = { key: string; value: string };

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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Payload;

    if (body.mode === "text") {
      const result = await runTranslationPipeline({
        provider: body.provider,
        model: body.model,
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
            provider: body.provider,
            model: body.model,
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
            provider: body.provider,
            model: body.model,
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
            provider: body.provider,
            model: body.model,
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
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
