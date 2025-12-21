const fs = require("fs");
const path = require("path");
const axios = require("axios");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(__dirname, "llm.config.json");

// Load config once at startup; fall back to sane defaults if missing.
let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    cachedConfig = JSON.parse(raw);
  } catch {
    cachedConfig = {
      providers: {
        localResponses: {
          type: "responses",
          label: "Local SmolLM / Responses API",
          maxTokensDefault: 4096,
        },
        openRouter: {
          type: "openrouter_chat",
          baseUrl: "https://openrouter.ai/api/v1",
          defaultTier: "fast",
          tiers: {
            fast: {
              model: "openai/gpt-4o-mini",
              maxTokens: 4096,
            },
          },
          temperature: 0.6,
          topP: 0.95,
        },
      },
      fallbackPolicy: {
        mode: "primary_local_then_openrouter",
        openRouterTier: "fast",
        triggers: {
          networkError: true,
          timeoutMs: 15000,
          http5xx: true,
          http429: true,
          http4xx: false,
          emptyOutput: true,
          malformedResponse: true,
        },
      },
    };
  }

  return cachedConfig;
}

function getProviderConfig() {
  const cfg = loadConfig();
  return cfg.providers || {};
}

function getFallbackPolicy() {
  const cfg = loadConfig();
  return cfg.fallbackPolicy || {};
}

// Local Responses API configuration from environment.
const llmBaseUrl =
  process.env.LLM_BASE_URL || "http://127.0.0.1:1234/v1";
const llmModel = process.env.LLM_MODEL || "smollm3-3b-128k";
const llmMaxTokens =
  process.env.LLM_MAX_TOKENS != null
    ? Number(process.env.LLM_MAX_TOKENS)
    : 4096;

function buildLanBaseUrl(lanHost, lanPort) {
  if (!lanHost || typeof lanHost !== "string") return null;
  const trimmed = lanHost.trim();
  if (!trimmed) return null;

  // Allow full URLs (including /v1) to be entered directly.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }

  const portInt = parseInt(lanPort, 10);
  const portPart =
    Number.isFinite(portInt) && portInt > 0 ? `:${portInt}` : "";

  // Default to /v1 like the local LLM_BASE_URL examples.
  return `http://${trimmed}${portPart}/v1`;
}

// OpenRouter environment configuration.
function getOpenRouterBaseUrl() {
  const providers = getProviderConfig();
  const openRouter = providers.openRouter || {};
  return (
    process.env.OPENROUTER_BASE_URL ||
    openRouter.baseUrl ||
    "https://openrouter.ai/api/v1"
  );
}

function getOpenRouterHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (process.env.OPENROUTER_REFERER) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
  }

  headers["X-Title"] =
    process.env.OPENROUTER_APP_NAME || "PizzaRAT Chess Coach";

  return headers;
}

function pickOpenRouterTier(tierOverride) {
  const providers = getProviderConfig();
  const openRouter = providers.openRouter || {};
  const tiers = openRouter.tiers || {};

  const tierName =
    tierOverride ||
    openRouter.defaultTier ||
    "fast";

  const tier = tiers[tierName] || {};
  const model = tier.model || "openai/gpt-4o-mini";
  const maxTokens = tier.maxTokens || 4096;

  const temperature =
    typeof openRouter.temperature === "number"
      ? openRouter.temperature
      : 0.6;
  const topP =
    typeof openRouter.topP === "number" ? openRouter.topP : 0.95;

  return {
    tierName,
    model,
    maxTokens,
    temperature,
    topP,
  };
}

function normalizeReasoningEffort(raw) {
  if (!raw || typeof raw !== "string") return null;
  const value = raw.toLowerCase();
  if (value === "none" || value === "off") return null;
  if (value === "low") return "low";
  if (value === "mid" || value === "medium") return "medium";
  if (value === "high") return "high";
  return null;
}

// Helper used for models that embed reasoning in <think>...</think> blocks.
function splitSmolReasoning(text) {
  if (!text || typeof text !== "string") {
    return { reasoning: "", answer: text || "" };
  }

  const THINK_START = "<think>";
  const THINK_END = "</think>";

  const start = text.indexOf(THINK_START);
  const end = text.indexOf(THINK_END);

  if (start === -1 || end === -1 || end < start) {
    return { reasoning: "", answer: text.trim() };
  }

  const reasoning = text
    .slice(start + THINK_START.length, end)
    .trim();

  const answer = (
    text.slice(0, start) +
    text.slice(end + THINK_END.length)
  ).trim();

  return { reasoning, answer };
}

// --- Policy helpers -------------------------------------------------------

function isNetworkError(err) {
  if (!err) return false;
  if (err.code) {
    const code = String(err.code).toUpperCase();
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT"
    ) {
      return true;
    }
  }
  return false;
}

function shouldFallbackOnError(err, policy) {
  const triggers = (policy && policy.triggers) || {};

  if (triggers.networkError && isNetworkError(err)) {
    return true;
  }

  if (err && typeof err.code === "string") {
    if (
      triggers.timeoutMs &&
      String(err.code).toUpperCase() === "ETIMEDOUT"
    ) {
      return true;
    }
  }

  if (err && err.response && typeof err.response.status === "number") {
    const status = err.response.status;
    if (status >= 500 && status <= 599 && triggers.http5xx) {
      return true;
    }
    if (status === 429 && triggers.http429) {
      return true;
    }
    if (status >= 400 && status <= 499 && triggers.http4xx) {
      return true;
    }
  }

  return false;
}

function shouldFallbackOnResult(result, policy) {
  const triggers = (policy && policy.triggers) || {};
  if (!result) return triggers.malformedResponse === true;

  const text = (result.answerText || "").trim();
  if (!text && triggers.emptyOutput) {
    return true;
  }

  if (
    typeof result.answerText !== "string" &&
    triggers.malformedResponse
  ) {
    return true;
  }

  return false;
}

// --- Local Responses provider ---------------------------------------------

async function localComplete({
  fullPrompt,
  reasoningEffort,
  baseUrlOverride,
}) {
  const payload = {
    model: llmModel,
    input: fullPrompt,
    max_output_tokens: Number.isFinite(llmMaxTokens)
      ? llmMaxTokens
      : -1,
    temperature: 0.6,
    top_p: 0.95,
  };

  const effort = normalizeReasoningEffort(reasoningEffort);
  if (effort) {
    payload.reasoning = { effort };
  }

  const baseUrl = baseUrlOverride || llmBaseUrl;
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

  // Use no request timeout for local Responses API calls. Some models (especially
  // with reasoning enabled) can legitimately take longer than 60 seconds, and we
  // already have higher-level fallback handling if the upstream actually fails.
  const response = await axios.post(url, payload, {
    timeout: 0,
  });
  const data = response.data;

  let answerText = "";
  let reasoningText = "";

  if (data) {
    if (Array.isArray(data.output)) {
      for (const out of data.output) {
        if (!out || !Array.isArray(out.content)) continue;
        for (const part of out.content) {
          if (part && typeof part.text === "string") {
            answerText += part.text;
          } else if (part && typeof part.content === "string") {
            answerText += part.content;
          }
        }
      }
    }

    if (data.reasoning) {
      const r = data.reasoning;
      if (typeof r.text === "string") {
        reasoningText += r.text;
      }
      if (Array.isArray(r.content)) {
        for (const part of r.content) {
          if (part && typeof part.text === "string") {
            reasoningText += part.text;
          }
        }
      }
    }

    if (!reasoningText && typeof data.reasoning_content === "string") {
      reasoningText = data.reasoning_content;
    }
    if (!answerText && typeof data.content === "string") {
      answerText = data.content;
    }
  }

  if (!reasoningText) {
    const split = splitSmolReasoning(answerText);
    reasoningText = split.reasoning;
    answerText = split.answer;
  }

  return { answerText, reasoningText, providerUsed: "local" };
}

async function localStream({
  fullPrompt,
  reasoningEffort,
  baseUrlOverride,
  onTyping,
  onSentence,
  onReasoning,
  onEnd,
}) {
  const payload = {
    model: llmModel,
    input: fullPrompt,
    max_output_tokens: Number.isFinite(llmMaxTokens)
      ? llmMaxTokens
      : -1,
    temperature: 0.6,
    top_p: 0.95,
    stream: true,
  };

  const effort = normalizeReasoningEffort(reasoningEffort);
  if (effort) {
    payload.reasoning = { effort };
  }

  const baseUrl = baseUrlOverride || llmBaseUrl;
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

  const upstream = await axios.post(url, payload, {
    responseType: "stream",
    timeout: 0,
  });

  let sseBuffer = "";
  let sentenceBuffer = "";
  let fullAnswer = "";
  let reasoningBuffer = "";
  let reasoningStreamed = false;
  let firstDeltaSeen = false;
  let ended = false;

  function flushSentenceIfAny() {
    const raw = sentenceBuffer;
    if (!raw) return;
    if (!/\S/.test(raw)) {
      sentenceBuffer = "";
      return;
    }
    if (onSentence) {
      onSentence(raw);
    }
    sentenceBuffer = "";
  }

  function isSentenceTerminator(ch) {
    return ch === "." || ch === "!" || ch === "?";
  }

  function handleVisibleDelta(deltaText) {
    if (!deltaText) return;

    if (!firstDeltaSeen) {
      firstDeltaSeen = true;
      if (onTyping) {
        onTyping("start");
      }
    }

    for (const ch of deltaText) {
      sentenceBuffer += ch;
      if (isSentenceTerminator(ch)) {
        flushSentenceIfAny();
      }
    }
  }

  function handleResponsesEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    const type = typeof evt.type === "string" ? evt.type : "";

    if (type.includes("output_text.delta")) {
      let deltaText = "";

      if (typeof evt.delta === "string") {
        deltaText = evt.delta;
      } else if (
        evt.delta &&
        typeof evt.delta.text === "string"
      ) {
        deltaText = evt.delta.text;
      } else if (
        evt.delta &&
        typeof evt.delta.output_text === "string"
      ) {
        deltaText = evt.delta.output_text;
      }

      if (!deltaText) return;

      fullAnswer += deltaText;
      handleVisibleDelta(deltaText);
      return;
    }

    if (type.includes("reasoning")) {
      let textChunk = "";

      if (typeof evt.delta === "string") {
        textChunk = evt.delta;
      } else if (
        evt.delta &&
        typeof evt.delta.text === "string"
      ) {
        textChunk = evt.delta.text;
      } else if (typeof evt.text === "string") {
        textChunk = evt.text;
      }

      if (!textChunk) return;

      reasoningBuffer += textChunk;
      reasoningStreamed = true;
      if (onReasoning) {
        onReasoning(textChunk);
      }
    }
  }

  upstream.data.on("data", (chunk) => {
    if (ended) return;

    sseBuffer += chunk.toString("utf8");

    let newlineIndex;
    while ((newlineIndex = sseBuffer.indexOf("\n")) >= 0) {
      let line = sseBuffer.slice(0, newlineIndex);
      sseBuffer = sseBuffer.slice(newlineIndex + 1);

      line = line.trimEnd();
      if (!line) continue;

      if (!line.toLowerCase().startsWith("data:")) continue;

      const dataPart = line.slice("data:".length).trim();
      if (dataPart === "[DONE]") {
        ended = true;
        flushSentenceIfAny();
        if (onTyping) {
          onTyping("end");
        }

        let reasoningText = reasoningBuffer;
        if (!reasoningStreamed) {
          if (!reasoningText) {
            const split = splitSmolReasoning(fullAnswer);
            reasoningText = split.reasoning;
          }
          if (reasoningText && onReasoning) {
            onReasoning(reasoningText);
          }
        }

        if (onEnd) {
          onEnd({
            providerUsed: "local",
            fullAnswer,
            reasoningText,
          });
        }
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(dataPart);
      } catch {
        continue;
      }

      handleResponsesEvent(parsed);
    }
  });

  upstream.data.on("end", () => {
    if (ended) return;
    ended = true;

    flushSentenceIfAny();
    if (onTyping) {
      onTyping("end");
    }

    let reasoningText = reasoningBuffer;
    if (!reasoningStreamed) {
      if (!reasoningText) {
        const split = splitSmolReasoning(fullAnswer);
        reasoningText = split.reasoning;
      }
      if (reasoningText && onReasoning) {
        onReasoning(reasoningText);
      }
    }

    if (onEnd) {
      onEnd({
        providerUsed: "local",
        fullAnswer,
        reasoningText,
      });
    }
  });

  upstream.data.on("error", (err) => {
    if (ended) return;
    ended = true;
    if (onTyping) {
      onTyping("end");
    }
    if (onEnd) {
      onEnd({
        providerUsed: "local",
        error: err,
        fullAnswer,
        reasoningText: reasoningBuffer,
      });
    }
  });
}

// --- OpenRouter Chat provider ---------------------------------------------

function buildOpenRouterMessages(systemPrompt, userContent) {
  return [
    { role: "system", content: systemPrompt || "" },
    { role: "user", content: userContent || "" },
  ];
}

async function openRouterComplete({
  systemPrompt,
  userContent,
  reasoningEffort,
}) {
  const policy = getFallbackPolicy();
  const { openRouterTier } = policy || {};
  const tierInfo = pickOpenRouterTier(openRouterTier);

  const baseUrl = getOpenRouterBaseUrl();
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const payload = {
    model: tierInfo.model,
    messages: buildOpenRouterMessages(systemPrompt, userContent),
    max_tokens: tierInfo.maxTokens,
    temperature: tierInfo.temperature,
    top_p: tierInfo.topP,
    stream: false,
  };

  // Reasoning effort is not wired to a dedicated OpenRouter field here;
  // models that support <think> will still emit it in content.
  void reasoningEffort;

  const response = await axios.post(url, payload, {
    timeout: 60000,
    headers: getOpenRouterHeaders(),
  });

  const data = response.data || {};
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] || {};
  const message = first.message || {};
  let answerText =
    typeof message.content === "string" ? message.content : "";

  let reasoningText = "";
  if (answerText) {
    const split = splitSmolReasoning(answerText);
    reasoningText = split.reasoning;
    answerText = split.answer;
  }

  return { answerText, reasoningText, providerUsed: "openrouter" };
}

async function openRouterStream({
  systemPrompt,
  userContent,
  reasoningEffort,
  onTyping,
  onSentence,
  onReasoning,
  onEnd,
}) {
  const policy = getFallbackPolicy();
  const { openRouterTier } = policy || {};
  const tierInfo = pickOpenRouterTier(openRouterTier);

  const baseUrl = getOpenRouterBaseUrl();
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const payload = {
    model: tierInfo.model,
    messages: buildOpenRouterMessages(systemPrompt, userContent),
    max_tokens: tierInfo.maxTokens,
    temperature: tierInfo.temperature,
    top_p: tierInfo.topP,
    stream: true,
  };

  void reasoningEffort;

  const upstream = await axios.post(url, payload, {
    responseType: "stream",
    timeout: 0,
    headers: getOpenRouterHeaders(),
  });

  let sseBuffer = "";
  let sentenceBuffer = "";
  let fullAnswer = "";
  let firstDeltaSeen = false;
  let ended = false;

  function flushSentenceIfAny() {
    const raw = sentenceBuffer;
    if (!raw) return;
    if (!/\S/.test(raw)) {
      sentenceBuffer = "";
      return;
    }
    if (onSentence) {
      onSentence(raw);
    }
    sentenceBuffer = "";
  }

  function isSentenceTerminator(ch) {
    return ch === "." || ch === "!" || ch === "?";
  }

  function handleVisibleDelta(deltaText) {
    if (!deltaText) return;

    if (!firstDeltaSeen) {
      firstDeltaSeen = true;
      if (onTyping) {
        onTyping("start");
      }
    }

    for (const ch of deltaText) {
      sentenceBuffer += ch;
      if (isSentenceTerminator(ch)) {
        flushSentenceIfAny();
      }
    }
  }

  upstream.data.on("data", (chunk) => {
    if (ended) return;

    sseBuffer += chunk.toString("utf8");

    let newlineIndex;
    while ((newlineIndex = sseBuffer.indexOf("\n")) >= 0) {
      let line = sseBuffer.slice(0, newlineIndex);
      sseBuffer = sseBuffer.slice(newlineIndex + 1);

      line = line.trimEnd();
      if (!line) continue;

      if (!line.toLowerCase().startsWith("data:")) continue;

      const dataPart = line.slice("data:".length).trim();
      if (dataPart === "[DONE]") {
        ended = true;
        flushSentenceIfAny();
        if (onTyping) {
          onTyping("end");
        }

        let reasoningText = "";
        if (fullAnswer) {
          const split = splitSmolReasoning(fullAnswer);
          reasoningText = split.reasoning;
          if (reasoningText && onReasoning) {
            onReasoning(reasoningText);
          }
        }

        if (onEnd) {
          onEnd({
            providerUsed: "openrouter",
            fullAnswer,
            reasoningText,
          });
        }
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(dataPart);
      } catch {
        continue;
      }

      const choices = Array.isArray(parsed.choices)
        ? parsed.choices
        : [];
      const first = choices[0] || {};
      const delta = first.delta || {};
      const deltaText =
        typeof delta.content === "string" ? delta.content : "";
      if (!deltaText) continue;

      fullAnswer += deltaText;
      handleVisibleDelta(deltaText);
    }
  });

  upstream.data.on("end", () => {
    if (ended) return;
    ended = true;

    flushSentenceIfAny();
    if (onTyping) {
      onTyping("end");
    }

    let reasoningText = "";
    if (fullAnswer) {
      const split = splitSmolReasoning(fullAnswer);
      reasoningText = split.reasoning;
      if (reasoningText && onReasoning) {
        onReasoning(reasoningText);
      }
    }

    if (onEnd) {
      onEnd({
        providerUsed: "openrouter",
        fullAnswer,
        reasoningText,
      });
    }
  });

  upstream.data.on("error", (err) => {
    if (ended) return;
    ended = true;
    if (onTyping) {
      onTyping("end");
    }
    if (onEnd) {
      onEnd({
        providerUsed: "openrouter",
        error: err,
        fullAnswer,
        reasoningText: "",
      });
    }
  });
}

// --- Public gateway: fallback-aware wrappers ------------------------------

function resolvePrimarySecondary(policy, modeOverride) {
  const mode =
    modeOverride || (policy && policy.mode) || "primary_local_then_openrouter";

  if (mode === "openrouter_only") {
    return { primary: "openrouter", secondary: null };
  }
  if (mode === "local_only") {
    return { primary: "local", secondary: null };
  }
  if (mode === "primary_openrouter_then_local") {
    return { primary: "openrouter", secondary: "local" };
  }

  // Default: local first, then OpenRouter.
  return { primary: "local", secondary: "openrouter" };
}

function mapSourceOverrides({ llmSource, lanHost, lanPort }) {
  const src = (llmSource || "").toLowerCase();
  let modeOverride = null;
  let localBaseUrlOverride = null;

  if (src === "remote") {
    modeOverride = "openrouter_only";
  } else if (src === "lan") {
    localBaseUrlOverride = buildLanBaseUrl(lanHost, lanPort);
  }

  return { modeOverride, localBaseUrlOverride };
}

async function completeWithFallback({
  systemPrompt,
  userContent,
  reasoningEffort,
  modeOverride,
  localBaseUrlOverride,
}) {
  const policy = getFallbackPolicy();
  const { primary, secondary } = resolvePrimarySecondary(
    policy,
    modeOverride
  );

  const fullPrompt = [systemPrompt || "", "", userContent || ""].join(
    "\n\n"
  );

  const rawReasoning =
    typeof reasoningEffort === "string"
      ? reasoningEffort.trim().toLowerCase()
      : "";
  const disableReasoning =
    rawReasoning === "none" || rawReasoning === "off";

  async function runProvider(name) {
    if (name === "openrouter") {
      return openRouterComplete({
        systemPrompt,
        userContent,
        reasoningEffort,
      });
    }
    const result = await localComplete({
      fullPrompt,
      reasoningEffort,
      baseUrlOverride: localBaseUrlOverride,
    });
    return result;
  }

  let primaryResult;
  try {
    primaryResult = await runProvider(primary);
    if (!shouldFallbackOnResult(primaryResult, policy)) {
      if (disableReasoning && primaryResult) {
        primaryResult.reasoningText = "";
      }
      return primaryResult;
    }
  } catch (err) {
    if (!secondary || !shouldFallbackOnError(err, policy)) {
      throw err;
    }
  }

  if (!secondary) {
    if (disableReasoning && primaryResult) {
      primaryResult.reasoningText = "";
    }
    return primaryResult;
  }

  const fallbackResult = await runProvider(secondary);
  if (disableReasoning && fallbackResult) {
    fallbackResult.reasoningText = "";
  }
  return fallbackResult;
}

async function streamWithFallback({
  systemPrompt,
  userContent,
  reasoningEffort,
  modeOverride,
  localBaseUrlOverride,
  onTyping,
  onSentence,
  onReasoning,
  onEnd,
}) {
  const policy = getFallbackPolicy();
  const { primary, secondary } = resolvePrimarySecondary(
    policy,
    modeOverride
  );

  const fullPrompt = [systemPrompt || "", "", userContent || ""].join(
    "\n\n"
  );

  let hasProducedOutput = false;

  const rawReasoning =
    typeof reasoningEffort === "string"
      ? reasoningEffort.trim().toLowerCase()
      : "";
  const disableReasoning =
    rawReasoning === "none" || rawReasoning === "off";

  function wrapOnSentence(cb) {
    if (!cb) return null;
    return (text) => {
      hasProducedOutput = true;
      cb(text);
    };
  }

  function wrapOnReasoning(cb) {
    if (disableReasoning) return null;
    if (!cb) return null;
    return (text) => {
      hasProducedOutput = true;
      cb(text);
    };
  }

  async function runProvider(name, allowFallbackOnError) {
    const wrappedOnSentence = wrapOnSentence(onSentence);
    const wrappedOnReasoning = wrapOnReasoning(onReasoning);

    let capturedError = null;

    function providerOnEnd(info) {
      if (capturedError && allowFallbackOnError) {
        return;
      }
      if (onEnd) {
        onEnd(info);
      }
    }

    const runner =
      name === "openrouter"
        ? () =>
            openRouterStream({
              systemPrompt,
              userContent,
              reasoningEffort,
              onTyping,
              onSentence: wrappedOnSentence,
              onReasoning: wrappedOnReasoning,
              onEnd: providerOnEnd,
            })
        : () =>
            localStream({
              fullPrompt,
              reasoningEffort,
              baseUrlOverride: localBaseUrlOverride,
              onTyping,
              onSentence: wrappedOnSentence,
              onReasoning: wrappedOnReasoning,
              onEnd: providerOnEnd,
            });

    try {
      await runner();
      return null;
    } catch (err) {
      capturedError = err;
      if (!allowFallbackOnError || hasProducedOutput) {
        if (onEnd) {
          onEnd({
            providerUsed: name,
            error: err,
          });
        }
        return err;
      }
      if (!secondary || !shouldFallbackOnError(err, policy)) {
        if (onEnd) {
          onEnd({
            providerUsed: name,
            error: err,
          });
        }
        return err;
      }
      return err;
    }
  }

  const primaryError = await runProvider(primary, true);
  if (!primaryError || !secondary || hasProducedOutput) {
    return;
  }

  await runProvider(secondary, false);
}

// --- Exported coach/taunt-specific helpers -------------------------------

async function completeCoachReply({
  systemPrompt,
  userContent,
  reasoningEffort,
  llmSource,
  lanHost,
  lanPort,
}) {
  const { modeOverride, localBaseUrlOverride } = mapSourceOverrides({
    llmSource,
    lanHost,
    lanPort,
  });
  return completeWithFallback({
    systemPrompt,
    userContent,
    reasoningEffort,
    modeOverride,
    localBaseUrlOverride,
  });
}

async function completeTaunt({
  systemPrompt,
  userContent,
  reasoningEffort,
  llmSource,
  lanHost,
  lanPort,
}) {
  const { modeOverride, localBaseUrlOverride } = mapSourceOverrides({
    llmSource,
    lanHost,
    lanPort,
  });
  return completeWithFallback({
    systemPrompt,
    userContent,
    reasoningEffort,
    modeOverride,
    localBaseUrlOverride,
  });
}

async function streamCoachReply({
  systemPrompt,
  userContent,
  reasoningEffort,
  llmSource,
  lanHost,
  lanPort,
  onTyping,
  onSentence,
  onReasoning,
  onEnd,
}) {
  const { modeOverride, localBaseUrlOverride } = mapSourceOverrides({
    llmSource,
    lanHost,
    lanPort,
  });
  return streamWithFallback({
    systemPrompt,
    userContent,
    reasoningEffort,
    modeOverride,
    localBaseUrlOverride,
    onTyping,
    onSentence,
    onReasoning,
    onEnd,
  });
}

async function streamTaunt({
  systemPrompt,
  userContent,
  reasoningEffort,
  llmSource,
  lanHost,
  lanPort,
  onTyping,
  onSentence,
  onReasoning,
  onEnd,
}) {
  const { modeOverride, localBaseUrlOverride } = mapSourceOverrides({
    llmSource,
    lanHost,
    lanPort,
  });
  return streamWithFallback({
    systemPrompt,
    userContent,
    reasoningEffort,
    modeOverride,
    localBaseUrlOverride,
    onTyping,
    onSentence,
    onReasoning,
    onEnd,
  });
}

module.exports = {
  completeCoachReply,
  completeTaunt,
  streamCoachReply,
  streamTaunt,
};


