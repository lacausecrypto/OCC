/**
 * Reusable "Lists" component — create named groups of items that can be
 * toggled on/off, renamed, edited. Persists to localStorage.
 */
import { useState } from "react";
import styles from "./Settings.module.css";

export interface ItemList {
  id: string;
  name: string;
  items: string[];
  enabled: boolean;
}

interface ItemListManagerProps {
  storageKey: string;
  allItemIds: string[];
  label: string;
  description: string;
  itemLabel?: (id: string) => string;
}

function load(key: string): ItemList[] {
  try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
}

function save(key: string, lists: ItemList[]) {
  localStorage.setItem(key, JSON.stringify(lists));
}

export function ItemListManager({ storageKey, allItemIds, label, description, itemLabel }: ItemListManagerProps) {
  const [lists, setLists] = useState<ItemList[]>(() => load(storageKey));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const update = (updated: ItemList[]) => { setLists(updated); save(storageKey, updated); };

  const handleCreate = () => {
    if (!newName.trim()) return;
    update([...lists, { id: `list_${Date.now()}`, name: newName.trim(), items: [...allItemIds], enabled: true }]);
    setNewName("");
    setAdding(false);
  };

  const getLabel = (id: string) => itemLabel ? itemLabel(id) : id;

  return (
    <div className={styles.sectionCard} style={{ marginTop: 8 }}>
      <div className={styles.row}>
        <div className={styles.rowBody}>
          <div className={styles.rowLabel}>{label}</div>
          <div className={styles.rowDesc}>{description}</div>
        </div>
        <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={() => setAdding(true)} style={{ fontSize: 9 }}>+ New List</button>
      </div>

      {adding && (
        <div className={styles.listFormRow}>
          <input
            className={styles.formInput}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="List name..."
            autoFocus
            style={{ flex: 1 }}
          />
          <button className={styles.rowBtn} onClick={() => setAdding(false)}>Cancel</button>
          <button className={`${styles.rowBtn} ${styles.rowBtnPrimary}`} onClick={handleCreate} disabled={!newName.trim()}>Create</button>
        </div>
      )}

      {lists.map((list) => (
        <div key={list.id} className={styles.mcpListCard}>
          <div className={styles.mcpListHeader}>
            <button
              className={`${styles.toggle} ${list.enabled ? styles.toggleOn : ""}`}
              onClick={() => update(lists.map((l) => l.id === list.id ? { ...l, enabled: !l.enabled } : l))}
              style={{ width: 34, height: 20, flexShrink: 0 }}
              type="button"
            >
              <div className={styles.toggleDot} style={{ width: 16, height: 16 }} />
            </button>

            {editingId === list.id ? (
              <input
                className={styles.formInput}
                defaultValue={list.name}
                onBlur={(e) => { update(lists.map((l) => l.id === list.id ? { ...l, name: e.target.value } : l)); setEditingId(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { update(lists.map((l) => l.id === list.id ? { ...l, name: (e.target as HTMLInputElement).value } : l)); setEditingId(null); }
                  if (e.key === "Escape") setEditingId(null);
                }}
                autoFocus
                style={{ flex: 1 }}
              />
            ) : (
              <span className={styles.mcpListName} onDoubleClick={() => setEditingId(list.id)}>{list.name}</span>
            )}

            <span className={styles.mcpListCount}>{list.items.length}</span>
            <button className={styles.rowBtn} onClick={() => setEditingId(list.id)} title="Rename" style={{ padding: "2px 6px", fontSize: 9 }}>{"\u270E"}</button>
            <button className={`${styles.rowBtn} ${styles.rowBtnDanger}`} onClick={() => { if (confirm(`Delete "${list.name}"?`)) update(lists.filter((l) => l.id !== list.id)); }} title="Delete" style={{ padding: "2px 6px", fontSize: 9 }}>{"\u2716"}</button>
          </div>

          <div className={styles.mcpListServers}>
            {list.items.map((itemId) => (
              <span key={itemId} className={styles.mcpListServerPill}>
                {getLabel(itemId)}
                <button className={styles.mcpListServerRemove} onClick={() => update(lists.map((l) => l.id === list.id ? { ...l, items: l.items.filter((i) => i !== itemId) } : l))}>{"\u00D7"}</button>
              </span>
            ))}
            {allItemIds.filter((id) => !list.items.includes(id)).length > 0 && (
              <select
                className={styles.mcpListAddSelect}
                value=""
                onChange={(e) => { if (e.target.value) update(lists.map((l) => l.id === list.id ? { ...l, items: [...l.items, e.target.value] } : l)); }}
              >
                <option value="">+ Add</option>
                {allItemIds.filter((id) => !list.items.includes(id)).map((id) => (
                  <option key={id} value={id}>{getLabel(id)}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
