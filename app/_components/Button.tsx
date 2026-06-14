import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "darkUtility" | "hero" | "text";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-normal transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guard-focus disabled:opacity-40 disabled:active:scale-100 disabled:cursor-not-allowed";

const variants: Record<Variant, string> = {
  primary: "rounded-full bg-guard text-white",
  secondary: "rounded-full border border-guard text-guard bg-transparent",
  darkUtility: "rounded-[8px] bg-ink text-white",
  hero: "rounded-full bg-guard text-white font-light",
  text: "text-guard bg-transparent",
};

const sizes: Record<Size, string> = {
  md: "px-[22px] py-[11px] text-[17px]",
  lg: "px-7 py-3.5 text-[18px]",
};

type CommonProps = {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  className?: string;
};

function classes({ variant = "primary", size = "md", className = "" }: CommonProps) {
  const sizeClass = variant === "text" ? "text-[17px]" : sizes[size];
  return `${base} ${variants[variant]} ${sizeClass} ${className}`;
}

export function Button({
  variant,
  size,
  className,
  children,
  ...rest
}: CommonProps & ComponentProps<"button">) {
  return (
    <button className={classes({ variant, size, children, className })} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  className,
  children,
  href,
  ...rest
}: CommonProps & ComponentProps<typeof Link>) {
  return (
    <Link href={href} className={classes({ variant, size, children, className })} {...rest}>
      {children}
    </Link>
  );
}
