// System proxy mirroring. Pure functions only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRegDword, parseRegQueryValue, proxyEnvFromSystem } from "../src/proxy.ts";

const REG_SAMPLE = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    EnableNegotiate    REG_DWORD    0x1",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    127.0.0.1:7890",
  "    ProxyOverride    REG_SZ    <-loopback>",
  "",
].join("\r\n");

test("parseRegQueryValue picks the right line and value column", () => {
  assert.equal(parseRegQueryValue(REG_SAMPLE, "ProxyServer"), "127.0.0.1:7890");
  assert.equal(parseRegQueryValue(REG_SAMPLE, "ProxyEnable"), "0x1");
  assert.equal(parseRegQueryValue(REG_SAMPLE, "Missing"), null);
  assert.equal(parseRegQueryValue("", "ProxyServer"), null);
});

test("parseRegDword handles hex, decimal and missing", () => {
  assert.equal(parseRegDword("0x1"), true);
  assert.equal(parseRegDword("1"), true);
  assert.equal(parseRegDword("0x0"), false);
  assert.equal(parseRegDword("0"), false);
  assert.equal(parseRegDword(null), false);
});

test("proxy off or absent → no env", () => {
  assert.equal(proxyEnvFromSystem(null), null);
  assert.equal(proxyEnvFromSystem({ enabled: false, server: "127.0.0.1:7890" }), null);
});

test("bare host:port mirrors to http and https with loopback bypass", () => {
  const env = proxyEnvFromSystem({ enabled: true, server: "127.0.0.1:7890" })!;
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(env.no_proxy, "localhost,127.0.0.1");
});

test("per-scheme form prefers https entry for HTTPS_PROXY", () => {
  const env = proxyEnvFromSystem({
    enabled: true,
    server: "http=proxy-http.corp:8080;https=proxy-https.corp:8443",
  })!;
  assert.equal(env.HTTP_PROXY, "http://proxy-http.corp:8080");
  assert.equal(env.HTTPS_PROXY, "http://proxy-https.corp:8443");
});

test("socks-only config is not mirrored (v1: direct beats half-broken)", () => {
  assert.equal(proxyEnvFromSystem({ enabled: true, server: "socks=127.0.0.1:7890" }), null);
  assert.equal(proxyEnvFromSystem({ enabled: true, server: "" }), null);
});
