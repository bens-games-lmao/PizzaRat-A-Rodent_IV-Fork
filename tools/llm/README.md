# LLM Coach Web – Local + OpenRouter Fallback

This small web app exposes a chess coach UI that talks to an LLM. By default it
targets a **local Responses-style server**, but it can **fall back to OpenRouter**
for remote models (fast/cheap/quality tiers).

## Running the server

From `tools/llm-coach-web`:

```bash
npm install
node server.js
```

The app listens on `http://localhost:4100` by default.

## LLM configuration

### Local Responses server

Existing environment variables (unchanged from before):

- `LLM_BASE_URL` – e.g. `http://127.0.0.1:1234/v1`
- `LLM_MODEL` – e.g. `smollm3-3b-128k`
- `LLM_MAX_TOKENS` – max output tokens (default `4096`)

These are read by the gateway for the `localResponses` provider and sent to the
`/responses` endpoint.

### OpenRouter

Set the following environment variables (e.g. via your existing `private/keys.env`
or process manager – do **not** commit the key):

- `OPENROUTER_API_KEY` – your OpenRouter API key (required for remote calls)
- `OPENROUTER_BASE_URL` – optional, defaults to `https://openrouter.ai/api/v1`
- `OPENROUTER_APP_NAME` – optional, sent as `X-Title` (e.g. `PizzaRAT Chess Coach`)
- `OPENROUTER_REFERER` – optional, sent as `HTTP-Referer` for dashboard usage stats

### Provider and fallback policy

High‑level provider and fallback settings live in `llm.config.json` in this
directory. The default shipped file looks like:

```json
{
  "providers": {
    "localResponses": {
      "type": "responses",
      "label": "Local SmolLM / Responses API",
      "maxTokensDefault": 4096
    },
    "openRouter": {
      "type": "openrouter_chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "defaultTier": "fast",
      "tiers": {
        "cheap": {
          "model": "google/gemini-flash-1.5",
          "maxTokens": 4096
        },
        "fast": {
          "model": "openai/gpt-4o-mini",
          "maxTokens": 4096
        },
        "quality": {
          "model": "openai/gpt-4.1",
          "maxTokens": 4096
        }
      },
      "temperature": 0.6,
      "topP": 0.95
    }
  },
  "fallbackPolicy": {
    "mode": "primary_local_then_openrouter",
    "openRouterTier": "fast",
    "triggers": {
      "networkError": true,
      "timeoutMs": 15000,
      "http5xx": true,
      "http429": true,
      "http4xx": false,
      "emptyOutput": true,
      "malformedResponse": true
    }
  }
}
```

**Key points:**

- `mode` controls primary vs fallback:
  - `"primary_local_then_openrouter"` – try local first, then OpenRouter on failure.
  - `"openrouter_only"` – always use OpenRouter, no local calls.
  - `"local_only"` – only use the local server, no remote calls.
  - `"primary_openrouter_then_local"` – prefer OpenRouter, fall back to local.
- `openRouterTier` selects which tier (key in `tiers`) is used for coach + taunt calls.
  You can define your own tiers and models if you want.

The browser UI and `/api/*` endpoints are unchanged; all provider selection and
fallback happens inside `llmGateway.js` on the server.


