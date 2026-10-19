import type { CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pin, X } from "./WuuIcons";
import { useSortableTransition } from "./SortableMotion";
import { Tooltip } from "./Tooltip";
import { useI18n } from "./i18n";
import type { NavigationRibbonItem } from "./NavigationRibbon";

export function RibbonDestination({ item, onMove, onMenu, nativeTooltip, boundedNative = false }: {
  item: NavigationRibbonItem;
  onMove: (direction: -1 | 1) => void;
  nativeTooltip: boolean;
  boundedNative?: boolean;
  onMenu?: (x: number, y: number) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    transition: useSortableTransition(),
  });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style}
      className={`sidebar-ribbon-tab-row${item.active ? " active" : ""}${item.onClose ? " closable" : ""}`}
      data-dragging={isDragging || undefined}>
      <Tooltip content={item.title} disabled={isDragging || boundedNative} native={nativeTooltip}>
        <button
          {...attributes}
          {...listeners}
          ref={setActivatorNodeRef}
          type="button"
          className={`sidebar-ribbon-button${item.pluginId ? " plugin-navigation-item" : ""}${item.active ? " active" : ""}`}
          aria-label={item.title}
          title={boundedNative && !isDragging ? item.title : undefined}
          aria-current={item.active ? "page" : undefined}
          aria-disabled={item.disabled || undefined}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          aria-haspopup={onMenu ? "menu" : undefined}
          data-ribbon-id={item.id}
          data-wuu-component={item.component}
          data-wuu-plugin={item.pluginId}
          data-pinned={item.pinned || undefined}
          data-dragging={isDragging || undefined}
          onClick={() => { if (!item.disabled) item.onSelect(); }}
          onAuxClick={(event) => {
            if (event.button === 1 && item.onClose) { event.preventDefault(); item.onClose(); }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!onMenu) return;
            event.currentTarget.focus();
            onMenu(event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              event.stopPropagation();
              onMove(event.key === "ArrowUp" ? -1 : 1);
            } else if (onMenu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu(rect.right, rect.top);
            } else if (event.key === "Delete" && item.onClose) {
              event.preventDefault();
              item.onClose();
            }
          }}
        >
          {item.icon}
          <span className="sidebar-ribbon-label">{item.title}</span>
          {item.pinned ? <Pin className="sidebar-ribbon-pin" aria-hidden="true" /> : null}
        </button>
      </Tooltip>
      {item.onClose ? <Tooltip content={t("webWorkspace.closeTab", { title: item.title })} disabled={isDragging || boundedNative} native={nativeTooltip}>
        <button type="button" className="sidebar-ribbon-close" data-ribbon-close-id={item.id}
          aria-label={t("webWorkspace.closeTab", { title: item.title })}
          title={boundedNative ? t("webWorkspace.closeTab", { title: item.title }) : undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); item.onClose?.(); }}>
          <X aria-hidden="true" />
        </button>
      </Tooltip> : null}
    </div>
  );
}
