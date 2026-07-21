import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  WorkflowCategory,
  WorkflowDescriptor,
} from "../../generation/workflows";
import "./WorkflowPicker.css";

interface WorkflowPickerProps {
  workflows: readonly WorkflowDescriptor[];
  pinnedPaths: ReadonlySet<string>;
  onSelect: (path: string) => void;
}

const GROUPS: ReadonlyArray<{
  category: WorkflowCategory | null;
  label: string;
}> = [
  { category: "img", label: "IMG" },
  { category: "edit", label: "EDIT" },
  { category: "inpainting", label: "IN-/OUTPAINT" },
  { category: null, label: "ISSUES" },
];

function categoryKey(category: WorkflowCategory | null): string {
  return category ?? "issues";
}

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  scale: number;
  origin: "top left" | "bottom left";
}

export function WorkflowPicker({
  workflows,
  pinnedPaths,
  onSelect,
}: WorkflowPickerProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const available = workflows.filter(
    (workflow) => !pinnedPaths.has(workflow.path),
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const positionMenu = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const scale = root.offsetWidth > 0 ? rect.width / root.offsetWidth : 1;
      const below = window.innerHeight - rect.bottom - 4;
      const above = rect.top - 4;
      const openAbove = below < 180 * scale && above > below;
      const availableHeight = Math.max(80, openAbove ? above : below);

      setMenuPosition({
        left: rect.left,
        top: openAbove ? undefined : rect.bottom + 4,
        bottom: openAbove ? window.innerHeight - rect.top + 4 : undefined,
        width: rect.width / scale,
        maxHeight: availableHeight / scale,
        scale,
        origin: openAbove ? "bottom left" : "top left",
      });
    };

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  return (
    <div
      className="gz-workflow-picker"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <div className="gz-workflow-picker__control">
        <span className="gz-workflow-picker__label">Pool</span>
        <button
          className="gz-workflow-picker__trigger"
          type="button"
          aria-label="Pool"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={available.length === 0}
          onClick={() => setOpen((value) => !value)}
        >
          <span>
            {available.length === 0 ? "All workflows pinned" : "Add workflow…"}
          </span>
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
      </div>

      {open && menuPosition && createPortal(
        <div
          className="gz-workflow-picker__menu"
          id={menuId}
          role="listbox"
          ref={menuRef}
          style={{
            left: menuPosition.left,
            top: menuPosition.top,
            bottom: menuPosition.bottom,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
            transform: `scale(${menuPosition.scale})`,
            transformOrigin: menuPosition.origin,
          }}
        >
          {GROUPS.map((group) => {
            const entries = available.filter(
              (workflow) => workflow.category === group.category,
            );
            if (entries.length === 0) return null;
            return (
              <div
                className="gz-workflow-picker__group"
                data-category={categoryKey(group.category)}
                key={categoryKey(group.category)}
                role="group"
                aria-label={group.label}
              >
                <div className="gz-workflow-picker__group-label">
                  {group.label}
                </div>
                {entries.map((workflow) => {
                  const detail = [...workflow.errors, ...workflow.warnings].join("\n");
                  return (
                    <button
                      className="gz-workflow-picker__option"
                      type="button"
                      role="option"
                      aria-selected="false"
                      disabled={!workflow.valid}
                      title={detail || workflow.path}
                      key={workflow.path}
                      onClick={() => {
                        onSelect(workflow.path);
                        setOpen(false);
                      }}
                    >
                      <span>{workflow.label}</span>
                      {!workflow.valid && (
                        <span className="gz-workflow-picker__error">invalid</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
