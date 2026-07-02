"use client";

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/utils/cn";
import styles from "./ScreenWrapper.module.css";

export function ScreenWrapper({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cn(styles.wrapper, className)} style={style}>
      {children}
    </div>
  );
}
