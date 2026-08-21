import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { cropRectToImagePixels, type PreviewRect } from "@ai-ide/shared";
import { useNativeOverlay } from "../hooks/useNativeOverlay";

type Point = { x: number; y: number };

/**
 * Crop selection over a frozen capture of the preview, in the spirit of ⇧⌘4 on
 * macOS. It works on a still image rather than the live page for two reasons:
 * a selection rectangle cannot be painted over a native view, and freezing the
 * frame means an animation or a poll cannot move the target mid-drag.
 */
export function PreviewCropOverlay(props: {
  image: { dataBase64: string; mime: string };
  rect: PreviewRect;
  onCancel: () => void;
  onCrop: (dataUrl: string) => void;
}) {
  const { image, rect, onCancel, onCrop } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const src = `data:${image.mime};base64,${image.dataBase64}`;

  useNativeOverlay(true);

  const pointIn = useCallback((e: PointerEvent<HTMLDivElement>): Point => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
  }, []);

  const finish = useCallback(
    (from: Point, to: Point) => {
      const img = imageRef.current;
      if (!img) {
        onCancel();
        return;
      }
      const crop = cropRectToImagePixels({
        start: from,
        end: to,
        displayedWidth: rect.width,
        displayedHeight: rect.height,
        imageWidth: img.naturalWidth,
        imageHeight: img.naturalHeight,
      });
      if (!crop) {
        onCancel();
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = crop.width;
      canvas.height = crop.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        onCancel();
        return;
      }
      ctx.drawImage(
        img,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );
      onCrop(canvas.toDataURL("image/png"));
    },
    [onCancel, onCrop, rect.height, rect.width],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const selection =
    start && end
      ? {
          left: Math.min(start.x, end.x),
          top: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : null;

  return (
    <div
      ref={containerRef}
      className="crop-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Select an area of the preview"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const point = pointIn(e);
        setStart(point);
        setEnd(point);
      }}
      onPointerMove={(e) => {
        if (!start) return;
        setEnd(pointIn(e));
      }}
      onPointerUp={(e) => {
        if (!start) return;
        const to = pointIn(e);
        setStart(null);
        setEnd(null);
        finish(start, to);
      }}
      onPointerCancel={() => {
        setStart(null);
        setEnd(null);
      }}
    >
      <img ref={imageRef} className="crop-overlay-image" src={src} alt="" />
      {selection ? (
        <div
          className="crop-overlay-selection"
          style={{
            left: selection.left,
            top: selection.top,
            width: selection.width,
            height: selection.height,
          }}
        >
          <span className="crop-overlay-size">
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </span>
        </div>
      ) : (
        <div className="crop-overlay-scrim" />
      )}
      <div className="crop-overlay-hint">
        Drag to select the area · Esc to cancel
      </div>
    </div>
  );
}
