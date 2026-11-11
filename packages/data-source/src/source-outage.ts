// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import type { McpSourceOutage } from "@sciencediscovery/schema";

/** The part of an attempt this module needs to judge a failure. */
export interface OutageAttempt {
  errorCode?: string;
  errorMessage?: string;
  status?: string;
  upstream?: { endpoint?: string; failureScope?: string; statusCode?: number };
}


/**
 * Decide whether a failed attempt is evidence that the provider is gone, and if
 * so describe it for the readiness view.
 *
 * A tool-level rejection is not an outage. `upstreamError()` falls back to
 * `UPSTREAM_UNAVAILABLE` for every attempt status it does not map, and a
 * tool-reported error arrives as `semantic-error`: an invalid query or a DOI the
 * provider cannot resolve says something about the request, not the endpoint.
 * `SourceHealth` already separates those two (`statusCode === 406 &&
 * failureScope === "endpoint"`), so this uses the same evidence — a declared
 * endpoint scope, or a transport/server failure — and nothing else.
 */
export function recordedOutage(
  attempt: OutageAttempt | undefined,
  sourceId: string,
  toolId: string | undefined,
  error: { code?: string; message?: string; upstreamCode?: string },
  now: () => number = Date.now,
): McpSourceOutage | undefined {
  if (!attempt) return undefined;
  const endpointScoped = attempt.upstream?.failureScope === "endpoint";
  const providerLevel = endpointScoped
    || attempt.status === "transport-error"
    || attempt.status === "server-error";
  if (!providerLevel) return undefined;
  return {
    at: new Date(now()).toISOString(),
    // A declared endpoint scope is exactly the outage the issue asks to name, so
    // it gets the endpoint vocabulary rather than the generic tool-level code.
    code: endpointScoped
      ? "ENDPOINT_UNAVAILABLE"
      // A transport or server failure is the provider being gone; use that
      // vocabulary rather than whatever tool-level code rode along with it.
      : attempt.status === "transport-error" || attempt.status === "server-error"
        ? "UPSTREAM_UNAVAILABLE"
        : (error.upstreamCode ?? error.code ?? "UPSTREAM_UNAVAILABLE"),
    ...(error.message ? { detail: error.message.slice(0, 160) } : {}),
    sourceId,
    ...(toolId ? { toolId } : {}),
  };
}

/**
 * How long a recorded provider outage stays visible. Ten minutes keeps a
 * blip from sticking around for a session while still outliving a single
 * retry, and it is deliberately unrelated to the broker's 30 s–120 s cooling
 * windows: cooldown governs admission, this only governs what readiness says.
 */
export const SOURCE_OUTAGE_TTL_MS = 10 * 60_000;

/**
 * The last classified provider outage per MCP source.
 *
 * It is memory only, on purpose. Nothing here may change a decision: the
 * readiness gate keeps reading `McpSourceStatus.status`, so a recorded outage
 * shows up in the readiness view without ever disabling a working connector
 * on a transient error (#1081).
 */
export class SourceOutages {
  private readonly bySource = new Map<string, McpSourceOutage>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Remember an outage the gateway already classified as upstream-level. */
  note(outage: McpSourceOutage): void {
    this.bySource.set(outage.sourceId, outage);
  }

  /** The last outage for a source, while it is still inside the window. */
  read(sourceId: string): McpSourceOutage | undefined {
    const outage = this.bySource.get(sourceId);
    if (!outage) return undefined;
    const age = this.now() - Date.parse(outage.at);
    if (!Number.isFinite(age) || age > SOURCE_OUTAGE_TTL_MS) {
      this.bySource.delete(sourceId);
      return undefined;
    }
    return { ...outage };
  }

  clear(sourceId?: string): void {
    if (sourceId === undefined) this.bySource.clear();
    else this.bySource.delete(sourceId);
  }
}

/** The process-wide memory: one broker and one catalog share it so what a
 *  failed invocation recorded is what the readiness view reports. */
export const sourceOutages = new SourceOutages();
