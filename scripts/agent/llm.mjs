/**
 * @fileoverview Model access for the agent.
 *
 * - Gemini (default): JSON-mode generation with exponential backoff on 429/5xx.
 * - Fixture mode (AGENT_FIXTURE_DIR): replays attempt-1.json, attempt-2.json, ...
 *   so the whole pipeline can be exercised offline and in tests.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_BACKOFF_MS = 90_000;

/** Daily quota is gone: retrying only wastes time, so give up until tomorrow. */
export function isDailyQuotaError(error) {
  const msg = String((error && error.message) || '');
  return /PerDay|per day|daily limit/i.test(msg);
}

export function isRetryable(error) {
  if (isDailyQuotaError(error)) return false;
  const status = error && (error.status || error.statusCode);
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  const msg = String((error && error.message) || '');
  return /\b(429|500|502|503|504)\b|overloaded|unavailable|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

/** Honors the server's suggested wait (e.g. `"retryDelay":"37s"`) when present. */
export function retryDelayMs(error, fallbackMs) {
  const msg = String((error && error.message) || '');
  const m = msg.match(/retry(?:Delay)?["'\s:]*(?:in\s*)?["']?(\d+(?:\.\d+)?)\s*s/i);
  const hinted = m ? Math.ceil(Number(m[1]) * 1000) + 500 : 0;
  return Math.min(Math.max(fallbackMs, hinted), MAX_BACKOFF_MS);
}

export class ModelUnavailableError extends Error {}

export function createModel({ apiKey, modelName, fixtureDir }) {
  if (fixtureDir) {
    let call = 0;
    return {
      name: `fixture:${path.basename(fixtureDir)}`,
      async generate() {
        call += 1;
        const file = path.join(fixtureDir, `attempt-${call}.json`);
        if (!fs.existsSync(file)) throw new ModelUnavailableError(`No fixture ${file}`);
        return fs.readFileSync(file, 'utf8');
      },
    };
  }

  if (!apiKey) throw new ModelUnavailableError('GEMINI_API_KEY is not set.');

  return {
    name: modelName,
    async generate(prompt) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      });

      let delay = INITIAL_BACKOFF_MS;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await model.generateContent(prompt);
          return result.response.text();
        } catch (error) {
          if (isDailyQuotaError(error)) {
            throw new ModelUnavailableError('Gemini daily free-tier quota exhausted; will try again next run.');
          }
          if (!isRetryable(error) || attempt >= MAX_RETRIES) {
            throw new ModelUnavailableError(`Gemini call failed: ${String(error.message).slice(0, 300)}`);
          }
          const wait = retryDelayMs(error, delay);
          console.warn(`[agent] Gemini busy/rate-limited; retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
          await sleep(wait);
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
      }
    },
  };
}

/** Parses the model's JSON, tolerating markdown fences or leading prose. */
export function parseModelJson(text) {
  const trimmed = String(text || '').trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error('Model response was not valid JSON.');
  }
}
