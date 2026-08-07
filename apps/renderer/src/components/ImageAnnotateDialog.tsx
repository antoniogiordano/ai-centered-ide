import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

const COLORS = [
  { id: "1", label: "Black · 1", value: "#000000" },
  { id: "2", label: "White · 2", value: "#ffffff" },
  { id: "3", label: "Red · 3", value: "#e03131" },
  { id: "4", label: "Orange · 4", value: "#f76707" },
  { id: "5", label: "Yellow · 5", value: "#f59f00" },
  { id: "6", label: "Green · 6", value: "#2f9e44" },
  { id: "7", label: "Cyan · 7", value: "#0c8599" },
  { id: "8", label: "Blue · 8", value: "#1971c2" },
  { id: "9", label: "Purple · 9", value: "#9c36b5" },
  { id: "0", label: "Pink · 0", value: "#d6336c" },
] as const;

const BRUSHES = [
  { id: "q", label: "Thin · Q", size: 2 },
  { id: "w", label: "Medium · W", size: 6 },
  { id: "e", label: "Thick · E", size: 14 },
] as const;

type Props = {
  src: string;
  name: string;
  onDone: (dataUrl: string) => void;
  onCancel: () => void;
};

export function ImageAnnotateDialog(props: Props) {
  const { src, name, onDone, onCancel } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [color, setColor] = useState<string>(COLORS[0]!.value);
  const [brush, setBrush] = useState<number>(BRUSHES[1]!.size);
  const [ready, setReady] = useState(false);

  const paintPoint = useCallback(
    (x: number, y: number, from: { x: number; y: number } | null) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = brush;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (from) {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, brush / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    [brush, color],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      const maxW = Math.min(960, window.innerWidth - 80);
      const maxH = Math.min(640, window.innerHeight - 220);
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setReady(true);
    };
    img.src = src;
  }, [src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const canvas = canvasRef.current;
        if (!canvas || !ready) return;
        onDone(canvas.toDataURL("image/png"));
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const key = e.key.toLowerCase();
      const colorHit = COLORS.find((c) => c.id === key);
      if (colorHit) {
        e.preventDefault();
        setColor(colorHit.value);
        return;
      }
      const brushHit = BRUSHES.find((b) => b.id === key);
      if (brushHit) {
        e.preventDefault();
        setBrush(brushHit.size);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onDone, ready]);

  function pointerPos(e: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  return (
    <div
      className="annotate-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Annotate ${name}`}
    >
      <div className="annotate-dialog">
        <header className="annotate-header">
          <div>
            <strong>Annotate image</strong>
            <span className="muted annotate-name">{name}</span>
          </div>
          <div className="annotate-header-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onCancel}
            >
              Cancel · Esc
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!ready}
              onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                onDone(canvas.toDataURL("image/png"));
              }}
            >
              Done · Enter
            </button>
          </div>
        </header>

        <div className="annotate-toolbar" role="toolbar" aria-label="Paint tools">
          <div className="annotate-colors">
            {COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`annotate-swatch ${color === c.value ? "annotate-swatch-active" : ""}`}
                style={{ background: c.value }}
                title={c.label}
                aria-label={c.label}
                aria-pressed={color === c.value}
                onClick={() => setColor(c.value)}
              />
            ))}
          </div>
          <div className="annotate-brushes">
            {BRUSHES.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`btn btn-secondary btn-sm ${brush === b.size ? "annotate-brush-active" : ""}`}
                aria-pressed={brush === b.size}
                onClick={() => setBrush(b.size)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        <div className="annotate-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="annotate-canvas"
            onPointerDown={(e) => {
              drawing.current = true;
              (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
              const p = pointerPos(e);
              paintPoint(p.x, p.y, null);
              last.current = p;
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const p = pointerPos(e);
              paintPoint(p.x, p.y, last.current);
              last.current = p;
            }}
            onPointerUp={() => {
              drawing.current = false;
              last.current = null;
            }}
            onPointerCancel={() => {
              drawing.current = false;
              last.current = null;
            }}
          />
        </div>
      </div>
    </div>
  );
}
