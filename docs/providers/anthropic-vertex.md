---
summary: "Use Claude models on Google Vertex AI with OpenClaw"
read_when:
  - You want to use Claude models through Google Vertex AI
  - You need GCP credential setup for Anthropic models
title: "Anthropic Vertex AI"
---

# Anthropic Vertex AI

OpenClaw can use **Claude models** via **Google Vertex AI**, billing through your
GCP project instead of the Anthropic API directly. Auth uses **GCP Application
Default Credentials** (ADC), not an Anthropic API key.

## What OpenClaw supports

- Provider: `anthropic-vertex`
- API: `anthropic-messages` (same Messages API as direct Anthropic)
- Auth: GCP Application Default Credentials
- Models auto-registered: Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5

## Setup

1. Set GCP credentials on the host:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
export GOOGLE_CLOUD_LOCATION="global"
```

Alternative env var names are also supported: `ANTHROPIC_VERTEX_PROJECT_ID`
(for project) and `CLOUD_ML_REGION` (for location).

2. Set the default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic-vertex/claude-sonnet-4-6" },
    },
  },
}
```

That's it. When `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are set,
OpenClaw auto-registers Claude models under the `anthropic-vertex` provider.

## Available models

| Model             | Vertex AI ID                | Max output  |
| ----------------- | --------------------------- | ----------- |
| Claude Opus 4.6   | `claude-opus-4-6`           | 128K tokens |
| Claude Sonnet 4.6 | `claude-sonnet-4-6`         | 64K tokens  |
| Claude Haiku 4.5  | `claude-haiku-4-5@20251001` | 64K tokens  |

Latest models (Opus 4.6, Sonnet 4.6) use plain IDs on Vertex AI. Only older
models require `@YYYYMMDD` date suffixes.

## Manual provider config

To override models or pin specific versions:

```json5
{
  models: {
    providers: {
      "anthropic-vertex": {
        baseUrl: "https://global-aiplatform.googleapis.com",
        api: "anthropic-messages",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6 (pinned)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            contextWindow: 200000,
            maxTokens: 64000,
          },
        ],
      },
    },
  },
}
```

## Notes

- Claude models must be **enabled** in your GCP project's Vertex AI Model Garden.
- The `@anthropic-ai/vertex-sdk` handles token refresh automatically.
- Use `global` as the location for maximum availability. Regional endpoints
  are also supported for data residency requirements.
- For the AWS equivalent, see [Amazon Bedrock](/providers/bedrock).
