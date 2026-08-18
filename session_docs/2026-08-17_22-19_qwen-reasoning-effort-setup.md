# Qwen Reasoning Effort Setup for OMP

## Objective

Make OMP reasoning controls work for the local Qwen model served from `z.local:8001`:

- `off` must hard-disable thinking.
- `low`, `medium`, and `xhigh` must reach Qwen as actual reasoning-effort values.
- The configuration must support both the vLLM and llama.cpp server variants used on `z.local`.

The OMP model configuration is stored at:

```text
~/.omp/agent/models.yml
```

## Why the initial configuration failed

The initial custom model only declared:

```yaml
compat:
  supportsReasoningEffort: true
```

That declaration makes OMP send OpenAI-style `reasoning_effort` values for enabled reasoning, but it does not necessarily provide a real disable operation.

For Qwen, omitting `reasoning_effort` is not equivalent to turning thinking off. The Qwen template defaults to thinking enabled and, for the model inspected on `z.local`, defaults the missing effort to `xhigh`. As a result, selecting `off` in OMP could still produce a reasoning block.

The important distinction is:

- Enabled reasoning needs an effort value such as `low`, `medium`, or `xhigh`.
- Disabled reasoning needs an explicit server-specific switch.

## Server and template investigation

The active model endpoint was checked with:

```bash
curl -sS http://z.local:8001/v1/models
```

The vLLM model was served as model ID `local` from:

```text
/home/zarathustra/models/qwen38-fp8
```

The Qwen chat template at:

```text
/home/zarathustra/models/qwen38-fp8/chat_template.jinja
```

showed two relevant behaviors:

1. When thinking is enabled, `reasoning_effort` defaults to `xhigh` if it is absent.
2. Thinking is hard-disabled only when `enable_thinking` is explicitly `false`, which causes the template to prefill an empty thinking block.

OMP 17.3.4 supports multiple OpenAI-compatible reasoning encodings:

- `thinkingFormat: openai` sends top-level `reasoning_effort`.
- `thinkingFormat: qwen-chat-template` sends `chat_template_kwargs.enable_thinking`.
- `whenThinking` applies a different compatibility format only when reasoning is enabled.

This allows disabled and enabled requests to use different wire formats without losing effort levels.

## vLLM configuration

The `zlocal/local` model uses the Qwen chat-template switch as its baseline and switches back to OpenAI effort encoding for enabled reasoning:

```yaml
providers:
  zlocal:
    baseUrl: http://z.local:8001/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
    modelOverrides:
      local:
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, xhigh]
          defaultLevel: xhigh
        input: [text, image]
        compat:
          supportsReasoningEffort: true
          thinkingFormat: qwen-chat-template
          whenThinking:
            thinkingFormat: openai
```

The resulting vLLM requests are:

| OMP setting | Effective request control |
| --- | --- |
| `off` | `chat_template_kwargs.enable_thinking: false` |
| `low` | `reasoning_effort: low` |
| `medium` | `reasoning_effort: medium` |
| `xhigh` | `reasoning_effort: xhigh` |

The `whenThinking` override is essential. Using only `qwen-chat-template` would provide a correct binary on/off switch but would stop sending the effort value. Using only `openai` would preserve effort values but would not hard-disable Qwen when OMP selected `off`.

## llama.cpp investigation

The llama.cpp server source running on `z.local` was inspected at revision:

```text
4df29be4f4c3673f428170fda944a5b19f743bb8
```

In `tools/server/server-common.cpp`, llama.cpp performs the following request translation:

- A non-empty top-level `reasoning_effort` is copied into the chat-template arguments.
- `reasoning_effort: none` sets `enable_thinking` to `false`.

Therefore, llama.cpp does not need the split vLLM configuration. It supports the OpenAI effort field directly, including the special `none` disable value.

## llama.cpp configuration

The dedicated `llama.cpp/local` model is configured as:

```yaml
providers:
  llama.cpp:
    baseUrl: http://z.local:8001/v1
    auth: none
    api: openai-completions
    models:
      - id: local
        name: Qwen3.8 27B Q4 (llama.cpp)
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, xhigh]
          defaultLevel: xhigh
        input: [text, image]
        contextWindow: 65536
        maxTokens: 32768
        compat:
          supportsReasoningEffort: true
          thinkingFormat: openai
          reasoningDisableMode: none-effort
```

The resulting llama.cpp requests are:

| OMP setting | Effective request control |
| --- | --- |
| `off` | `reasoning_effort: none` |
| `low` | `reasoning_effort: low` |
| `medium` | `reasoning_effort: medium` |
| `xhigh` | `reasoning_effort: xhigh` |

Without `reasoningDisableMode: none-effort`, OMP maps `off` to the lowest supported effort on a generic OpenAI-compatible endpoint. That reduces reasoning but does not disable it.

## Behavioral verification

### vLLM hard-disable check

```bash
omp -p --model zlocal/local --thinking off --no-tools --no-session \
  --print-thoughts --max-time 2m "Reply with exactly: OK"
```

Before the fix, the output included reasoning before `OK`. After the fix, it contained no reasoning text:

```text
Working...
OK
```

The enabled-effort path was checked with `--thinking low`. Qwen reported that it had received the low-effort instruction and returned `low`.

### llama.cpp hard-disable check

```bash
omp -p --model llama.cpp/local --thinking off --no-tools --no-session \
  --print-thoughts --max-time 2m "Reply with exactly: OK"
```

Observed output:

```text
Working...
OK
```

No reasoning text was emitted.

### llama.cpp effort checks

The enabled path was exercised with `low`, `medium`, and `xhigh`.

- `low` reported the low-effort instruction and answered `low`.
- `xhigh` reported the xhigh-effort instruction and answered `xhigh`.
- `medium` did not expose an explicit effort label. This matches the inspected Qwen template: medium is its baseline behavior, while low and xhigh inject explicit behavioral instructions.

Representative command:

```bash
omp -p --model llama.cpp/local --thinking low --no-tools --no-session \
  --print-thoughts --max-time 2m \
  "What reasoning effort were you instructed to use? Reply with only the level."
```

## Current vLLM runtime details

The current vLLM process on `z.local` loads the FP8 model and uses an FP8 E4M3 KV cache:

```text
/home/zarathustra/models/qwen38-fp8
--kv-cache-dtype fp8_e4m3
```

This is independent of the reasoning-control fix but identifies the runtime against which the vLLM configuration applies.

## Operational notes

- Use `zlocal/local` while the endpoint is running vLLM.
- Use `llama.cpp/local` while the endpoint is running llama.cpp.
- OMP and the model server do not need to be restarted after editing `models.yml`.
- Start a new OMP process or reselect the model so OMP reloads the updated model specification.
- Do not treat an omitted reasoning parameter as `off`; Qwen defaults to thinking when no explicit disable control is present.
