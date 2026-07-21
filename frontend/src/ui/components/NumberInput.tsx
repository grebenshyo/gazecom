/**
 * Numeric input matching the dropdown's label-on-left visual treatment.
 *
 * Used for fields where slider granularity isn't appropriate (e.g.
 * pixel-precise canvas-bounds dimensions). Borrows the .gz-dropdown
 * skin so labels align with surrounding controls.
 */

import "./NumberInput.css";

interface NumberInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: NumberInputProps) {
  return (
    <label className="gz-numinput">
      <span className="gz-numinput__label">{label}</span>
      <input
        className="gz-numinput__input"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return; // ignore empties; the input keeps the old value
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={(e) => {
          // Enforce min/max on blur so a partial-typed value (e.g. "10")
          // gets snapped up to the minimum (e.g. 1024) once the user
          // commits.
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          let clamped = n;
          if (typeof min === "number") clamped = Math.max(min, clamped);
          if (typeof max === "number") clamped = Math.min(max, clamped);
          if (clamped !== n) onChange(clamped);
        }}
      />
    </label>
  );
}
