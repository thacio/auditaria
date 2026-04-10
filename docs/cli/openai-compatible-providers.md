# Custom OpenAI-compatible providers

Auditaria can use any LLM endpoint that speaks the OpenAI Chat Completions
API format — including OpenAI itself, local models via Ollama, DeepSeek, Azure
OpenAI, vLLM, LM Studio, and many others. Custom providers run inside
Auditaria's full agent pipeline: tools, file editing, context management, and
rewind all work the same as with Gemini.

## How it works

When you select a custom provider in `/model`, Auditaria swaps its content
generator so all LLM calls go to your configured endpoint. Gemini's tool
scheduler, hooks, and conversation history are unchanged — only the model
brain changes.

This means:

- **All Auditaria tools work** (file editing, bash, web fetch, knowledge
  search, etc.) as long as the model supports OpenAI function calling.
- **Multi-turn conversations work** with full history.
- **Streaming, image attachments, and reasoning tokens** are supported.
- **`/rewind`, `/clear`, `/compress`, web interface** all work unchanged.
- **No subprocess required** — direct HTTP calls to your endpoint.

## Configuration

Custom providers are configured in a JSON file at:

```
~/.auditaria/providers.json
```

This file is **not committed** to any repo. It lives in your home directory and
holds your endpoint URLs, API keys (or env var references), and model lists.

Basic structure:

```json
{
  "providers": [
    {
      "id": "<unique-id>",
      "name": "<display name>",
      "type": "openai-compatible",
      "baseUrl": "https://api.example.com/v1",
      "auth": { "type": "bearer", "token": "${MY_API_KEY}" },
      "models": [
        { "id": "model-name", "displayName": "Model Name", "contextWindow": 128000 }
      ],
      "defaultModel": "model-name"
    }
  ]
}
```

### Configuration fields

| Field          | Required | Description                                                  |
| -------------- | -------- | ------------------------------------------------------------ |
| `id`           | yes      | Stable identifier (used internally as `openai-compat:{id}`). |
| `name`         | yes      | Display name shown in `/model` menu.                         |
| `type`         | yes      | Must be `"openai-compatible"`.                               |
| `baseUrl`      | yes      | Base URL ending in `/v1` (or wherever `/chat/completions` lives). |
| `auth`         | yes      | Authentication config — see below.                           |
| `models`       | yes      | List of available models — see below.                        |
| `defaultModel` | no       | Default model selected when activating this provider.        |
| `headers`      | no       | Extra HTTP headers (object).                                 |
| `tls`          | no       | `{ "rejectUnauthorized": false }` for self-signed certs.     |

### Auth types

```json
{ "auth": { "type": "none" } }
```

```json
{ "auth": { "type": "bearer", "token": "${API_KEY}" } }
```

```json
{ "auth": { "type": "header", "name": "api-key", "value": "${API_KEY}" } }
```

The `${VAR}` syntax expands environment variables at startup. If the env var is
not set, the field is empty.

### Model entries

```json
{
  "id": "model-name",
  "displayName": "Model Name (optional)",
  "contextWindow": 128000,
  "maxOutputTokens": 16384
}
```

`contextWindow` is the maximum input token budget for the model. It's used by
Auditaria's context display and compression logic.

## Examples

### OpenAI

```json
{
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "type": "bearer", "token": "${OPENAI_API_KEY}" },
      "models": [
        { "id": "gpt-4o-mini", "contextWindow": 128000 },
        { "id": "gpt-4o", "contextWindow": 128000 },
        { "id": "gpt-4.1-mini", "contextWindow": 1000000 }
      ],
      "defaultModel": "gpt-4o-mini"
    }
  ]
}
```

Set the env var, then start Auditaria:

```bash
set OPENAI_API_KEY=sk-proj-...
auditaria
```

In Auditaria: `/model` → **OpenAI** → pick a model.

### Ollama (local)

```json
{
  "providers": [
    {
      "id": "ollama",
      "name": "Ollama Local",
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "auth": { "type": "none" },
      "models": [
        { "id": "qwen2.5:7b-32k", "displayName": "Qwen 2.5 7B (32K)", "contextWindow": 32768 }
      ],
      "defaultModel": "qwen2.5:7b-32k"
    }
  ]
}
```

> [!IMPORTANT]
> **Ollama context truncation gotcha** — Ollama's OpenAI-compatible endpoint
> silently truncates the conversation to the model's default `num_ctx` (often
> 2048 or 4096 tokens), regardless of the model's native context size. The
> standard `options.num_ctx` parameter is **ignored** by Ollama's compatibility
> layer. This causes the system prompt to fill the entire window and the model
> never sees user messages.
>
> **Fix:** Create a Modelfile that bakes the context size into the model:
>
> ```
> # Modelfile
> FROM qwen2.5:7b
> PARAMETER num_ctx 32768
> ```
>
> Then create the variant:
>
> ```bash
> ollama create qwen2.5:7b-32k -f Modelfile
> ```
>
> Use `qwen2.5:7b-32k` as the model id in `providers.json`.

### DeepSeek

```json
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "type": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "auth": { "type": "bearer", "token": "${DEEPSEEK_API_KEY}" },
      "models": [
        { "id": "deepseek-chat", "contextWindow": 65536 },
        { "id": "deepseek-reasoner", "contextWindow": 65536 }
      ],
      "defaultModel": "deepseek-chat"
    }
  ]
}
```

DeepSeek's reasoning model emits thinking tokens via `reasoning_content`,
which Auditaria automatically displays as a thought block.

### Azure OpenAI

```json
{
  "providers": [
    {
      "id": "azure",
      "name": "Azure OpenAI",
      "type": "openai-compatible",
      "baseUrl": "https://my-resource.openai.azure.com/openai/deployments/my-deployment",
      "completionsPath": "/chat/completions?api-version=2024-02-15-preview",
      "auth": { "type": "header", "name": "api-key", "value": "${AZURE_OPENAI_KEY}" },
      "models": [
        { "id": "gpt-4", "contextWindow": 128000 }
      ]
    }
  ]
}
```

### Multiple providers

You can configure as many providers as you want — they all appear as separate
groups in the `/model` menu.

```json
{
  "providers": [
    { "id": "openai", "name": "OpenAI", ... },
    { "id": "ollama", "name": "Ollama Local", ... },
    { "id": "deepseek", "name": "DeepSeek", ... }
  ]
}
```

## Using a custom provider

After editing `providers.json`, restart Auditaria. Then:

1. Run `/model`
2. You'll see your custom providers listed alongside Gemini, Claude, Codex,
   and Copilot.
3. Select your provider — a submenu appears with the configured models.
4. Pick a model — Auditaria switches the LLM brain immediately.

The footer shows the active model (e.g., `OpenAI: gpt-4o-mini`).

The web interface (`/web`) also shows custom providers as separate groups in
its model selector.

## Features

| Feature                 | Status     | Notes                                                  |
| ----------------------- | ---------- | ------------------------------------------------------ |
| Streaming               | ✅         | SSE streaming with proper finish reason handling.     |
| Tool / function calling | ✅         | Works if the model supports OpenAI's `tools` format.   |
| Multi-turn history      | ✅         | Full conversation history sent on each request.       |
| Image attachments       | ✅         | Translated to OpenAI `image_url` format.               |
| Reasoning tokens        | ✅         | DeepSeek's `reasoning_content` shown as thoughts.     |
| Tool use loop           | ✅         | Gemini's scheduler executes tools, sends results back. |
| File editing / bash     | ✅         | Through Gemini's tool scheduler.                       |
| `/rewind`               | ✅         | Works the same as Gemini.                              |
| `/clear`                | ✅         | Clears history and resets the conversation.            |
| Web interface           | ✅         | Custom providers appear in web model menu.             |
| Cost / token tracking   | ⚠️ Partial | Token estimation works; cost shows as 0.               |
| Context compression     | ✅         | Uses Gemini's compression with the custom model.      |

## Limitations

- **Tool support depends on the model.** Not every model supports OpenAI
  function calling. Smaller local models may chat fine but fail at tool calls.
  Test with a simple "create a file" request.
- **Some providers ignore `tool_choice`.** Ollama, for example, decides
  automatically when to use tools — you can't force-call or force-text.
- **No automatic model discovery.** You must list models manually in
  `providers.json`. (A future enhancement may auto-populate from `/v1/models`.)
- **Context window must be configured per model.** Auditaria uses
  `contextWindow` for token estimation; setting it correctly affects
  compression triggers.

## Troubleshooting

### "API Error: 401 unauthorized"

Your API key isn't set or is wrong. Check the env var or hardcoded token in
`providers.json`.

### "API Error: 400 ... model does not support tools"

The model you selected doesn't have tool calling enabled. Either use a model
that supports tools, or accept that this model is text-only and won't be able
to edit files or run commands.

### Model loses memory between turns / says "I don't have memory"

Almost always an Ollama context truncation issue. Check the model's context
size with `ollama show <model>`. If it's 2048 or 4096, create a Modelfile
variant with larger `num_ctx` (see the Ollama section above).

### Custom provider doesn't appear in `/model`

- Check `~/.auditaria/providers.json` is valid JSON.
- Check the file path is exactly `~/.auditaria/providers.json` in your home
  directory.
- Restart Auditaria — providers are loaded once at startup.

### Self-signed certificate errors

Add to your provider config:

```json
{ "tls": { "rejectUnauthorized": false } }
```

This disables TLS certificate verification for that provider only.

## Security notes

- `~/.auditaria/providers.json` is your private config — never committed.
- Prefer environment variable references (`${API_KEY}`) over hardcoded tokens.
- Tokens are never sent to anywhere except your configured `baseUrl`.
- For local Ollama, no auth is needed (`"auth": { "type": "none" }`).
