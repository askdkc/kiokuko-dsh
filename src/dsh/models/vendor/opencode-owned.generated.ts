/** Generated from official rosters and exact-route models.dev metadata. */
export const OPEN_CODE_SNAPSHOTS = {
  "opencode": {
    "version": 1,
    "provider": "opencode",
    "fetchedAt": 1790827880774,
    "roster": [
      "big-pickle",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-4",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "deepseek-v4-flash",
      "deepseek-v4-flash-free",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "gemini-3-flash",
      "gemini-3.1-pro",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-nano",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "grok-4.5",
      "grok-4.6",
      "grok-4.7",
      "grok-build-0.1",
      "jev-1.13",
      "jev-1.13-free",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "ling-3.0-flash-fin-free",
      "longcat-2.5-preview-free",
      "mimo-v2.5-free",
      "mimo-v2.6-flash-free",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3",
      "muse-spark-1.3-contributor-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "qwen3.5-plus",
      "qwen3.6-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
      "space-bunny-free"
    ],
    "models": [
      {
        "id": "big-pickle",
        "name": "Big Pickle",
        "protocol": "chat",
        "contextWindow": 200000,
        "maxTokens": 32000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 0.25,
          "cache_write": 12.5
        }
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5",
        "protocol": "messages",
        "contextWindow": 200000,
        "maxTokens": 64000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5",
        "protocol": "messages",
        "contextWindow": 200000,
        "maxTokens": 64000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high",
          "max"
        ],
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 5,
          "output": 25,
          "cache_read": 0.5,
          "cache_write": 6.25
        }
      },
      {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 4,
          "output": 20,
          "cache_read": 0.2,
          "cache_write": 5
        }
      },
      {
        "id": "claude-sonnet-4",
        "name": "Claude Sonnet 4",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 64000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 64000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 64000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high",
          "max"
        ],
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.028
        }
      },
      {
        "id": "deepseek-v4-flash-free",
        "name": "DeepSeek V4 Flash Free",
        "protocol": "chat",
        "contextWindow": 200000,
        "maxTokens": 128000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision Exp",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.028
        }
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "high",
          "max"
        ],
        "cost": {
          "input": 1.74,
          "output": 3.84,
          "cache_read": 0.145
        }
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.006
        }
      },
      {
        "id": "gemini-3-flash",
        "name": "Gemini 3 Flash",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 0.5,
          "output": 3,
          "cache_read": 0.05
        }
      },
      {
        "id": "gemini-3.1-pro",
        "name": "Gemini 3.1 Pro Preview",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 2,
          "output": 12,
          "cache_read": 0.2
        }
      },
      {
        "id": "gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.5,
          "output": 9,
          "cache_read": 0.15,
          "input_audio": 1.5
        }
      },
      {
        "id": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 0.3,
          "output": 2.5,
          "cache_read": 0.03
        }
      },
      {
        "id": "gemini-3.6-flash",
        "name": "Gemini 3.6 Flash",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.5,
          "output": 7.5,
          "cache_read": 0.15,
          "input_audio": 1.5
        }
      },
      {
        "id": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.5,
          "output": 7.5,
          "cache_read": 0.15,
          "input_audio": 1.5
        }
      },
      {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash",
        "protocol": "google",
        "contextWindow": 1048576,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.5,
          "output": 7.5,
          "cache_read": 0.15,
          "input_audio": 1.5
        }
      },
      {
        "id": "glm-5",
        "name": "GLM-5",
        "protocol": "chat",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 1,
          "output": 3.2,
          "cache_read": 0.2
        }
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "protocol": "chat",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26
        }
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "high",
          "max"
        ],
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26
        }
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26
        }
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.5,
          "cache_read": 0.03
        }
      },
      {
        "id": "gpt-5",
        "name": "GPT-5",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.07,
          "output": 8.5,
          "cache_read": 0.107
        }
      },
      {
        "id": "gpt-5-codex",
        "name": "GPT-5 Codex",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.07,
          "output": 8.5,
          "cache_read": 0.107
        }
      },
      {
        "id": "gpt-5-nano",
        "name": "GPT-5 Nano",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 0.05,
          "output": 0.4,
          "cache_read": 0.005
        }
      },
      {
        "id": "gpt-5.1",
        "name": "GPT-5.1",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.07,
          "output": 8.5,
          "cache_read": 0.107
        }
      },
      {
        "id": "gpt-5.1-codex",
        "name": "GPT-5.1 Codex",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 1.07,
          "output": 8.5,
          "cache_read": 0.107
        }
      },
      {
        "id": "gpt-5.1-codex-max",
        "name": "GPT-5.1 Codex Max",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.25,
          "output": 10,
          "cache_read": 0.125
        }
      },
      {
        "id": "gpt-5.1-codex-mini",
        "name": "GPT-5.1 Codex Mini",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 0.25,
          "output": 2,
          "cache_read": 0.025
        }
      },
      {
        "id": "gpt-5.2",
        "name": "GPT-5.2",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      {
        "id": "gpt-5.2-codex",
        "name": "GPT-5.2 Codex",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      {
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      {
        "id": "gpt-5.3-codex-spark",
        "name": "GPT-5.3 Codex Spark",
        "protocol": "responses",
        "contextWindow": 128000,
        "maxTokens": 128000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.75,
          "output": 14,
          "cache_read": 0.175
        }
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 2.5,
          "output": 15,
          "cache_read": 0.25
        }
      },
      {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 0.75,
          "output": 4.5,
          "cache_read": 0.075
        }
      },
      {
        "id": "gpt-5.4-nano",
        "name": "GPT-5.4 Nano",
        "protocol": "responses",
        "contextWindow": 400000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 0.2,
          "output": 1.25,
          "cache_read": 0.02
        }
      },
      {
        "id": "gpt-5.4-pro",
        "name": "GPT-5.4 Pro",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 30,
          "output": 180,
          "cache_read": 30
        }
      },
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 5,
          "output": 30,
          "cache_read": 0.5
        }
      },
      {
        "id": "gpt-5.5-pro",
        "name": "GPT-5.5 Pro",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 30,
          "output": 180,
          "cache_read": 30
        }
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      {
        "id": "gpt-5.6-sol",
        "name": "GPT-5.6 Sol",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 4,
          "output": 20,
          "cache_read": 0.4,
          "cache_write": 5
        }
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 2.5,
          "output": 15,
          "cache_read": 0.25,
          "cache_write": 3.125
        }
      },
      {
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 10,
          "output": 50,
          "cache_read": 1,
          "cache_write": 12.5
        }
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT-6 Luna",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 0.1,
          "output": 0.5,
          "cache_read": 0.01,
          "cache_write": 0.125
        }
      },
      {
        "id": "gpt-6-sol",
        "name": "GPT-6 Sol",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      {
        "id": "gpt-6.1-sol",
        "name": "GPT-6.1 Sol",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.1,
          "cache_write": 2.5
        }
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5",
        "protocol": "responses",
        "contextWindow": 500000,
        "maxTokens": 500000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.3
        }
      },
      {
        "id": "grok-4.6",
        "name": "Grok 4.6",
        "protocol": "responses",
        "contextWindow": 500000,
        "maxTokens": 500000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      {
        "id": "grok-4.7",
        "name": "Grok 4.7",
        "protocol": "responses",
        "contextWindow": 500000,
        "maxTokens": 500000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      {
        "id": "grok-build-0.1",
        "name": "Grok Build 0.1",
        "protocol": "responses",
        "contextWindow": 256000,
        "maxTokens": 256000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 1,
          "output": 2,
          "cache_read": 0.2
        }
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.6,
          "output": 3,
          "cache_read": 0.08
        }
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.16
        }
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 262144,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [],
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.19
        }
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "protocol": "chat",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "max"
        ],
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3
        }
      },
      {
        "id": "ling-3.0-flash-fin-free",
        "name": "Ling 3.0 Flash Fin Free",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 32768,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "longcat-2.5-preview-free",
        "name": "LongCat 2.5 Preview Free",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "mimo-v2.5-free",
        "name": "MiMo V2.5 Free",
        "protocol": "chat",
        "contextWindow": 200000,
        "maxTokens": 32000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "mimo-v2.6-flash-free",
        "name": "MiMo-V2.6-Flash Free",
        "protocol": "chat",
        "contextWindow": 200000,
        "maxTokens": 32000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "minimax-m2.5",
        "name": "MiniMax-M2.5",
        "protocol": "chat",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax-M2.7",
        "protocol": "chat",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax-M3",
        "protocol": "chat",
        "contextWindow": 512000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      {
        "id": "muse-spark-1.2",
        "name": "Muse Spark 1.2",
        "protocol": "responses",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.25,
          "output": 4.25,
          "cache_read": 0.15
        }
      },
      {
        "id": "muse-spark-1.2-contributor-free",
        "name": "Muse Spark 1.2 Free",
        "protocol": "responses",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "muse-spark-1.3",
        "name": "Muse Spark 1.3",
        "protocol": "responses",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 1.25,
          "output": 4.25,
          "cache_read": 0.15
        }
      },
      {
        "id": "muse-spark-1.3-contributor-free",
        "name": "Muse Spark 1.3 Free",
        "protocol": "responses",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "nemotron-3-ultra-free",
        "name": "Nemotron 3 Ultra Free",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "nemotron-3.5-lightning-free",
        "name": "Nemotron 3.5 Lightning Free",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 262144,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus",
        "protocol": "messages",
        "contextWindow": 262144,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "protocol": "messages",
        "contextWindow": 262144,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.5,
          "output": 3,
          "cache_read": 0.05,
          "cache_write": 0.625
        }
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "xhigh"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.47,
          "cache_read": 0.016,
          "cache_write": 0.2
        }
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.25,
          "cache_write": 2.5
        }
      }
    ],
    "excluded": [
      {
        "id": "jev-1.13",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "jev-1.13-free",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "space-bunny-free",
        "reason": "model capabilities unavailable"
      }
    ]
  },
  "opencode-go": {
    "version": 1,
    "provider": "opencode-go",
    "fetchedAt": 1790827880959,
    "roster": [
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "gpt-6-luna",
      "grok-4.5",
      "grok-4.6",
      "grok-4.7",
      "hy3",
      "hy3-preview",
      "hy4-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "longcat-2.0",
      "longcat-2.5-preview-free",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "omen-alpha",
      "qwen3.5-plus",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
      "space-bunny-free"
    ],
    "models": [
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.003
        }
      },
      {
        "id": "deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision Exp",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.003
        }
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro (New)",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "high",
          "max"
        ],
        "cost": {
          "input": 0.66,
          "output": 1.98,
          "cache_read": 0.022
        }
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.003
        }
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "high",
          "max"
        ],
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26
        }
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 1.4,
          "output": 4.4,
          "cache_read": 0.26
        }
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.5,
          "cache_read": 0.03
        }
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25
        }
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT-6 Luna",
        "protocol": "responses",
        "contextWindow": 1050000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "cost": {
          "input": 0.1,
          "output": 0.5,
          "cache_read": 0.01,
          "cache_write": 0.125
        }
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5",
        "protocol": "responses",
        "contextWindow": 500000,
        "maxTokens": 500000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.3
        }
      },
      {
        "id": "grok-4.6",
        "name": "Grok 4.6",
        "protocol": "responses",
        "contextWindow": 500000,
        "maxTokens": 500000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      {
        "id": "grok-4.7",
        "name": "Grok 4.7",
        "protocol": "responses",
        "contextWindow": 500000,
        "maxTokens": 500000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.5
        }
      },
      {
        "id": "hy3",
        "name": "Hy3",
        "protocol": "chat",
        "contextWindow": 256000,
        "maxTokens": 128000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "none",
          "low",
          "high"
        ],
        "cost": {
          "input": 0.14,
          "output": 0.58,
          "cache_read": 0.035
        }
      },
      {
        "id": "hy4-preview",
        "name": "Hy4 preview",
        "protocol": "chat",
        "contextWindow": 1024000,
        "maxTokens": 64000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "none",
          "high"
        ],
        "cost": {
          "input": 0.834,
          "output": 2.501,
          "cache_read": 0.042
        }
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.16
        }
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "protocol": "chat",
        "contextWindow": 262144,
        "maxTokens": 262144,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [],
        "cost": {
          "input": 0.95,
          "output": 4,
          "cache_read": 0.19
        }
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "protocol": "chat",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": false,
        "efforts": [
          "max"
        ],
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3
        }
      },
      {
        "id": "longcat-2.0",
        "name": "LongCat-2.0",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.006
        }
      },
      {
        "id": "longcat-2.5-preview-free",
        "name": "LongCat 2.5 Preview Free",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0
        }
      },
      {
        "id": "mimo-v2.5",
        "name": "MiMo V2.5",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.0028
        }
      },
      {
        "id": "mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro",
        "protocol": "chat",
        "contextWindow": 1048576,
        "maxTokens": 128000,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.435,
          "output": 0.87,
          "cache_read": 0.003625
        }
      },
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo-V2.6-Flash",
        "protocol": "chat",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cache_read": 0.0028
        }
      },
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo-V2.6-Pro",
        "protocol": "chat",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.435,
          "output": 0.87,
          "cache_read": 0.003625
        }
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax-M2.7",
        "protocol": "messages",
        "contextWindow": 204800,
        "maxTokens": 131072,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06,
          "cache_write": 0.375
        }
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax-M3",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.3,
          "output": 1.2,
          "cache_read": 0.06
        }
      },
      {
        "id": "muse-spark-1.2-contributor",
        "name": "Muse Spark 1.2 Contributor",
        "protocol": "responses",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 0.1,
          "output": 0.2,
          "cache_read": 0.002
        }
      },
      {
        "id": "muse-spark-1.3-contributor",
        "name": "Muse Spark 1.3 Contributor",
        "protocol": "responses",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ],
        "cost": {
          "input": 0.1,
          "output": 0.2,
          "cache_read": 0.002
        }
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.5,
          "output": 3,
          "cache_read": 0.05,
          "cache_write": 0.625
        }
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "inputModalities": [
          "text"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 2.5,
          "output": 7.5,
          "cache_read": 0.5,
          "cache_write": 3.125
        }
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 65536,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [],
        "cost": {
          "input": 0.4,
          "output": 1.6,
          "cache_read": 0.04,
          "cache_write": 0.5
        }
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "protocol": "messages",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "xhigh"
        ],
        "cost": {
          "input": 0.15,
          "output": 0.47,
          "cache_read": 0.016,
          "cache_write": 0.2
        }
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "protocol": "chat",
        "contextWindow": 1000000,
        "maxTokens": 131072,
        "inputModalities": [
          "text",
          "image"
        ],
        "toolCall": true,
        "reasoning": true,
        "temperature": true,
        "efforts": [
          "low",
          "medium",
          "xhigh"
        ],
        "cost": {
          "input": 2,
          "output": 6,
          "cache_read": 0.25,
          "cache_write": 2.5
        }
      }
    ],
    "excluded": [
      {
        "id": "deepseek-flash",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "glm-5",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "glm-5.1",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "hy3-preview",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "kimi-k2.5",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "mimo-v2-omni",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "mimo-v2-pro",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "minimax-m2.5",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "omen-alpha",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "qwen3.5-plus",
        "reason": "metadata unavailable for this route and id"
      },
      {
        "id": "space-bunny-free",
        "reason": "model capabilities unavailable"
      }
    ]
  }
}
