import { useLayoutEffect, useRef, useState } from "react";
import type { ChromeCapsuleModel, ChromeOverlayCommand } from "../shared/chromeOverlay";
import "./styles/context-chat-capsule.css";

/** Shared rendering only. The native website surface has no general Wuu API. */
export function ContextChatCapsuleSurface({ model, send }: { model: ChromeCapsuleModel; send: (command: ChromeOverlayCommand) => void }): JSX.Element {
  const [draft, setDraft] = useState(model.draft);
  const input = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  const composing = useRef(false);
  const previousBusy = useRef(model.busy);
  useLayoutEffect(() => {
    if (!focused.current || previousBusy.current && !model.busy && !model.error) setDraft(model.draft);
    previousBusy.current = model.busy;
  }, [model.draft, model.busy, model.error]);
  const collapse = () => { send({ type: "capsule-collapse", text: draft }); input.current?.blur(); };
  return <div data-context-capsule className={`context-chat-capsule${model.expanded ? " expanded" : ""}`}
    onPointerEnter={() => { if (!model.expanded) send({ type: "capsule-expand" }); }}
    onPointerLeave={() => { if (!focused.current && !model.busy) collapse(); }}
    onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); collapse(); } }}>
    <form className="context-chat-capsule-row" onSubmit={event => { event.preventDefault(); if (!composing.current && draft.trim() && !model.busy) send({ type: "capsule-send", text: draft }); }}>
      <button type="button" className="context-chat-capsule-ball" aria-label={model.label} title={model.sourceTitle}
        onClick={() => { send({ type: "capsule-expand" }); requestAnimationFrame(() => input.current?.focus()); }}>
        <span aria-hidden="true">W</span>
      </button>
      {model.expanded && <>
        <input ref={input} value={draft} maxLength={8000} aria-label={model.placeholder} placeholder={model.placeholder}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onFocus={() => { focused.current = true; }}
          onBlur={() => { focused.current = false; send({ type: "capsule-draft", text: draft }); }}
          onChange={event => { setDraft(event.target.value); send({ type: "capsule-draft", text: event.target.value }); }}
          disabled={model.busy} />
        <button type="submit" className="context-chat-capsule-send" aria-label={model.sendLabel} disabled={model.busy || !draft.trim()}>
          {model.busy ? <span className="context-chat-capsule-busy" aria-label={model.sendLabel} /> : <span aria-hidden="true">↑</span>}
        </button>
      </>}
    </form>
    {model.expanded && (model.error || model.sessionId) && <div className="context-chat-capsule-status">
      <span role={model.error ? "alert" : "status"} title={model.error ?? model.sourceTitle}>{model.error ?? model.sourceTitle}</span>
      {model.sessionId && <button type="button" onClick={() => send({ type: "capsule-open" })}>{model.openLabel} ↗</button>}
    </div>}
  </div>;
}
