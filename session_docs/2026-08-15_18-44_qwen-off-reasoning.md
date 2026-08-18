# Qwen `off` Reasoning Fix

## What was wrong

The custom `zlocal/local` model in `~/.omp/agent/models.yml` advertised Qwen reasoning effort levels and enabled OpenAI-compatible `reasoning_effort` handling:

```yaml
compat:
  supportsReasoningEffort: true
```

This correctly supported `low`, `medium`, and `xhigh`, but it did not provide Qwen with a real disable switch. When OMP used `--thinking off`, it omitted `reasoning_effort`. The Qwen chat template treats an omitted reasoning setting as thinking enabled and defaults its effort to `xhigh`.

The failure was reproduced with:

```bash
omp -p --model zlocal/local --thinking off --no-tools --no-session \
  --print-thoughts --max-time 2m "Reply with exactly: OK"
```

Before the fix, the output exposed a reasoning block before the answer:

```text
Working...
The user wants me to reply with exactly "OK".
OK
```

## Debug process

1. Read `~/.omp/agent/models.yml` and confirmed that the custom provider used `openai-completions` with `supportsReasoningEffort: true`, but no Qwen-specific disable encoding.
2. Confirmed that `http://z.local:8001/v1/models` serves model ID `local` through vLLM from `/home/zarathustra/models/qwen38-fp8`.
3. Inspected the running vLLM command on `z.local`. It uses the Qwen reasoning parser and serves the model on port 8001.
4. Inspected the model's `chat_template.jinja`. It defaults `reasoning_effort` to `xhigh` while thinking is enabled. It only hard-suppresses reasoning when `enable_thinking` is explicitly `false`.
5. Inspected OMP 17.3.4 request shaping. The `qwen-chat-template` format sends `chat_template_kwargs.enable_thinking: false` for disabled reasoning. OMP's `whenThinking` compatibility override can switch enabled requests back to the OpenAI format so their `reasoning_effort` value remains intact.

## Final fix

Updated `~/.omp/agent/models.yml`:

```yaml
compat:
  supportsReasoningEffort: true
  # vLLM/Qwen needs an explicit chat-template switch for "off".
  # Thinking requests keep the OpenAI effort field used by this template.
  thinkingFormat: qwen-chat-template
  whenThinking:
    thinkingFormat: openai
```

The resulting request behavior is:

- `--thinking off` sends `chat_template_kwargs.enable_thinking: false`.
- `--thinking low`, `medium`, or `xhigh` continues sending the corresponding OpenAI-compatible `reasoning_effort` value.

No OMP or vLLM restart was required. Each new OMP process reloads the model configuration.

## Verification

Repeated the original reproduction after the change. The output contained no reasoning text:

```text
Working...
OK
```

Also verified that the existing effort behavior remained active:

```bash
omp -p --model zlocal/local --thinking low --no-tools --no-session \
  --print-thoughts --max-time 2m \
  "What reasoning effort were you instructed to use? Reply with only the level."
```

Qwen's reasoning explicitly reported that the system prompt set the effort to `low`, and the final response was:

```text
low
```

## Key findings

- Omitting an effort value is not equivalent to disabling thinking for this Qwen template.
- Qwen served through vLLM requires the chat-template argument `enable_thinking: false` for hard suppression.
- A baseline `qwen-chat-template` format combined with an OpenAI `whenThinking` override preserves both behaviors: a real `off` switch and the existing effort levels.
