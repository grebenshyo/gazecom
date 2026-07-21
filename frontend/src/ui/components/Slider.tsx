import "./Slider.css";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  showValue?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  showValue = true,
}: SliderProps) {
  return (
    <label className="gz-slider">
      <span className="gz-slider__label">
        {label}
        {showValue && <span className="gz-slider__value"> {value}</span>}
      </span>
      <input
        className="gz-slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
