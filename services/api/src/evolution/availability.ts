// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

export const EVOLVE_UNINITIALIZED = "Evolve is not initialized. Select Init Evolve to download and install it.";
export class EvolveUnavailableError extends Error {
  readonly code = "EVOLVE_UNAVAILABLE";
}
export interface EvolveConnection { url: string; internalToken: string }
export interface EvolveConfiguration extends EvolveConnection {
  controlUrl?: string;
  controlToken?: string;
}
export interface EvolveStatus {
  state: "not_initialized" | "installing" | "ready" | "error";
  canInitialize: boolean;
  error?: string;
}

/** Never guesses an endpoint. Managed credentials stay between launcher and API. */
export class EvolveAvailability {
  private current: EvolveStatus = { state: "not_initialized", canInitialize: false };
  private readonly external: EvolveConnection;
  private pending?: { initialize: boolean; promise: Promise<EvolveStatus> };
  constructor(private readonly config: EvolveConfiguration) {
    this.external = { url: config.url, internalToken: config.internalToken };
  }
  get ready(): boolean { return this.current.state === "ready"; }
  async refresh(initialize = false): Promise<EvolveStatus> {
    if (this.pending) {
      if (!initialize || this.pending.initialize) return await this.pending.promise;
      await this.pending.promise;
      return await this.refresh(true);
    }
    const promise = this.refreshOnce(initialize);
    this.pending = { initialize, promise };
    try { return await promise; }
    finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
  private async refreshOnce(initialize: boolean): Promise<EvolveStatus> {
    try {
      if (this.config.controlUrl && this.config.controlToken) {
        const response = await fetch(`${this.config.controlUrl}/${initialize ? "init" : "status"}`, {
          method: initialize ? "POST" : "GET",
          headers: { authorization: `Bearer ${this.config.controlToken}` },
          signal: AbortSignal.timeout(initialize ? 15 * 60_000 : 5_000),
        });
        if (!response.ok) throw new Error("Launcher unavailable");
        const result = await response.json() as EvolveStatus & { connection?: EvolveConnection };
        this.current = { state: result.state, canInitialize: result.canInitialize, ...(result.error ? { error: result.error } : {}) };
        this.config.url = result.state === "ready" ? result.connection!.url : "";
        this.config.internalToken = result.state === "ready" ? result.connection!.internalToken : "";
      } else if (this.external.url) {
        const health = await fetch(`${this.external.url}/health`, { signal: AbortSignal.timeout(3_000), redirect: "error" });
        if (!health.ok || (await health.json() as { status?: string }).status !== "healthy") throw new Error("Health check failed");
        const auth = await fetch(`${this.external.url}/runs/readiness-${randomUUID()}/stop`, {
          method: "POST", headers: { authorization: `Bearer ${this.external.internalToken}` },
          signal: AbortSignal.timeout(3_000), redirect: "error",
        });
        if (!auth.ok) throw new Error("Authentication failed");
        this.current = { state: "ready", canInitialize: false };
        Object.assign(this.config, this.external);
      }
    } catch {
      this.current = { state: "error", canInitialize: Boolean(this.config.controlUrl), error: "Evolve service is unavailable or authentication failed. Retry initialization or check the configured service." };
      this.config.url = "";
      this.config.internalToken = "";
    }
    return this.current;
  }
  async connection(): Promise<EvolveConnection> {
    await this.refresh();
    if (!this.ready) throw new EvolveUnavailableError(this.current.error ?? EVOLVE_UNINITIALIZED);
    return { url: this.config.url, internalToken: this.config.internalToken };
  }
}
