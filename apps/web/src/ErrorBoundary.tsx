// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown above the error text so the user knows which panel failed. */
  label: string;
  /** Invoked once when an error is caught, e.g. to close the failed overlay. */
  onError?: (message: string) => void;
}

interface ErrorBoundaryState {
  message?: string;
}

/**
 * Contains a render/lifecycle throw to one panel instead of the whole app.
 *
 * React unmounts the entire tree when an error reaches the root uncaught, so
 * without a boundary any single bad field — a message key the catalogue does
 * not carry, an unexpected shape from the read layer — turns into a white
 * page. That failure radius is out of proportion to the cause. This renders
 * the error in place and leaves the rest of the app usable.
 *
 * Class component because `getDerivedStateFromError` / `componentDidCatch`
 * have no hook equivalent; this is the one place the codebase needs one.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack in the console — the boundary swallows the
    // default uncaught-error report, and that stack is how this gets debugged.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
    this.props.onError?.(error instanceof Error ? error.message : String(error));
  }

  render(): ReactNode {
    if (this.state.message === undefined) return this.props.children;
    return <div className="error-boundary-fallback" role="alert">
      <strong>{this.props.label}</strong>
      <p>{this.state.message}</p>
    </div>;
  }
}
