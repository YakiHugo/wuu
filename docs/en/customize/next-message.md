# Next-message suggestions

The optional **Next message** plugin predicts one message you might type after a successful live reply. It is installed but disabled by default. Enable it in **Settings → Extensions**, then open its settings page to choose a configured model alias.

The suggestion appears as gray text inside an empty, focused composer. **Tab** inserts it into the draft without sending; you can edit it before sending. **Escape** dismisses it. Typing, changing focus or conversation, starting another turn, or disabling the plugin cancels pending work and prevents stale results from entering the draft. Slash commands and menus retain keyboard priority. No suggestion leaves ordinary Tab navigation unchanged.

## Model, data and cost

A blank model alias inherits the workspace's configured model; it does not select a dedicated cheap model. Choose an existing fast, low-cost alias when appropriate. An unavailable alias produces no suggestion and does not fall back silently.

Each eligible turn makes at most one attempt. The request allows up to 4 seconds, 128 output tokens, and 8 KiB of UTF-8 input including the prediction prompt and JSON encoding. Oversized context is skipped rather than cut mid-message. Provider charges can still apply after cancellation. The plugin may return no suggestion even on success.

Only the current completed turn's displayed user text and final assistant answer are sent to the configured provider. Earlier history, unsent drafts, attachments, tool output and reasoning are excluded. The plugin creates no private session, uses no tools, and does not read or write a notebook. Only the model alias is persisted; source text is not saved by the plugin. Ordinary host/provider usage accounting still applies.

## When it runs

The plugin must observe a matching live start and successful completion while enabled. Restoring an old conversation or enabling/reloading the plugin after completion does not trigger prediction. Failed, interrupted, internal, generated, incomplete and attachment-based source turns are skipped. The composer must have exactly empty text and no attachments, queued messages or pending input.

Registered workspaces and split panes are supported; side chats and no-project conversations are skipped. Workspace ID, event-routing root, thread and source-turn identities must match. Input changes abort the original promise through the runtime/model service; refocusing does not retry an attempted turn. Recent identities are kept only in memory, so deduplication is scoped to a running plugin generation.

This initial policy deliberately uses one turn to bound cost and avoid confusing visible history with the physical audit log. It can miss preferences or earlier context, and suggestions can be wrong. Synthetic tests verify behavior and cancellation, not real-model suggestion quality.
