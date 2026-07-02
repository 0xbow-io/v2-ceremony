"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/utils/cn";
import styles from "./Button.module.css";

type ButtonVariant = "primary" | "secondary" | "accent" | "ghost";

const SIZE_MAP = {
  default: styles.sizeDefault,
  small: styles.sizeSmall,
} as const;

export function Button({
  variant = "primary",
  size = "default",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "default" | "small";
}) {
  return (
    <button
      type="button"
      className={cn(styles.button, SIZE_MAP[size], styles[variant], className)}
      {...props}
    >
      {children}
    </button>
  );
}
