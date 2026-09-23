const fs = require('fs');
const path = require('path');
const { resolveApiKey } = require('./secret-crypto');

const CONFIG_PATH = path.join(__dirname, 'ai-config.json');

const DEFAULT_PROMPT_TEMPLATE =
  'You are a QA assistant summarizing automated website testing results for a ' +
  'non-technical stakeholder. Write a short, plain-language summary (3-6 sentences ' +
  'or a short bullet list) of the {reportType} results below. Call out the most ' +
  'important findings, any risks, and anything that looks like it needs action. ' +
  "Don't restate raw numbers that are already obvious from the data — interpret them.\n\n" +
  'Results:\n{data}';

// Used for the per-page "assess these recommendations" forecast triggered
// from the page-score details popup — a distinct prompt from the phase
// -level summary above, but built and sent through the exact same
// provider/retry/fallback machinery (see generatePageForecast below).
const DEFAULT_PAGE_FORECAST_TEMPLATE =
  "You are a web performance consultant reviewing a single page's Google " +
  'Lighthouse results. Using the current scores, Core Web Vitals, and ' +
  'improvement recommendations below, write a short, plain-language ' +
  'assessment covering: (1) a forecasted Lighthouse score if the listed ' +
  'recommendations were implemented, (2) the improvement as a percentage ' +
  'over the current score, and (3) which one or two fixes would likely ' +
  'have the biggest impact. Keep it brief — a short paragraph or a few ' +
  'bullet points. Cover mobile and desktop separately only if their ' +
  'situations meaningfully differ.\n\n' +
  'Current {reportType} data:\n{data}';

// Retry policy for a single provider: 1 initial attempt + this many retries,
// waiting this long between each — but only for TRANSIENT errors (see
// TRANSIENT_STATUSES below). A permanent error (bad API key, malformed
// request) fails immediately without burning retries, since retrying it
// would never succeed.
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Carries enough detail for callers to decide whether retrying makes sense
 * (`transient`), show a clean message to the person (`message`), and still
 * log the full provider response for debugging (`raw`).
 */
class ProviderError extends Error {
  constructor(message, { status = null, raw = null, transient = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.raw = raw || message;
    this.transient = transient;
  }
}

function friendlyProviderError(providerLabel, status) {
  if (status === 429) return `${providerLabel} is rate-limiting requests right now (too many requests in a short time)`;
  if (status && TRANSIENT_STATUSES.has(status)) return `${providerLabel} is temporarily unavailable or experiencing high demand`;
  if (status === 401 || status === 403) return `${providerLabel} rejected the request — check that the API key is valid`;
  if (status === 404) return `${providerLabel} returned "not found" — check the configured model name`;
  if (status === 400) return `${providerLabel} rejected the request as malformed — check the configuration`;
  if (status) return `${providerLabel} returned an unexpected error (HTTP ${status})`;
  return `Could not reach ${providerLabel} — check your network connection`;
}

/**
 * fetch() with a hard timeout — without this, a hung request would never
 * reject, so the retry/fallback logic below would never get a chance to run.
 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (networkErr) {
    const timedOut = networkErr && networkErr.name === 'AbortError';
    throw new ProviderError(
      timedOut ? 'the request timed out' : (networkErr && networkErr.message) || 'network error',
      { raw: (networkErr && networkErr.message) || String(networkErr), transient: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProviderConfig(raw, label) {
  if (!raw || !raw.provider || !raw.apiKey) return null;
  let apiKey;
  try {
    apiKey = resolveApiKey(raw.apiKey);
  } catch (e) {
    console.error(`[ai-summary] ${label || raw.provider} API key could not be resolved:`, e.message);
    return null;
  }
  return { provider: raw.provider, apiKey, model: raw.model };
}

function describeProvider(cfg, isFallback) {
  const label = { gemini: 'Gemini', cohere: 'Cohere', openai: 'OpenAI' }[cfg.provider] || cfg.provider;
  return isFallback ? `${label} (fallback)` : label;
}

/**
 * Reads ai-config.json from the project root. Returns null (not a throw) if
 * the file is missing or incomplete — AI summaries are an optional feature,
 * the app should keep working normally without this configured.
 *
 * Supports two shapes:
 *   New:  { "primary": { "provider", "apiKey", "model" }, "fallback": {...}, "promptTemplate" }
 *   Old:  { "provider", "apiKey", "model", "promptTemplate" }  (treated as primary-only, no fallback)
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    let primary = null;
    if (parsed.primary) {
      primary = normalizeProviderConfig(parsed.primary, 'primary');
    } else if (parsed.provider && parsed.apiKey) {
      primary = normalizeProviderConfig(parsed, 'primary');
    }
    if (!primary) return null;

    const fallback = parsed.fallback ? normalizeProviderConfig(parsed.fallback, 'fallback') : null;

    return { primary, fallback, promptTemplate: parsed.promptTemplate, pageForecastPromptTemplate: parsed.pageForecastPromptTemplate };
  } catch (e) {
    console.error('[ai-summary] failed to read/parse ai-config.json:', e.message);
    return null;
  }
}

function isConfigured() {
  return loadConfig() !== null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Converts the AI provider's markdown-flavored output (bold, bullet/numbered
 * lists, paragraphs) into safe, styled HTML — so the summary renders as rich
 * text (bold text, real <ul>/<li> lists) instead of showing literal
 * "**text**" or "- item" characters in the UI or PDF report. Deliberately a
 * small hand-rolled converter (not a full markdown library) since the AI's
 * output only ever uses a handful of constructs (bold, simple lists,
 * paragraphs) — this is plenty and keeps the dependency footprint at zero.
 */
function markdownToHtml(text) {
  if (!text) return '';
  const escaped = escapeHtml(text.trim());

  // Bold (**text**) first, then italics (*text*) — order matters so italics
  // doesn't accidentally eat one side of a bold pair.
  let withInline = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  withInline = withInline.replace(/(^|[^*])\*(?!\*)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');

  const lines = withInline.split(/\r?\n/);
  let html = '';
  let inList = false;
  let listType = null;
  const paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length) {
      html += `<p>${paragraphBuffer.join(' ')}</p>`;
      paragraphBuffer.length = 0;
    }
  }
  function closeList() {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = null;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }
    const bulletMatch = line.match(/^[-*•]\s+(.*)/);
    const numberMatch = line.match(/^\d+[.)]\s+(.*)/);
    if (bulletMatch) {
      flushParagraph();
      if (!inList || listType !== 'ul') {
        closeList();
        html += '<ul>';
        inList = true;
        listType = 'ul';
      }
      html += `<li>${bulletMatch[1]}</li>`;
    } else if (numberMatch) {
      flushParagraph();
      if (!inList || listType !== 'ol') {
        closeList();
        html += '<ol>';
        inList = true;
        listType = 'ol';
      }
      html += `<li>${numberMatch[1]}</li>`;
    } else {
      closeList();
      paragraphBuffer.push(line);
    }
  }
  flushParagraph();
  closeList();
  return html || `<p>${escaped}</p>`;
}

/**
 * Strips the same markdown constructs down to clean plain text — used for
 * CSV exports, where HTML tags aren't meaningful and "**Risk:**" reading as
 * literal asterisks looks broken.
 */
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\*)([^*]+?)\*(?!\*)/g, '$1$2')
    .replace(/^[ \t]*[-*•]\s+/gm, '- ')
    .replace(/^[ \t]*(\d+)[.)]\s+/gm, '$1. ')
    .trim();
}

function buildPrompt(template, reportType, dataText) {
  return template.replace(/\{reportType\}/g, reportType).replace(/\{data\}/g, dataText);
}

async function callGemini(config, prompt) {
  const model = config.model || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new ProviderError(friendlyProviderError('Gemini', res.status), {
      status: res.status,
      raw: `Gemini API error (HTTP ${res.status}): ${bodyText.slice(0, 500)}`,
      transient: TRANSIENT_STATUSES.has(res.status),
    });
  }
  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!text) {
    throw new ProviderError('Gemini returned no summary text (the response may have been blocked or empty)', {
      raw: JSON.stringify(data).slice(0, 500),
      transient: false,
    });
  }
  return text.trim();
}

async function callCohere(config, prompt) {
  const model = config.model || 'command-r';
  const res = await fetchWithTimeout('https://api.cohere.ai/v1/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model, message: prompt }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new ProviderError(friendlyProviderError('Cohere', res.status), {
      status: res.status,
      raw: `Cohere API error (HTTP ${res.status}): ${bodyText.slice(0, 500)}`,
      transient: TRANSIENT_STATUSES.has(res.status),
    });
  }
  const data = await res.json();
  const text = data && data.text;
  if (!text) {
    throw new ProviderError('Cohere returned no summary text', { raw: JSON.stringify(data).slice(0, 500), transient: false });
  }
  return text.trim();
}

async function callOpenAI(config, prompt) {
  const model = config.model || 'gpt-4o-mini';
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new ProviderError(friendlyProviderError('OpenAI', res.status), {
      status: res.status,
      raw: `OpenAI API error (HTTP ${res.status}): ${bodyText.slice(0, 500)}`,
      transient: TRANSIENT_STATUSES.has(res.status),
    });
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) {
    throw new ProviderError('OpenAI returned no summary text', { raw: JSON.stringify(data).slice(0, 500), transient: false });
  }
  return text.trim();
}

function callProvider(config, prompt) {
  if (config.provider === 'gemini') return callGemini(config, prompt);
  if (config.provider === 'cohere') return callCohere(config, prompt);
  if (config.provider === 'openai') return callOpenAI(config, prompt);
  throw new ProviderError(`Unknown AI provider "${config.provider}" — use "gemini", "cohere", or "openai"`, { transient: false });
}

/**
 * Calls one provider, retrying up to MAX_RETRIES times (waiting
 * RETRY_DELAY_MS between attempts) — but ONLY when the failure is transient
 * (rate limit, temporary outage, timeout/network blip). A permanent failure
 * (bad key, malformed request, unknown model) fails on the first attempt
 * instead of wasting time retrying something that will never succeed.
 */
async function attemptProvider(config, prompt, label) {
  const maxAttempts = 1 + MAX_RETRIES;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await callProvider(config, prompt);
      return text;
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === maxAttempts;
      if (!err.transient || isLastAttempt) {
        console.error(`[ai-summary] ${label} failed (attempt ${attempt}/${maxAttempts}, not retrying):`, err.raw || err.message);
        throw err;
      }
      console.warn(`[ai-summary] ${label} failed (attempt ${attempt}/${maxAttempts}) — retrying in ${RETRY_DELAY_MS / 1000}s: ${err.message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/**
 * Runs the primary-then-fallback provider chain (each with its own retry
 * policy) against an already-built prompt. Shared by generateAiSummary and
 * generatePageForecast below, so both features get identical retry/fallback
 * behavior and error handling from one place. Returns
 * { text, provider, usedFallback }; throws a friendly, human-readable
 * ProviderError (full raw detail logged to the console) if every configured
 * provider fails.
 */
async function runProviderChain(config, prompt) {
  const attempts = [{ cfg: config.primary, label: describeProvider(config.primary, false) }];
  if (config.fallback) attempts.push({ cfg: config.fallback, label: describeProvider(config.fallback, true) });

  let lastErr;
  for (const { cfg, label } of attempts) {
    try {
      const text = await attemptProvider(cfg, prompt, label);
      return { text, provider: cfg.provider, usedFallback: cfg === config.fallback };
    } catch (err) {
      lastErr = err;
    }
  }

  const hasFallbackConfigured = attempts.length > 1;
  const friendly = hasFallbackConfigured
    ? `All configured AI providers failed. Last attempt (${attempts[attempts.length - 1].label}): ${lastErr.message}.`
    : `${lastErr.message}. Consider configuring a fallback provider in ai-config.json.`;
  throw new ProviderError(friendly, { transient: lastErr.transient, raw: lastErr.raw });
}

/**
 * Builds a prompt from `dataObject` using the given template (capping the
 * JSON payload so an enormous page/result list doesn't blow past what's
 * reasonable to send), then runs it through the full provider chain.
 */
async function generateWithTemplate(reportType, dataObject, template) {
  const dataText = JSON.stringify(dataObject, null, 2);
  // Cap payload size — don't send enormous page lists to the AI, a
  // reasonable informative slice is plenty for a summary.
  const cappedDataText = dataText.length > 12000 ? dataText.slice(0, 12000) + '\n... (truncated)' : dataText;
  const prompt = buildPrompt(template, reportType, cappedDataText);
  return runProviderChain(loadConfig(), prompt);
}

/**
 * Generates an AI summary of `dataObject` for the given `reportType` label,
 * using the configured `promptTemplate` (or the built-in default). Tries
 * the primary provider first; if it exhausts its retries or fails
 * permanently, falls back to the configured fallback provider before giving
 * up. Returns { text, provider, usedFallback }. Throws a friendly error if
 * nothing is configured, or if every configured provider fails.
 */
async function generateAiSummary(reportType, dataObject) {
  const config = loadConfig();
  if (!config) {
    throw new ProviderError(
      'AI summary is not configured — create ai-config.json in the project root (see ai-config.example.json) with a "primary" provider and API key.',
      { transient: false }
    );
  }
  return generateWithTemplate(reportType, dataObject, config.promptTemplate || DEFAULT_PROMPT_TEMPLATE);
}

/**
 * Generates a per-page "if these recommendations were implemented" score
 * forecast, using the configured `pageForecastPromptTemplate` (or the
 * built-in default) — a distinct prompt from the phase-level summary above,
 * but run through the exact same primary/fallback provider chain and retry
 * policy. `dataObject` is expected to carry the page's current scores,
 * Core Web Vitals, and recommendations (built by the caller from stored
 * Lighthouse results). Returns { text, provider, usedFallback }; throws a
 * friendly error under the same conditions as generateAiSummary.
 */
async function generatePageForecast(reportType, dataObject) {
  const config = loadConfig();
  if (!config) {
    throw new ProviderError(
      'AI summary is not configured — create ai-config.json in the project root (see ai-config.example.json) with a "primary" provider and API key.',
      { transient: false }
    );
  }
  return generateWithTemplate(reportType, dataObject, config.pageForecastPromptTemplate || DEFAULT_PAGE_FORECAST_TEMPLATE);
}

module.exports = { generateAiSummary, generatePageForecast, loadConfig, isConfigured, markdownToHtml, stripMarkdown, ProviderError };
