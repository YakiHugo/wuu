import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { closestCenter, DndContext, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Globe, Pencil, Plus, Trash2 } from "./WuuIcons";
import { Modal } from "./Modal";
import {
  normalizeWebsiteURL,
  readNavigationRibbonPreferences,
  saveNavigationRibbonPreferences,
  saveRibbonOrder,
  useNavigationRibbonPreferences,
  type RibbonWebsite,
} from "./NavigationRibbonPreferences";
import { SidebarPointerSensor } from "./SidebarPointerSensor";
import { useSortableTransition } from "./SortableMotion";
import { ThreadContextMenu, type ThreadContextMenuItem } from "./ThreadContextMenu";
import { showActionErrorToast, showToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { useI18n } from "./i18n";

export interface NavigationRibbonItem {
  id: string;
  title: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  component?: string;
  pluginId?: string;
  onSelect: () => void;
}

function WebsiteIcon({ title }: { title: string }): JSX.Element {
  return <span className="sidebar-ribbon-website-icon" aria-hidden="true">{Array.from(title)[0]?.toLocaleUpperCase() || <Globe />}</span>;
}

function RibbonDestination({ item, onMove, onMenu }: {
  item: NavigationRibbonItem;
  onMove: (direction: -1 | 1) => void;
  onMenu: (x: number, y: number) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    transition: useSortableTransition(),
  });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <Tooltip content={item.title} disabled={isDragging}>
      <button
        {...attributes}
        {...listeners}
        ref={setNodeRef}
        style={style}
        type="button"
        className={`sidebar-ribbon-button${item.pluginId ? " plugin-navigation-item" : ""}${item.active ? " active" : ""}`}
        aria-label={item.title}
        aria-current={item.active ? "page" : undefined}
        aria-disabled={item.disabled || undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        data-ribbon-id={item.id}
        data-wuu-component={item.component}
        data-wuu-plugin={item.pluginId}
        data-dragging={isDragging || undefined}
        onClick={() => { if (!item.disabled) item.onSelect(); }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          onMenu(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            event.stopPropagation();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu(rect.right, rect.top);
          }
        }}
      >
        {item.icon}
      </button>
    </Tooltip>
  );
}

export function NavigationRibbon({ items, activeWebsiteId, onSelectWebsite, footer, ribbonRef }: {
  items: NavigationRibbonItem[];
  activeWebsiteId?: string | null;
  onSelectWebsite?: (website: RibbonWebsite) => void;
  footer?: ReactNode;
  ribbonRef?: Ref<HTMLElement>;
}): JSX.Element {
  const { t } = useI18n();
  const preferences = useNavigationRibbonPreferences();
  const [managerOpen, setManagerOpen] = useState(false);
  const [editing, setEditing] = useState<RibbonWebsite | "new" | null>(null);
  const [name, setName] = useState("");
  const [url, setURL] = useState("");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const managerListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!managerOpen) return;
    if (editing) nameInputRef.current?.focus();
    else managerListRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [managerOpen, editing]);
  const sensors = useSensors(useSensor(SidebarPointerSensor, { activationConstraint: { distance: 6 } }));
  const destinations = useMemo(() => [
    ...items,
    ...preferences.websites.map((website): NavigationRibbonItem => ({
      id: website.id,
      title: website.title,
      icon: <WebsiteIcon title={website.title} />,
      active: activeWebsiteId === website.id,
      disabled: !onSelectWebsite,
      component: "website-navigation-item",
      onSelect: () => onSelectWebsite?.(website),
    })),
  ], [items, preferences.websites, activeWebsiteId, onSelectWebsite]);
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
  const visibleOrder = JSON.stringify(orderedIDs);
  useLayoutEffect(() => {
    // Removing a focused shortcut (or unloading a plugin) removes its button.
    // Keep keyboard focus inside the open manager rather than on the page body.
    if (managerOpen && !editing && document.activeElement === document.body) {
      managerListRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [visibleOrder, managerOpen, editing]);

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

  function editWebsite(website: RibbonWebsite | "new"): void {
    setName(website === "new" ? "" : website.title);
    setURL(website === "new" ? "" : website.url);
    setError("");
    setEditing(website);
    setManagerOpen(true);
  }

  function focusRibbonItem(id: string): void {
    [...document.querySelectorAll<HTMLButtonElement>(".sidebar-ribbon-button[data-ribbon-id]")]
      .find((button) => button.dataset.ribbonId === id)?.focus();
  }

  function saveWebsite(): void {
    const normalizedURL = normalizeWebsiteURL(url);
    if (!normalizedURL) { setError(t("webWorkspace.invalidURL")); return; }
    const current = readNavigationRibbonPreferences();
    const website: RibbonWebsite = {
      id: editing && editing !== "new" ? editing.id : `website:${crypto.randomUUID()}`,
      title: name.trim() || new URL(normalizedURL).hostname,
      url: normalizedURL,
    };
    const existing = current.websites.some((site) => site.id === website.id);
    try {
      saveNavigationRibbonPreferences({
        websites: existing ? current.websites.map((site) => site.id === website.id ? website : site) : [...current.websites, website],
        order: current.order.includes(website.id) ? current.order : [...current.order, website.id],
      });
      setEditing(null);
      setError("");
    } catch {
      setError(t("ribbon.saveFailed"));
    }
  }

  function removeWebsite(website: RibbonWebsite): void {
    const previous = readNavigationRibbonPreferences();
    try {
      saveNavigationRibbonPreferences({
        websites: previous.websites.filter((site) => site.id !== website.id),
        // Keep the vacant slot so undoing several removals cannot reverse their
        // relative order. Visible reorders already preserve dormant slots.
        order: previous.order,
      });
      if (!managerOpen) {
        const index = orderedIDs.indexOf(website.id);
        const next = orderedIDs[index + 1] ?? orderedIDs[index - 1];
        if (next) focusRibbonItem(next);
      }
      showToast({
        message: t("ribbon.removed", { name: website.title }),
        dedupeKey: `website-removed:${website.id}:${Date.now()}`,
        action: {
          label: t("ribbon.undo"),
          onClick: () => {
            const current = readNavigationRibbonPreferences();
            if (current.websites.some((site) => site.id === website.id)) return;
            const order = current.order.includes(website.id) ? current.order : [...current.order, website.id];
            try { saveNavigationRibbonPreferences({ websites: [...current.websites, website], order }); }
            catch (saveError) { showActionErrorToast(saveError, t("ribbon.saveFailed")); }
          },
        },
      });
    } catch (saveError) {
      showActionErrorToast(saveError, t("ribbon.saveFailed"));
    }
  }

  function menuItems(): ThreadContextMenuItem[] {
    if (!menu) return [];
    const index = orderedIDs.indexOf(menu.id);
    const website = preferences.websites.find((site) => site.id === menu.id);
    return [
      { label: t("ribbon.moveUp"), icon: <ArrowUp />, disabled: index <= 0, onSelect: () => { focusRibbonItem(menu.id); move(menu.id, -1); } },
      { label: t("ribbon.moveDown"), icon: <ArrowDown />, disabled: index === orderedIDs.length - 1, onSelect: () => { focusRibbonItem(menu.id); move(menu.id, 1); } },
      ...(website ? [
        { separator: true as const },
        { label: t("ribbon.editWebsite"), icon: <Pencil />, onSelect: () => { focusRibbonItem(menu.id); editWebsite(website); } },
        { label: t("ribbon.removeWebsite"), icon: <Trash2 />, onSelect: () => removeWebsite(website) },
      ] : []),
      { separator: true },
      { label: t("ribbon.customize"), onSelect: () => { focusRibbonItem(menu.id); setEditing(null); setManagerOpen(true); } },
    ];
  }

  return <>
    <nav ref={ribbonRef} className="sidebar-ribbon" aria-label={t("sidebar.mainNavigation")}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]}
        accessibility={{ screenReaderInstructions: { draggable: t("ribbon.reorderHint") } }}
        onDragEnd={({ active, over }) => { if (over) reorder(String(active.id), String(over.id)); }}>
        <div className="sidebar-ribbon-main scrollbar-hidden">
          <SortableContext items={orderedIDs} strategy={verticalListSortingStrategy}>
            {ordered.map((item) => <RibbonDestination key={item.id} item={item}
              onMove={(direction) => move(item.id, direction)}
              onMenu={(x, y) => setMenu({ id: item.id, x, y })} />)}
          </SortableContext>
          <Tooltip content={t("ribbon.customize")}>
            <button type="button" className="sidebar-ribbon-button sidebar-ribbon-add" aria-label={t("ribbon.customize")}
              onClick={() => { setEditing(null); setManagerOpen(true); }}><Plus aria-hidden="true" /></button>
          </Tooltip>
        </div>
      </DndContext>
      <div className="sidebar-ribbon-footer">{footer}</div>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </nav>
    {menu && <ThreadContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
    {managerOpen && <Modal
      ariaLabel={editing ? t(editing === "new" ? "ribbon.addWebsite" : "ribbon.editWebsite") : t("ribbon.customize")}
      title={editing ? t(editing === "new" ? "ribbon.addWebsite" : "ribbon.editWebsite") : t("ribbon.customize")}
      panelClassName="ribbon-manager"
      asForm={Boolean(editing)}
      onSubmit={saveWebsite}
      onClose={() => { setManagerOpen(false); setEditing(null); }}
      footer={editing ? <>
        <button type="button" className="settings-button settings-button-ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
        <button type="submit" className="settings-button settings-button-primary">{t("common.save")}</button>
      </> : <>
        <button type="button" className="settings-button settings-button-ghost" onClick={() => editWebsite("new")}><Plus className="icon" />{t("ribbon.addWebsite")}</button>
        <button type="button" className="settings-button settings-button-primary" onClick={() => setManagerOpen(false)}>{t("common.close")}</button>
      </>}
    >
      {editing ? <div className="ribbon-website-form">
        <label><span>{t("ribbon.websiteName")}</span><input ref={nameInputRef} className="settings-input" value={name} maxLength={80}
          autoComplete="off" onChange={(event) => setName(event.currentTarget.value)} /></label>
        <label><span>{t("webWorkspace.address")}</span><input className="settings-input" value={url} inputMode="url"
          placeholder="https://example.com" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)}
          aria-describedby={error ? "ribbon-website-error" : undefined}
          onChange={(event) => { setURL(event.currentTarget.value); setError(""); }} /></label>
        {editing === "new" && <div className="ribbon-website-suggestions" aria-label={t("ribbon.suggestions")}>
          {[
            { title: "Notion", url: "https://www.notion.so/" },
            { title: t("ribbon.feishu"), url: "https://www.feishu.cn/" },
            { title: "Bilibili", url: "https://www.bilibili.com/" },
          ].map((suggestion) => <button key={suggestion.url} type="button" className="settings-button settings-button-ghost"
            onClick={() => { setName(suggestion.title); setURL(suggestion.url); setError(""); }}>{suggestion.title}</button>)}
        </div>}
        {error && <p id="ribbon-website-error" className="settings-error" role="alert">{error}</p>}
      </div> : <div ref={managerListRef} className="ribbon-manager-list">
        {ordered.map((item, index) => {
          const website = preferences.websites.find((site) => site.id === item.id);
          return <div className="ribbon-manager-row" key={item.id} data-ribbon-manager-id={item.id}>
            <span className="ribbon-manager-icon" aria-hidden="true">{item.icon}</span>
            <div className="ribbon-manager-label"><span>{item.title}</span>{website && <span className="ribbon-manager-url">{website.url}</span>}</div>
            <div className="ribbon-manager-actions">
              {website && <>
                <Tooltip content={t("ribbon.editWebsite")}><button type="button" className="icon-button" aria-label={t("ribbon.editNamedWebsite", { name: item.title })}
                  onClick={() => editWebsite(website)}><Pencil className="icon" /></button></Tooltip>
                <Tooltip content={t("ribbon.removeWebsite")}><button type="button" className="icon-button" aria-label={t("ribbon.removeNamedWebsite", { name: item.title })}
                  onClick={() => removeWebsite(website)}><Trash2 className="icon" /></button></Tooltip>
              </>}
              <Tooltip content={t("ribbon.moveUp")}><button type="button" className="icon-button" disabled={index === 0}
                aria-label={t("ribbon.moveNamedUp", { name: item.title })} onClick={() => move(item.id, -1)}><ArrowUp className="icon" /></button></Tooltip>
              <Tooltip content={t("ribbon.moveDown")}><button type="button" className="icon-button" disabled={index === ordered.length - 1}
                aria-label={t("ribbon.moveNamedDown", { name: item.title })} onClick={() => move(item.id, 1)}><ArrowDown className="icon" /></button></Tooltip>
            </div>
          </div>;
        })}
      </div>}
    </Modal>}
  </>;
}
