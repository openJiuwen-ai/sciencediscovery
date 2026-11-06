// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
const reserved = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "accept", "content-type", "content-length", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
/** Validate a credential header name while excluding transport-owned fields. */
export function isMcpCredentialHeader(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u.test(name) && !reserved.has(name.toLowerCase()) && !/^(?:proxy-|sec-|content-)/iu.test(name);
}
export function isMcpHeaderCredentialValue(secret: unknown): secret is string {
  // No silent whitespace normalization, host-environment interpolation or CRLF.
  return typeof secret === "string" && secret.length <= 16_384 && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u.test(secret) && !secret.startsWith("$");
}
