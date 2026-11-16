// System proxy mirroring. Pure functions only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRegDword, parseRegQueryValue, parseScutilProxy, parseScutilValue, proxyEnvFromSystem } from "../src/proxy.ts";

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
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
});

test("per-scheme form prefers https entry for HTTPS_PROXY", () => {
  const env = proxyEnvFromSystem({
    enabled: true,
    server: "http=proxy-http.corp:8080;https=proxy-https.corp:8443",
  })!;
  assert.equal(env.HTTP_PROXY, "http://proxy-http.corp:8080");
  assert.equal(env.HTTPS_PROXY, "http://proxy-https.corp:8443");
});

test("socks-only config mirrors to ALL_PROXY with loopback bypass", () => {
  const env = proxyEnvFromSystem({ enabled: true, server: "socks=127.0.0.1:7890" })!;
  assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:7890");
  assert.equal(env.all_proxy, "socks5://127.0.0.1:7890");
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
  assert.equal(proxyEnvFromSystem({ enabled: true, server: "" }), null);
});

test("mixed http + socks config keeps per-scheme HTTP entries and mirrors socks", () => {
  const env = proxyEnvFromSystem({
    enabled: true,
    server: "http=proxy-http.corp:8080;socks=127.0.0.1:7890",
  })!;
  assert.equal(env.HTTP_PROXY, "http://proxy-http.corp:8080");
  assert.equal(env.HTTPS_PROXY, "http://proxy-http.corp:8080");
  assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:7890");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
});

// --- macOS: scutil --proxy (D2 §6) -----------------------------------------------

const SCUTIL_OFF = [
  "<dictionary> {",
  "  ExceptionsList : \"localhost\", \"127.0.0.1\"",
  "  FTPPassive : 1",
  "  HTTPEnable : 0",
  "  HTTPSEnable : 0",
  "  SOCKSEnable : 0",
  "}",
].join("\n");

const SCUTIL_HTTP = [
  "<dictionary> {",
  "  HTTPEnable : 1",
  "  HTTPProxy : 127.0.0.1",
  "  HTTPPort : 7890",
  "  HTTPSEnable : 0",
  "  HTTPSEnable : 0",
  "  SOCKSEnable : 0",
  "}",
].join("\n");

const SCUTIL_HTTPS_SOCKS_EXCEPTIONS = [
  "<dictionary> {",
  "  ExceptionsList : \"localhost\", \"127.0.0.1\", \"*.local\", \"169.254/16\"",
  "  HTTPEnable : 0",
  "  HTTPSEnable : 1",
  "  HTTPSProxy : proxy.corp.example.com",
  "  HTTPSPort : 8443",
  "  SOCKSEnable : 1",
  "  SOCKSProxy : 127.0.0.1",
  "  SOCKSPort : 7891",
  "}",
].join("\n");

const SCUTIL_SOCKS_ONLY = [
  "<dictionary> {",
  "  HTTPEnable : 0",
  "  HTTPSEnable : 0",
  "  SOCKSEnable : 1",
  "  SOCKSProxy : 127.0.0.1",
  "  SOCKSPort : 7890",
  "}",
].join("\n");

test("parseScutilValue picks the right key and tolerates the dictionary wrapper", () => {
  assert.equal(parseScutilValue(SCUTIL_HTTP, "HTTPProxy"), "127.0.0.1");
  assert.equal(parseScutilValue(SCUTIL_HTTP, "HTTPPort"), "7890");
  assert.equal(parseScutilValue(SCUTIL_HTTP, "HTTPEnable"), "1");
  assert.equal(parseScutilValue(SCUTIL_OFF, "HTTPEnable"), "0");
  assert.equal(parseScutilValue(SCUTIL_HTTP, "Missing"), null);
  assert.equal(parseScutilValue("", "HTTPEnable"), null);
});

test("parseScutilProxy: proxy off → null (not mirrored)", () => {
  assert.equal(parseScutilProxy(SCUTIL_OFF), null);
});

test("parseScutilProxy: http-only mirrors with the shared per-scheme syntax", () => {
  const settings = parseScutilProxy(SCUTIL_HTTP)!;
  assert.equal(settings.enabled, true);
  assert.equal(settings.server, "http=127.0.0.1:7890");
  // Downstream: the shared proxyEnvFromSystem handles it like win32.
  const env = proxyEnvFromSystem(settings)!;
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
});

test("parseScutilProxy: https + socks + exceptions (full fixture)", () => {
  const settings = parseScutilProxy(SCUTIL_HTTPS_SOCKS_EXCEPTIONS)!;
  // socks is collected into the server string but never wins alone.
  assert.equal(settings.server, "https=proxy.corp.example.com:8443;socks=127.0.0.1:7891");
  assert.deepEqual(settings.exceptions, ["localhost", "127.0.0.1", "*.local", "169.254/16"]);
  // Downstream: https wins, socks mirrored too (upstream 2e9feb09), exceptions join NO_PROXY.
  const env = proxyEnvFromSystem(settings)!;
  assert.equal(env.HTTP_PROXY, "http://proxy.corp.example.com:8443");
  assert.equal(env.HTTPS_PROXY, "http://proxy.corp.example.com:8443");
  assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:7891");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,localhost,127.0.0.1,*.local,169.254/16");
});

test("parseScutilProxy: socks-only → null (same v1 call as win32)", () => {
  assert.equal(parseScutilProxy(SCUTIL_SOCKS_ONLY), null);
});

test("parseScutilProxy: PAC/autoproxy output is not mirrored (v1: static HTTP(S) only)", () => {
  const pac = [
    "<dictionary> {",
    "  ProxyAutoConfigEnable : 1",
    "  ProxyAutoConfigURLString : http://pac.corp/proxy.pac",
    "  HTTPEnable : 0",
    "  HTTPSEnable : 0",
    "}",
  ].join("\n");
  assert.equal(parseScutilProxy(pac), null);
});

test("parseScutilProxy: enabled proxy with missing host/port → null (defensive)", () => {
  const broken = "<dictionary> {\n  HTTPEnable : 1\n  HTTPSEnable : 0\n}";
  assert.equal(parseScutilProxy(broken), null);
});
