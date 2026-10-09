/**
 * @fileoverview Model access for the agent.
 *
 * - Gemini (default): JSON-mode generation, backoff on 429/5xx, and automatic
 *   fail-over across free-tier models when one is overloaded or out of quota.
 * - Fixture mode (AGENT_FIXTURE_DIR): replays attempt-1.json, attempt-2.json, ...
 *   so the whole pipeline can be exercised offline and in tests.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_RETRIES_PER_MODEL = 2; // then fail over to the next model
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

/**
 * Free-tier models tried in order after the preferred one. When a model is
 * overloaded (503), missing (404) or out of daily quota, the agent moves on to
 * the next one instead of failing the night.
 */
export const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

/** "a, b,,a" -> ['a', 'b']; preferred models first, defaults appended, no duplicates. */
export function resolveModelList(preferred, defaults = DEFAULT_FALLBACK_MODELS) {
  const fromEnv = String(preferred || '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => /^[a-z0-9][a-z0-9.\-]{2,63}$/i.test(m));
  return [...new Set([...fromEnv, ...defaults])];
}

const REQUEST_TIMEOUT_MS = 180_000;

async function callGemini(apiKey, modelName, prompt) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel(
    { model: modelName, generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/**
 * @param {Object} opts
 * @param {string} [opts.apiKey]
 * @param {string[]} [opts.modelNames] - tried in order; the first that works is reused.
 * @param {string} [opts.fixtureDir] - offline replay mode
 * @param {Function} [opts.callModel] - (modelName, prompt) => text; injectable for tests
 * @param {number} [opts.maxRetries] - retries per model for transient errors
 * @param {Function} [opts.sleepFn]
 */
export function createModel({
  apiKey,
  modelNames = DEFAULT_FALLBACK_MODELS,
  fixtureDir,
  callModel,
  maxRetries = MAX_RETRIES_PER_MODEL,
  sleepFn = sleep,
}) {
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

  if (!callModel && !apiKey) throw new ModelUnavailableError('GEMINI_API_KEY is not set.');
  if (!modelNames.length) throw new ModelUnavailableError('No Gemini models configured.');
  const call = callModel || ((name, prompt) => callGemini(apiKey, name, prompt));

  let current = 0; // sticky: once a model works, later attempts start from it

  async function tryModel(name, prompt) {
    let delay = INITIAL_BACKOFF_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call(name, prompt);
      } catch (error) {
        const msg = String((error && error.message) || error).slice(0, 300);
        if (isDailyQuotaError(error)) throw new ModelUnavailableError(`${name}: daily quota exhausted`);
        if (!isRetryable(error) || attempt >= maxRetries) throw new ModelUnavailableError(`${name}: ${msg}`);
        const wait = retryDelayMs(error, delay);
        console.warn(`[agent] ${name} busy/rate-limited; retry ${attempt + 1}/${maxRetries} in ${wait}ms`);
        await sleepFn(wait);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  return {
    get name() {
      return modelNames[current];
    },
    async generate(prompt) {
      const failures = [];
      for (let i = current; i < modelNames.length; i += 1) {
        try {
          const text = await tryModel(modelNames[i], prompt);
          if (i !== current) console.warn(`[agent] switched to fallback model ${modelNames[i]}`);
          current = i;
          return text;
        } catch (error) {
          failures.push(error.message);
          console.warn(`[agent] model unavailable -> ${error.message}`);
        }
      }
      throw new ModelUnavailableError(`All Gemini models failed: ${failures.join(' | ')}`);
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
