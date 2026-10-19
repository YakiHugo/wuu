import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { closestCenter, DndContext, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Globe, Pin, PinOff, Plus, RotateCw, X } from "./WuuIcons";
import { readFocusModality } from "./FocusModality";
import { HoverRevealScopeContext } from "./HoverReveal";
import {
  readNavigationRibbonPreferences,
  saveNavigationRibbonPreferences,
  saveRibbonOrder,
  useNavigationRibbonPreferences,
  type RibbonWebsite,
} from "./NavigationRibbonPreferences";
import { SidebarPointerSensor } from "./SidebarPointerSensor";
import { useSortableTransition } from "./SortableMotion";
import { ThreadContextMenu } from "./ThreadContextMenu";
import { showActionErrorToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { useI18n } from "./i18n";
import { WebsiteIcon } from "./WebsiteIcon";

export interface NavigationRibbonItem {
  id: string;
  title: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  pinned?: boolean;
  component?: string;
  pluginId?: string;
  onSelect: () => void;
  onClose?: () => void;
}

export interface RibbonBrowserActions {
  websites?: RibbonWebsite[];
  onNewTab?: () => void;
  onCloseTab?: (id: string) => void;
  onPinTab?: (id: string, pinned: boolean) => void;
  onReorderTabs?: (ids: string[]) => void;
}

function RibbonDestination({ item, onMove, onMenu, nativeTooltip }: {
  item: NavigationRibbonItem;
  onMove: (direction: -1 | 1) => void;
  nativeTooltip: boolean;
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
      <Tooltip content={item.title} disabled={isDragging} native={nativeTooltip}>
        <button
          {...attributes}
          {...listeners}
          ref={setActivatorNodeRef}
          type="button"
          className={`sidebar-ribbon-button${item.pluginId ? " plugin-navigation-item" : ""}${item.active ? " active" : ""}`}
          aria-label={item.title}
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
      {item.onClose ? <Tooltip content={t("webWorkspace.closeTab", { title: item.title })} disabled={isDragging} native={nativeTooltip}>
        <button type="button" className="sidebar-ribbon-close" data-ribbon-close-id={item.id}
          aria-label={t("webWorkspace.closeTab", { title: item.title })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); item.onClose?.(); }}>
          <X aria-hidden="true" />
        </button>
      </Tooltip> : null}
    </div>
  );
}

export function NavigationRibbon({ items, websites = [], activeWebsiteId, onSelectWebsite, onNewTab, onCloseTab, onPinTab, onReorderTabs, footer, ribbonRef }: {
  items: NavigationRibbonItem[];
  activeWebsiteId?: string | null;
  onSelectWebsite?: (website: RibbonWebsite) => void;
  footer?: ReactNode;
  ribbonRef?: Ref<HTMLElement>;
} & RibbonBrowserActions): JSX.Element {
  const { t } = useI18n();
  const preferences = useNavigationRibbonPreferences();
  const [announcement, setAnnouncement] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [keyboardFocusWithin, setKeyboardFocusWithin] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [retainedLayers, setRetainedLayers] = useState(0);
  const retainLayer = useCallback(() => {
    setRetainedLayers((count) => count + 1);
    return () => setRetainedLayers((count) => count - 1);
  }, []);
  const sensors = useSensors(useSensor(SidebarPointerSensor, { activationConstraint: { distance: 6 } }));
  const destinations: NavigationRibbonItem[] = [
    ...items,
    ...websites.map((website): NavigationRibbonItem => ({
      id: website.id,
      title: website.url === "about:blank" && website.startPage !== false ? t("webWorkspace.newTab") : website.title || website.url,
      icon: website.loading ? <RotateCw className="sidebar-ribbon-tab-loading" aria-hidden="true" /> : <WebsiteIcon url={website.url} favicon={website.favicon} fallback={<span className="sidebar-ribbon-website-icon" aria-hidden="true">{website.url === "about:blank" && website.startPage !== false ? <Globe /> : Array.from(website.title)[0]?.toLocaleUpperCase() || <Globe />}</span>} />,
      active: activeWebsiteId === website.id,
      disabled: !onSelectWebsite,
      pinned: website.pinned,
      component: "website-navigation-item",
      onSelect: () => onSelectWebsite?.(website),
      onClose: onCloseTab ? () => closeWebsite(website.id) : undefined,
    })),
  ];
  const availableIDs = JSON.stringify(destinations.map((item) => item.id));
  useEffect(() => {
    const ids = JSON.parse(availableIDs) as string[];
    const current = readNavigationRibbonPreferences();
    const additions = ids.filter((id) => !current.order.includes(id));
    if (!additions.length) return;
    try { saveNavigationRibbonPreferences({ ...current, order: [...current.order, ...additions] }); }
    catch (saveError) { showActionErrorToast(saveError, t("ribbon.saveFailed")); }
  }, [availableIDs, t]);
  const destinationByID = new Map(destinations.map((item) => [item.id, item]));
  const orderedIDs = [...preferences.order.filter((id) => destinationByID.has(id)),
    ...destinations.map((item) => item.id).filter((id) => !preferences.order.includes(id))];
  const ordered = orderedIDs.map((id) => destinationByID.get(id)!);
  const websiteIDs = new Set(websites.map((website) => website.id));
  const browserOrder = JSON.stringify(orderedIDs.filter((id) => websiteIDs.has(id)));
  useEffect(() => {
    // Native Ctrl+Tab and number shortcuts follow the same order as the ribbon.
    const ids = JSON.parse(browserOrder) as string[];
    if (ids.length) onReorderTabs?.(ids);
  }, [browserOrder, onReorderTabs]);
  useLayoutEffect(() => {
    if (!activeWebsiteId) return;
    [...document.querySelectorAll<HTMLButtonElement>(".sidebar-ribbon-button[data-ribbon-id]")]
      .find((button) => button.dataset.ribbonId === activeWebsiteId)?.scrollIntoView({ block: "nearest" });
  }, [activeWebsiteId]);

  function reorder(id: string, destination: string): void {
    const from = orderedIDs.indexOf(id);
    const to = orderedIDs.indexOf(destination);
    if (from < 0 || to < 0 || from === to) return;
    try {
      saveRibbonOrder(arrayMove(orderedIDs, from, to));
      setAnnouncement(t("ribbon.moved", { name: destinationByID.get(id)!.title, position: to + 1, count: orderedIDs.length }));
    } catch (saveError) {
      showActionErrorToast(saveError, t("ribbon.saveFailed"));
    }
  }

  function move(id: string, direction: -1 | 1): void {
    const target = orderedIDs[orderedIDs.indexOf(id) + direction];
    if (target) reorder(id, target);
  }

  function focusRibbonItem(id: string | undefined): void {
    [...document.querySelectorAll<HTMLButtonElement>(".sidebar-ribbon-button[data-ribbon-id]")]
      .find((button) => button.dataset.ribbonId === id)?.focus();
  }

  function closeWebsite(id: string): void {
    const index = orderedIDs.indexOf(id);
    const next = orderedIDs[index + 1] ?? orderedIDs[index - 1];
    focusRibbonItem(next);
    onCloseTab?.(id);
  }

  const menuWebsite = menu && websites.find((website) => website.id === menu.id);
  const expanded = pointerInside || keyboardFocusWithin || dragging || Boolean(menuWebsite) || retainedLayers > 0;
  return <>
    <HoverRevealScopeContext.Provider value={{ disabled: false, retain: retainLayer }}>
    <nav ref={ribbonRef} className="sidebar-ribbon" aria-label={t("sidebar.mainNavigation")}
      data-expanded={expanded || undefined}
      data-wuu-layer={expanded ? "popover" : undefined}
      onPointerOver={(event) => {
        if (event.currentTarget.contains(event.target as Node)) setPointerInside(true);
      }}
      onPointerOut={(event) => {
        if (event.currentTarget.contains(event.target as Node)
          && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) setPointerInside(false);
      }}
      onPointerDownCapture={() => setKeyboardFocusWithin(false)}
      onFocus={() => setKeyboardFocusWithin(readFocusModality() === "keyboard")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocusWithin(false);
      }}
      onKeyDownCapture={() => setKeyboardFocusWithin(true)}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]}
        accessibility={{ screenReaderInstructions: { draggable: t("ribbon.reorderHint") } }}
        onDragStart={() => setDragging(true)}
        onDragCancel={() => setDragging(false)}
        onDragEnd={({ active, over }) => { setDragging(false); if (over) reorder(String(active.id), String(over.id)); }}>
        <div className="sidebar-ribbon-main scrollbar-hidden">
          <SortableContext items={orderedIDs} strategy={verticalListSortingStrategy}>
            {ordered.map((item) => <RibbonDestination key={item.id} item={item} nativeTooltip={Boolean(activeWebsiteId)}
              onMove={(direction) => move(item.id, direction)}
              onMenu={websiteIDs.has(item.id) ? (x, y) => setMenu({ id: item.id, x, y }) : undefined} />)}
          </SortableContext>
          <Tooltip content={t("webWorkspace.newTab")} native={Boolean(activeWebsiteId)}>
            <button type="button" className="sidebar-ribbon-button sidebar-ribbon-add" aria-label={t("webWorkspace.newTab")}
              disabled={!onNewTab} onClick={onNewTab}>
              <Plus aria-hidden="true" /><span className="sidebar-ribbon-label">{t("webWorkspace.newTab")}</span>
            </button>
          </Tooltip>
        </div>
      </DndContext>
      {footer ? <div className="sidebar-ribbon-footer">{footer}</div> : null}
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </nav>
    </HoverRevealScopeContext.Provider>
    {menu && menuWebsite ? <ThreadContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
      { label: t(menuWebsite.pinned ? "webWorkspace.unpinTab" : "webWorkspace.pinTab"), icon: menuWebsite.pinned ? <PinOff /> : <Pin />, onSelect: () => { focusRibbonItem(menuWebsite.id); onPinTab?.(menuWebsite.id, !menuWebsite.pinned); } },
      { label: t("webWorkspace.closeCurrentTab"), icon: <X />, onSelect: () => closeWebsite(menuWebsite.id) },
    ]} /> : null}
  </>;
}
