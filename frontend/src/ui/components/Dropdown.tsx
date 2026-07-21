import "./Dropdown.css";

interface DropdownProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: DropdownProps<T>) {
  return (
    <label className={["gz-dropdown", className].filter(Boolean).join(" ")}>
      <span className="gz-dropdown__label">{label}</span>
      <select
        className="gz-dropdown__select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
