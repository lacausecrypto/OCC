import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import styles from "./Sidebar.module.css";

interface ReferenceSlotProps {
  index: number;
  name: string;
  loadedUrl: string | null;
  imageUrl: string | null;
  loading?: boolean;
  onLoad: (index: number, url: string) => void;
  onClear: (index: number) => void;
}

/** Clean a URL for display: remove protocol, www, trailing slash, .com/.org etc */
function cleanDisplayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .replace(/\.(com|org|net|io|app|co|dev|so)$/, "");
}

export function ReferenceSlot({ index, loadedUrl, imageUrl, loading, onLoad, onClear }: ReferenceSlotProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragover, setDragover] = useState(false);
  const [urlInput, setUrlInput] = useState("");

  const hasImg = !!imageUrl;

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) onLoad(index, URL.createObjectURL(f));
    },
    [index, onLoad],
  );

  const handleUrlKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        let url = urlInput.trim();
        if (!url) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
        setUrlInput("");
        onLoad(index, url);
      }
    },
    [urlInput, index, onLoad],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragover(false);
      if (e.dataTransfer.files.length) {
        const f = e.dataTransfer.files[0];
        if (f.type.startsWith("image/")) onLoad(index, URL.createObjectURL(f));
        return;
      }
      let txt = e.dataTransfer.getData("text/plain");
      if (txt) {
        if (!txt.match(/^https?:\/\//)) txt = "https://" + txt;
        onLoad(index, txt);
      }
    },
    [index, onLoad],
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClear(index);
    },
    [index, onClear],
  );

  const slotClass = [
    styles.refSlot,
    hasImg ? styles.hasImg : "",
    dragover ? styles.refSlotDragover : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={slotClass}
      onClick={handleClick}
      onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
      onDragLeave={() => setDragover(false)}
      onDrop={handleDrop}
    >
      <div className={styles.refThumb}>
        {hasImg && <img src={imageUrl} alt="" />}
        {loading
          ? <div className={styles.refPlaceholder} style={{ animation: "spin 1s linear infinite" }}>&#8635;</div>
          : <div className={styles.refPlaceholder}>+</div>
        }
      </div>
      <div className={styles.refInfo}>
        <div className={styles.refName}>
          {loadedUrl ? cleanDisplayUrl(loadedUrl) : `Slot ${index + 1}`}
        </div>
        <input
          className={styles.refUrlInput}
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder="paste URL + Enter"
        />
      </div>
      <button className={styles.refRemove} onClick={handleRemove}>
        &times;
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </div>
  );
}
