import "./Button.css";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "small";
}

export function Button({
  variant = "primary",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`gz-btn gz-btn--${variant} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
