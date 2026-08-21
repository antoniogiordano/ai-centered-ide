import {
  Children,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSplitLayout } from "../hooks/useSplitLayout";

/**
 * Horizontal (or vertical) panes with a drag gutter between them.
 * Auto weights fill the space until the human drags; the override is local.
 */
export function SplitGroup(props: {
  storageKey: string;
  autoWeights: number[];
  mins: number[];
  orientation?: "horizontal" | "vertical";
  children: ReactNode;
}) {
  const {
    storageKey,
    autoWeights,
    mins,
    orientation = "horizontal",
    children,
  } = props;
  const items = Children.toArray(children);
  const count = items.length;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [totalPx, setTotalPx] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setTotalPx(orientation === "horizontal" ? rect.width : rect.height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [orientation, count]);

  const { weights, commit } = useSplitLayout({
    storageKey,
    count,
    autoWeights: autoWeights.slice(0, count),
    mins: mins.slice(0, count),
    totalPx,
  });

  function startDrag(index: number, ev: React.PointerEvent<HTMLButtonElement>) {
    ev.preventDefault();
    const measured = rootRef.current;
    if (!measured || count < 2) return;
    const paneRoot: HTMLDivElement = measured;
    const startWeights = [...weights];
    const pair = startWeights[index]! + startWeights[index + 1]!;

    function onMove(e: PointerEvent) {
      const rect = paneRoot.getBoundingClientRect();
      const span = orientation === "horizontal" ? rect.width : rect.height;
      if (span <= 0) return;
      const now = orientation === "horizontal" ? e.clientX : e.clientY;
      const origin = orientation === "horizontal" ? rect.left : rect.top;
      const beforePx = startWeights
        .slice(0, index)
        .reduce((sum, w) => sum + w * span, 0);
      const raw = (now - origin - beforePx) / span;
      const left = Math.min(Math.max(raw, 0.08), pair - 0.08);
      const next = [...startWeights];
      next[index] = left;
      next[index + 1] = pair - left;
      commit(next);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  if (count <= 1) {
    return (
      <div ref={rootRef} className="split-group split-group-single">
        {items[0]}
      </div>
    );
  }

  const template = weights.map((w) => `minmax(0, ${w}fr)`).join(" 6px ");

  return (
    <div
      ref={rootRef}
      className={`split-group split-group-${orientation}`}
      style={
        orientation === "horizontal"
          ? { gridTemplateColumns: template }
          : { gridTemplateRows: template }
      }
    >
      {items.flatMap((child, index) => {
        const nodes = [
          <div key={`pane-${index}`} className="split-group-pane">
            {child}
          </div>,
        ];
        if (index < count - 1) {
          nodes.push(
            <button
              key={`gutter-${index}`}
              type="button"
              className="split-gutter"
              aria-label={`Resize pane ${index + 1}`}
              title="Drag to resize"
              onPointerDown={(e) => startDrag(index, e)}
            />,
          );
        }
        return nodes;
      })}
    </div>
  );
}
