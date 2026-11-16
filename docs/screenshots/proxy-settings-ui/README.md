# Proxy settings UI — review captures

Captured from the branch's own build (`apps/web` dist served by the branch's API server) on Windows, 1440×900. The registry values on this host are real: `HKCU Internet Settings` has `ProxyEnable=1, ProxyServer=127.0.0.1:7890` (bare form).

The captures cover the three behaviours the reviewers asked to see:

1. **staged-then-persisted editing** (zh-2 → zh-3 → zh-4, en-2 → en-3 → en-4),
2. **URL redaction in the list display** (zh-4, en-4 — `http://***:***@proxy.example.test:8080/`),
3. **the connectivity diagnostic failing and succeeding** (zh-5, zh-6).

| Capture | Locale | State shown |
| --- | --- | --- |
| `zh-1-default.png` | zh-CN | Network and proxy group, no drafts staged |
| `zh-2-staged-form.png` | zh-CN | Add-proxy form open with a name and a credentialed URL filled in (unsaved) |
| `zh-3-staged-entry.png` | zh-CN | Entry staged in the draft + default policy switched to it; nothing persisted yet |
| `zh-4-after-save.png` | zh-CN | After Save — entry persisted, list shows the redacted URL |
| `zh-5-test-failed.png` | zh-CN | Test connection against the fake proxy address: `连接失败: The operation was aborted due to timeout` |
| `zh-6-test-direct.png` | zh-CN | Test connection with direct policy: `下载源可达: Download source returned HTTP 200` |
| `en-1-default.png` | en | Same group in English, persisted state from the zh run visible |
| `en-2-edit-staged.png` | en | Edit form staged on the existing entry (unsaved) |
| `en-3-staged-default-change.png` | en | Default policy staged to "Do not use a proxy" (unsaved) |
| `en-4-after-save.png` | en | After Save — policy persisted, redacted URL still shown |

## win_desktop SOCKS mirror (process-environment level, no dialog)

The mirror has no web surface: it runs in the Windows shell before spawning the stack, so the visible proof is the function's output against the real registry plus the socks form. Output of `proxyEnvFromSystem` on this host, captured while preparing these screenshots:

```text
=== Real system proxy right now (ProxyEnable=1, ProxyServer=127.0.0.1:7890, bare form) ===
mirrored env: {"HTTP_PROXY":"http://127.0.0.1:7890","HTTPS_PROXY":"http://127.0.0.1:7890","NO_PROXY":"localhost,127.0.0.1","no_proxy":"localhost,127.0.0.1"}

=== System proxy with a socks= entry (the new increment) ===
mirrored env: {"ALL_PROXY":"socks5://127.0.0.1:7890","all_proxy":"socks5://127.0.0.1:7890","NO_PROXY":"localhost,127.0.0.1","no_proxy":"localhost,127.0.0.1"}

=== Mixed per-scheme + socks ===
mirrored env: {"HTTP_PROXY":"http://proxy.corp:8080","HTTPS_PROXY":"http://proxy.corp:8443","ALL_PROXY":"socks5://127.0.0.1:7890","all_proxy":"socks5://127.0.0.1:7890","NO_PROXY":"localhost,127.0.0.1","no_proxy":"localhost,127.0.0.1"}

=== Proxy disabled ===
mirrored env: null
```

The socks assertions (socks-only mirrors to `ALL_PROXY=socks5://…`; mixed configurations keep per-scheme `HTTP(S)_PROXY` entries alongside `ALL_PROXY`) are pinned by `win_desktop/test/proxy.test.ts` on this branch, and the child-process side of that contract (a SOCKS policy reaches pip only through `all_proxy`, with PySocks shipped in the managed environment) is asserted by `services/adapter/tests/test_network.py::test_external_request_traverses_a_socks5_proxy` and covered in `docs/{en,zh}/advanced-setup/configure-network-proxy.md`.
