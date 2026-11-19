import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { configurationNeedsSecurityConsent, configurationSecurityConsent } from "./compatibility.js";
import { genericConfigurationPresentation, mergeConfigurationRequests, shouldPollConfigurationRequest } from "./presentation.js";
import { memoryConfigurationCopy } from "./memory-copy.js";
import { mcpConfigurationChoiceLabel, mcpConfigurationText } from "./mcp-copy.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

function request(overrides: Record<string, unknown> = {}): ConfigurationRequestView {
  return {
    id: "request-1", sessionId: "session-1", capabilityId: "memory.enable", adapterVersion: 1, schemaVersion: 1,
    protocolVersion: 3, revision: 1, stateVersion: 1, state: "awaiting_confirmation", runId: undefined,
    reason: { code: "CONFIGURATION_REQUIRED", message: "A configuration change is required" },
    impact: { resourceLocation: "Deployment MemoryGraph settings", effectiveScope: "Every session using the workbench memory graph", message: "Local backend only; manual confirmation required. Enabling permits subsequent research-memory operations to use the existing local graph. Disabling stops subsequent gated operations; in-flight requests may finish and stored graph data is retained. This does not disable every Agent's independent memory, change backend or credentials, install a service or verify readiness. If the MemoryGraph service is unavailable, start it separately and restart the API if required by the deployment; saving does not start or restart services." },
    scope: { kind: "global" }, fields: [], activation: { state: "pending" }, resumption: { state: "not_requested" },
    ...overrides,
  } as unknown as ConfigurationRequestView;
}

test("configuration request merge keeps the newest revision and does not regress state", () => {
  const current = request();
  const newer = request({ revision: 2, stateVersion: 1, state: "applied" });
  const stale = request({ revision: 1, stateVersion: 0, state: "dismissed" });
  assert.deepEqual(mergeConfigurationRequests([current], [stale, newer]), [newer]);
});

test("configuration presentation suppresses duplicate terminal notices and polls pending work", () => {
  const applied = request({ state: "applied", activation: { state: "active" } });
  const result = genericConfigurationPresentation([applied], [
    { id: "notice-1", kind: "configuration_notice", configurationRequestId: applied.id } as never,
    { id: "notice-2", kind: "configuration_notice", configurationRequestId: applied.id } as never,
  ], new Map(), "session-1");
  assert.equal(result.byNoticeId.size, 1);
  assert.deepEqual([...result.suppressedNoticeIds], ["notice-2"]);
  assert.equal(shouldPollConfigurationRequest(request({ state: "validating" })), true);
  assert.equal(shouldPollConfigurationRequest(applied), false);
});

test("security consent parsing fails closed and recognizes only security capabilities", () => {
  assert.equal(configurationNeedsSecurityConsent("security.network"), true);
  assert.equal(configurationNeedsSecurityConsent("mcp.timeout"), false);
  assert.deepEqual(configurationSecurityConsent({ securityConsent: { revision: 2, targetDigest: "sha256:x", statement: "reviewed", status: "confirmed" } }), { revision: 2, targetDigest: "sha256:x", statement: "reviewed", status: "confirmed" });
  assert.equal(configurationSecurityConsent({ securityConsent: { revision: 0 } }), undefined);
});

test("memory and MCP display adapters preserve unknown server text", () => {
  const memory = memoryConfigurationCopy(request(), "zh-CN");
  assert.equal(memory.reason, "需要更改配置");
  assert.equal(memory.resourceLocation, "部署级 MemoryGraph 设置");
  const unknown = memoryConfigurationCopy(request({ reason: { code: "NEW_REASON", message: "server supplied" } }), "zh-CN");
  assert.equal(unknown.reason, "server supplied");
  const mcp = request({ capabilityId: "mcp.header_credential", fields: [{ id: "headerName", kind: "enum", value: "x-api-key", choices: [{ id: "x-api-key", label: "x-api-key · 2 stored name(s)" }] }] });
  assert.equal(mcpConfigurationChoiceLabel("zh-CN", mcp, "headerName", "x-api-key", "x-api-key · 2 stored name(s)"), "x-api-key · 2 个已保存名称");
  assert.equal(mcpConfigurationText("zh-CN", mcp, "reason", "server supplied"), "server supplied");
});
