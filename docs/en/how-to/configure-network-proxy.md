# Configure the Network Proxy

ScienceDiscovery applies proxy settings to governed Web Search and Web Fetch requests, and to local control-plane services started by the launcher. This guide shows how to configure and verify that behavior.

## Configure the proxy

Set either a shared proxy or protocol-specific values:

```bash
export SCIENCE_AGENT_PROXY=http://127.0.0.1:7890
```

Or:

```bash
export SCIENCE_AGENT_HTTP_PROXY=http://127.0.0.1:7890
export SCIENCE_AGENT_HTTPS_PROXY=http://127.0.0.1:7890
```

Set bypass hosts with `SCIENCE_AGENT_NO_PROXY`:

```bash
export SCIENCE_AGENT_NO_PROXY=127.0.0.1,localhost,.internal.example
```

Lowercase standard variables (`http_proxy`, `https_proxy`, and `no_proxy`) are also recognized. ScienceDiscovery-specific variables take precedence over standard variables.

## Start the stack

For a local source checkout:

```bash
./scripts/start-stack.sh
```

For Docker Compose, place the variables in `.env.docker` or export them before starting the stack:

```bash
docker compose --env-file .env.docker up -d
```

## Verify the effective settings

Check the API health endpoint and then perform a Web Search or Web Fetch from a session. Proxy credentials are masked in logs and status responses; do not expect the password to be displayed.

```bash
curl --fail http://127.0.0.1:4310/api/health
```

If a destination must bypass the proxy, add its host or domain suffix to `SCIENCE_AGENT_NO_PROXY` and restart the affected process. A leading dot such as `.example.org` matches that domain and its subdomains.

For precedence, URL validation, and trust-boundary details, see [Network proxy](../explanation/network-proxy.md). For all variables, see [Configuration reference](../reference/configuration.md).
