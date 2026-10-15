// Policy stays in the plugin. The host owns focus, keyboard priority, ghost
// rendering, revisions, and cancellation of the public completion provider.
export async function activate(api) {
  const React = api.react;
  const h = React.createElement;
  const { Page, Section, Stack, Row, Button } = api.ui;
  const turns = new Map();
  const observations = new Map();
  let workspaces = [];
  let disposed = false;
  const keyFor = (root, thread) => JSON.stringify([root, thread]);
  const registered = (root, id) => workspaces.some((workspace) => workspace.available
    && workspace.root === root && (id === undefined || workspace.id === id));
  function invalidate(key) {
    const previous = turns.get(key);
    previous?.controller?.abort();
    turns.delete(key);
  }
  function invalidateRoot(root) {
    for (const [key, value] of turns) if (value.root === root) invalidate(key);
  }
  try { workspaces = (await api.listWorkspaces()).workspaces; } catch { /* Missing workspace access means no prediction. */ }
  api.signal.throwIfAborted();
  api.onHostEvent((event) => {
    if (disposed) return;
    if (event?.kind === "connection-reset") {
      for (const key of turns.keys()) invalidate(key);
      observations.clear(); provider.refresh(); return;
    }
    if (typeof event?.workdir !== "string" || event.replayed === true) return;
    const root = event.workdir;
    if (event.kind === "server-exit" || event.kind === "server-error") {
      invalidateRoot(root); provider.refresh(); return;
    }
    if (event.kind !== "notification") return;
    const { method, params } = event.message ?? {};
    // History restoration and reconnect must never masquerade as live success.
    if (method === "thread/resumed") { invalidateRoot(root); provider.refresh(); return; }
    const threadId = params?.thread_id;
    if (typeof threadId !== "string") return;
    const key = keyFor(root, threadId);
    const turn = params.turn;
    if (method === "turn/started") {
      if (typeof turn?.id !== "string" || turns.get(key)?.turnId === turn.id) return;
      invalidate(key);
      const candidates = workspaces.filter((workspace) => workspace.available && workspace.root === root);
      // Root-only host events cannot prove a late retired runtime belongs to a
      // newly registered ID. Prefer the existing registration; disagreement
      // with the visible composer must abstain rather than reattribute text.
      const workspaceId = candidates.length === 1 ? candidates[0].id : observations.get(key)?.workspaceId;
      turns.set(key, { root, workspaceId, threadId, turnId: turn.id, state: "running" });
      // Keep only live, recent identities. Evicted completions cannot re-arm
      // themselves: a matching start is always required.
      while (turns.size > 128) invalidate(turns.keys().next().value);
    } else if (method === "turn/error") {
      invalidate(key); provider.refresh();
    } else if (method === "turn/completed") {
      const current = turns.get(key);
      if (!current || current.state !== "running" || current.turnId !== turn?.id) return;
      current.state = "spent";
      const text = visibleTurnText(turn);
      if (text) { current.state = "ready"; current.text = text; }
      // A completion notification can also change the host's running revision.
      // Refresh only the observation seen before the event: an unscoped delayed
      // refresh would abort the request that the new idle revision just started.
      const observed = observations.get(key);
      if (observed) provider.refresh({ composerId: observed.composerId, revision: observed.revision });
    }
  });
  const provider = api.registerComposerInlineCompletionProvider({
    id: "next-message",
    async provideCompletion(context, signal) {
      if (context.kind === "main" && context.workspaceRoot && context.threadId) {
        const observationKey = keyFor(context.workspaceRoot, context.threadId);
        const observation = { composerId: context.composerId, revision: context.revision, workspaceId: context.workspaceId };
        observations.set(observationKey, observation);
        while (observations.size > 128) observations.delete(observations.keys().next().value);
        signal.addEventListener("abort", () => {
          if (observations.get(observationKey) === observation) observations.delete(observationKey);
        }, { once: true });
      }
      if (disposed || signal.aborted || context.kind !== "main" || context.sideThreadId
        || context.running || context.draftText !== "" || !context.threadId
        || !context.workspaceId || !context.workspaceRoot
        || context.attachmentCount !== 0 || context.queuedCount !== 0 || context.pendingCount !== 0) return null;
      const key = keyFor(context.workspaceRoot, context.threadId);
      const current = turns.get(key);
      if (current?.state !== "ready" || current.workspaceId !== context.workspaceId) return null;
      // Consumed before any await: focus, a second pane, null, errors and abort
      // never purchase another attempt for this source turn.
      current.state = "spent";
      const text = current.text;
      delete current.text;
      const controller = new AbortController();
      current.controller = controller;
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const latest = await api.listWorkspaces();
        if (disposed || signal.aborted || controller.signal.aborted || turns.get(key) !== current) return null;
        workspaces = latest.workspaces;
        if (!registered(context.workspaceRoot, context.workspaceId)) return null;
        const result = await api.invokeRuntime("next-message.predict", {
          threadId: context.threadId, turnId: current.turnId, ...text,
        }, { workspaceId: context.workspaceId, signal: controller.signal });
        if (disposed || signal.aborted || controller.signal.aborted || turns.get(key) !== current) return null;
        const suggestion = validSuggestion(result);
        return suggestion === null ? null : { id: JSON.stringify([context.workspaceId, context.threadId, current.turnId]), text: suggestion };
      } catch {
        // Optional predictions never interrupt composition or expose model text
        // through diagnostics. The runtime owns bounded inference and usage.
        return null;
      } finally {
        signal.removeEventListener("abort", abort);
        if (current.controller === controller) delete current.controller;
      }
    },
  });
  api.registerCleanup(() => {
    disposed = true;
    observations.clear();
    for (const key of turns.keys()) invalidate(key);
  });
  api.registerLocale({ id: "next-message-en", locale: "en-US", entries: {
    "nextMessage.title": "Next message",
    "nextMessage.help": "After a successful live reply, predict one optional message in an empty composer. Tab inserts it without sending; Escape dismisses it.",
    "nextMessage.model": "Model alias", "nextMessage.inherit": "Workspace model (may be expensive)",
    "nextMessage.data": "When enabled, this plugin sends only the current completed turn’s user text and final answer to the selected provider. It does not send unsent drafts, attachments, tool output, reasoning, or earlier history. It uses no tools and creates no private session.",
    "nextMessage.cost": "One attempt per eligible turn: up to 4 seconds, 128 output tokens and 8 KiB of input including the prompt. Cancellation may still incur provider charges. Choose a configured fast, low-cost model alias; leaving this blank inherits the workspace model.",
    "nextMessage.scope": "Registered workspaces only, including split panes. Side chats, failed or interrupted replies, incomplete or attachment-based turns are skipped. Suggestions can be wrong; review before sending.",
    "nextMessage.workspaceRequired": "Choose a registered workspace before configuring suggestions.",
    "nextMessage.workspaceChanged": "The workspace changed. Reopen these settings before saving.",
    "nextMessage.save": "Save changes", "nextMessage.saved": "Saved",
  } });
  api.registerLocale({ id: "next-message-zh", locale: "zh-CN", entries: {
    "nextMessage.title": "下一句建议",
    "nextMessage.help": "正常完成回复后，在空输入框中预测一条可选消息。Tab 只填入草稿，Escape 取消建议。",
    "nextMessage.model": "模型别名", "nextMessage.inherit": "工作区模型（可能费用较高）",
    "nextMessage.data": "启用后，仅把当前已完成轮次的用户文字和最终回复发送给所选模型提供商。不发送未提交草稿、附件、工具输出、推理或更早历史；不调用工具，也不创建私有会话。",
    "nextMessage.cost": "每个符合条件的轮次最多尝试一次：4 秒、128 个输出 token，含提示词的输入不超过 8 KiB。取消后仍可能产生提供商费用。可填写已配置的低价快速模型别名；留空会继承工作区模型。",
    "nextMessage.scope": "仅支持已注册工作区，包括分屏。侧会话、失败或中断的回复、内容不完整或依赖附件的轮次会跳过。建议可能不准确，发送前请确认。",
    "nextMessage.workspaceRequired": "请先选择已注册工作区，再配置下一句建议。",
    "nextMessage.workspaceChanged": "工作区已变化，请重新打开此设置页后再保存。",
    "nextMessage.save": "保存更改", "nextMessage.saved": "已保存",
  } });
  function Settings({ translate: tr }) {
    const [alias, setAlias] = React.useState(null);
    const [workspaceId, setWorkspaceId] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [saved, setSaved] = React.useState(false);
    React.useEffect(() => {
      const controller = new AbortController();
      void (async () => {
        const snapshot = await api.listWorkspaces();
        const workspace = snapshot.workspaces.find((entry) => entry.id === snapshot.activeWorkspaceId && entry.available);
        if (!workspace) throw new Error(tr("nextMessage.workspaceRequired"));
        const value = await api.invokeRuntime("next-message.get", {}, { workspaceId: workspace.id, signal: controller.signal });
        if (!controller.signal.aborted) { setWorkspaceId(workspace.id); setAlias(value.settings.model_alias ?? ""); }
      })().catch((reason) => { if (!controller.signal.aborted) setError(String(reason)); });
      return () => controller.abort();
    }, []);
    async function save() {
      setBusy(true); setError(""); setSaved(false);
      try {
        const snapshot = await api.listWorkspaces();
        if (snapshot.activeWorkspaceId !== workspaceId || !snapshot.workspaces.some((entry) => entry.id === workspaceId && entry.available)) {
          throw new Error(tr("nextMessage.workspaceChanged"));
        }
        const value = await api.invokeRuntime("next-message.update", { model_alias: alias }, { workspaceId });
        setAlias(value.settings.model_alias ?? ""); setSaved(true);
        // A settings change does not retry old turns or preserve old results.
        for (const key of turns.keys()) invalidate(key);
        provider.refresh();
      } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
    }
    return h(Page, null, h(Stack, { gap: "large" },
      h(Section, { title: tr("nextMessage.title"), description: tr("nextMessage.help") },
        h("p", null, tr("nextMessage.data")), h("p", null, tr("nextMessage.cost")), h("p", null, tr("nextMessage.scope")),
        h("label", { className: "plugin-ui-field" }, h("span", { className: "plugin-ui-field-label" }, tr("nextMessage.model")),
          h("input", { className: "plugin-ui-input", value: alias ?? "", disabled: busy || alias === null,
            placeholder: tr("nextMessage.inherit"), onChange: (event) => { setAlias(event.target.value); setSaved(false); } }))),
      h(Row, null, h(Button, { variant: "primary", disabled: busy || alias === null, onClick: () => void save() }, tr("nextMessage.save")),
        saved ? h("span", { role: "status" }, tr("nextMessage.saved")) : null,
        error ? h("span", { role: "alert" }, error) : null)));
  }
  api.registerViewType({ id: "next-message.settings", title: "Next message", icon: "message-square",
    defaultRegion: "settings", persistence: "durable", render: (props) => h(Settings, props) });
}

function visibleTurnText(turn) {
  if (turn.status !== "completed" || (turn.kind !== undefined && turn.kind !== "user")
    || turn.error || turn.truncated || (turn.finish_reason && turn.finish_reason !== "stop")
    || turn.items_view !== "full" || !Array.isArray(turn.items) || turn.items.some((item) => !item || typeof item !== "object")) return null;
  const users = turn.items.filter((item) => item.type === "user_message");
  if (!users.length || users.some((item) => !completeText(item) || item.read_only
    || (item.origin && item.origin !== "user") || item.cause || item.presentation_kind)) return null;
  const answer = turn.items.filter((item) => item.type === "agent_message" && item.terminal === true).at(-1);
  if (!answer || !completeText(answer)) return null;
  return { userText: users.map((item) => item.text).join("\n"), assistantText: answer.text };
}

function completeText(item) {
  return !item.hidden && !item.remote_content_ref && !item.truncated && !item.error
    && (item.status === undefined || item.status === "completed")
    && (!item.finish_reason || item.finish_reason === "stop")
    && typeof item.text === "string" && Boolean(item.text.trim())
    && [item.images, item.files].every((value) => value === undefined || (Array.isArray(value) && value.length === 0))
    && (item.content_parts === undefined || (Array.isArray(item.content_parts) && item.content_parts.every((part) => part?.type === "text")));
}

function validSuggestion(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).length !== 1 || typeof result.suggestion !== "string") return null;
  const text = result.suggestion.trim();
  if (!text || [...text].length > 240 || /[\p{Cc}\u2028\u2029]/u.test(text)) return null;
  return text;
}
