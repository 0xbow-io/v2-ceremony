"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../Button";
import styles from "./ErrorBoundary.module.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className={styles.container}>
        <div className={styles.content}>
          <h2 className="sectionTitle">Something went wrong</h2>
          {this.state.message && (
            <p className={styles.message}>{this.state.message}</p>
          )}
          <Button
            onClick={() => {
              this.setState({ hasError: false, message: null });
              window.location.reload();
            }}
          >
            RELOAD
          </Button>
        </div>
      </div>
    );
  }
}
