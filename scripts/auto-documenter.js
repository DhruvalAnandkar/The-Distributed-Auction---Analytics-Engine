'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const ROOT_DIR = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT_DIR, 'apps', 'api');
const MODEL_NAME = 'gemini-3.8-flash';
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const PROMPT =
  'You are an expert enterprise backend engineer. Add professional JSDoc comments to all functions, classes, and complex logic in this code. Return ONLY the raw code, without any markdown formatting, backticks, or explanations.';

function collectJsFiles(directory, files = []) {
  let entries;

  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const fullPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      collectJsFiles(fullPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

function isInsideNodeModules(filePath) {
  return filePath.split(path.sep).includes('node_modules');
}

function stripMarkdownFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:javascript|js)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) {
    return fenced[1];
  }

  return trimmed.replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```$/i, '');
}

function toPosixPath(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isServiceUnavailable(error) {
  const status = error && (error.status || error.statusCode);
  const message = String((error && error.message) || '');
  const statusText = String((error && error.statusText) || '');

  return (
    status === 503 ||
    /503/.test(message) ||
    /service unavailable/i.test(message) ||
    /service unavailable/i.test(statusText)
  );
}

async function generateContentWithBackoff(model, prompt) {
  let delayMs = INITIAL_BACKOFF_MS;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      lastError = error;

      if (!isServiceUnavailable(error) || attempt === MAX_RETRIES) {
        break;
      }

      console.warn(
        `Gemini returned 503 Service Unavailable. Waiting ${delayMs}ms before retry ${attempt + 1}/${MAX_RETRIES}...`
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }

  if (isServiceUnavailable(lastError)) {
    console.error('Gemini generateContent failed after maximum retries:', lastError);
    process.exit(0);
  }

  throw lastError;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const undocumentedFiles = collectJsFiles(API_DIR).filter((filePath) => {
    if (isInsideNodeModules(filePath)) {
      return false;
    }

    const contents = fs.readFileSync(filePath, 'utf8');
    return !contents.includes('/**');
  });

  if (undocumentedFiles.length === 0) {
    console.log('No undocumented JavaScript files found.');
    return;
  }

  const selectedFile = undocumentedFiles[Math.floor(Math.random() * undocumentedFiles.length)];
  const originalSource = fs.readFileSync(selectedFile, 'utf8');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });
  const result = await generateContentWithBackoff(
    model,
    `${PROMPT}\n\n${originalSource}`
  );
  const documentedSource = stripMarkdownFences(result.response.text());

  if (!documentedSource.trim()) {
    throw new Error(`Gemini returned an empty response for ${toPosixPath(selectedFile)}`);
  }

  const output = documentedSource.endsWith('\n') ? documentedSource : `${documentedSource}\n`;
  fs.writeFileSync(selectedFile, output, 'utf8');

  console.log(toPosixPath(selectedFile));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
