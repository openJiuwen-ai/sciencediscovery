# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Web-provider mapping and engine configuration kept behind the adapter."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from langchain_core.tools import BaseTool

# The vendor engine backs only the keyed community providers below. It is
# imported lazily so the agent path (which imports the engine package) never
# loads the vendor dependency; Gateway-implemented providers (ddgs, jina)
# work without it, and only vendor-backed provider invocation fails when the
# dependency is absent.
_VENDOR_SYMBOLS = ("AppConfig", "pop_current_app_config", "push_current_app_config", "resolve_variable")


def _ensure_vendor() -> None:
    missing = [name for name in _VENDOR_SYMBOLS if name not in globals()]
    if not missing:
        return
    try:
        from deerflow.config.app_config import AppConfig as _app_config
        from deerflow.config.app_config import pop_current_app_config as _pop
        from deerflow.config.app_config import push_current_app_config as _push
        from deerflow.reflection import resolve_variable as _resolve
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise RuntimeError("Engine-backed web providers are unavailable: the bundled engine dependency is not installed") from exc
    loaded = {
        "AppConfig": _app_config,
        "pop_current_app_config": _pop,
        "push_current_app_config": _push,
        "resolve_variable": _resolve,
    }
    # Only fill the gaps: a test may hold an active patch on one symbol while
    # another symbol was delattr-ed by a previous patch's exit.
    globals().update({name: loaded[name] for name in missing})


def __getattr__(name: str):
    if name in _VENDOR_SYMBOLS:
        _ensure_vendor()
        return globals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


_PROVIDER_PATHS: dict[tuple[str, str], str] = {
    ("search", "tavily"): "deerflow.community.tavily.tools:web_search_tool",
    ("search", "exa"): "deerflow.community.exa.tools:web_search_tool",
    ("search", "brave"): "deerflow.community.brave.tools:web_search_tool",
    ("fetch", "tavily"): "deerflow.community.tavily.tools:web_fetch_tool",
    ("fetch", "exa"): "deerflow.community.exa.tools:web_fetch_tool",
}
_GATEWAY_PROVIDERS = {("search", "ddgs"), ("fetch", "jina")}
_KEYED_PROVIDERS = {"tavily", "exa", "brave"}
_SANDBOX_PROVIDER = "deerflow.sandbox.local:LocalSandboxProvider"
_PROXY_ENV_KEYS = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
_PROXY_VARIABLES = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "DDGS_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)


@dataclass(frozen=True)
class ResolvedWebProvider:
    api_key: str | None
    backend: str | None
    operation: str
    provider: str
    provider_path: str | None
    proxy: str | None
    proxy_environment: dict[str, str] | None
    proxy_mode: str

    @property
    def engine_backed(self) -> bool:
        return self.provider_path is not None

    @property
    def requires_isolation(self) -> bool:
        return self.engine_backed and (
            self.proxy_mode != "environment" or self.proxy_environment is not None
        )

    def serialize(self) -> dict[str, Any]:
        return {
            "operation": self.operation,
            "provider": self.provider,
            "options": {
                **({"api_key": self.api_key} if self.api_key else {}),
                **({"backend": self.backend} if self.backend else {}),
                **({"proxy": self.proxy} if self.proxy else {}),
                **({"proxy_environment": self.proxy_environment} if self.proxy_environment is not None else {}),
                "proxy_mode": self.proxy_mode,
            },
        }


def _optional_string(options: dict[str, Any], name: str) -> str | None:
    value = options.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    return value


def resolve_web_provider(
    operation: str,
    provider: str,
    options: dict[str, Any],
) -> ResolvedWebProvider:
    """Validate product options and resolve the private provider implementation."""

    provider_path = _PROVIDER_PATHS.get((operation, provider))
    if provider_path is None and (operation, provider) not in _GATEWAY_PROVIDERS:
        raise ValueError(f"{provider} does not support {operation}")

    api_key = _optional_string(options, "api_key")
    if provider in _KEYED_PROVIDERS and (api_key is None or not api_key.strip()):
        raise ValueError(f"{provider} requires a non-empty API key")

    proxy_mode = options.get("proxy_mode", "environment")
    if proxy_mode not in {"environment", "custom", "direct"}:
        raise ValueError("Invalid web proxy mode")
    proxy = _optional_string(options, "proxy")
    if proxy_mode == "custom":
        if proxy is None or not proxy.strip():
            raise ValueError("Custom web proxy mode requires a proxy URL")
        parsed_proxy = urlsplit(proxy)
        if parsed_proxy.scheme not in {"http", "https", "socks5"} or not parsed_proxy.hostname:
            raise ValueError("Invalid custom web proxy URL")
        proxy = proxy.strip()
    elif proxy is not None:
        raise ValueError("A proxy URL is only allowed in custom mode")

    proxy_environment = options.get("proxy_environment")
    if proxy_mode == "environment" and proxy_environment is not None:
        if not isinstance(proxy_environment, dict) or not set(proxy_environment).issubset(_PROXY_ENV_KEYS):
            raise ValueError("proxyEnvironment must use canonical proxy variable names")
        for name, value in proxy_environment.items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")
            if name != "NO_PROXY":
                parsed_environment_proxy = urlsplit(value)
                if parsed_environment_proxy.scheme not in {"http", "https", "socks5"} \
                        or not parsed_environment_proxy.hostname:
                    raise ValueError(f"Invalid {name} URL")
        proxy_environment = dict(proxy_environment)
    elif proxy_environment is not None:
        raise ValueError("proxyEnvironment is only allowed in environment mode")

    backend = _optional_string(options, "backend")
    if provider == "ddgs":
        backend = backend or "bing"
        if backend not in {"bing", "auto", "duckduckgo"}:
            raise ValueError("Invalid DDGS backend")
    elif backend is not None:
        raise ValueError("backend is only supported by the DDGS provider")

    resolved = ResolvedWebProvider(
        api_key=api_key.strip() if api_key else None,
        backend=backend,
        operation=operation,
        provider=provider,
        provider_path=provider_path,
        proxy=proxy,
        proxy_environment=proxy_environment,
        proxy_mode=proxy_mode,
    )
    if resolved.engine_backed:
        # Build and validate the vendor configuration at the boundary so route
        # code never sees its schema or Python type.
        _provider_config(resolved)
    return resolved


def _provider_config(provider: ResolvedWebProvider):
    if provider.provider_path is None:
        raise ValueError("The selected provider is implemented by the Gateway")
    _ensure_vendor()
    return globals()["AppConfig"].model_validate({
        "sandbox": {
            "allow_host_bash": False,
            "use": _SANDBOX_PROVIDER,
        },
        "tools": [{
            **({"api_key": provider.api_key} if provider.api_key else {}),
            "group": "web",
            "name": f"web_{provider.operation}",
            **({"proxy": provider.proxy} if provider.proxy else {}),
            **({"proxy_env": provider.proxy_environment} if provider.proxy_environment is not None else {}),
            "proxy_mode": provider.proxy_mode,
            "trust_env": provider.proxy_mode == "environment",
            "use": provider.provider_path,
        }],
    })


async def invoke_web_provider(
    provider: ResolvedWebProvider,
    arguments: dict[str, Any],
    timeout_seconds: float,
) -> str:
    """Invoke an engine-backed provider with request-scoped configuration."""

    if provider.provider_path is None:
        raise ValueError("The selected provider is implemented by the Gateway")
    config = _provider_config(provider)
    globals()["push_current_app_config"](config)
    try:
        tool = globals()["resolve_variable"](provider.provider_path, BaseTool)
        result = await asyncio.wait_for(tool.ainvoke(arguments), timeout=timeout_seconds)
    finally:
        globals()["pop_current_app_config"]()
    return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)


def configure_web_proxy_environment(provider: ResolvedWebProvider) -> None:
    """Apply one isolated worker's explicit proxy policy to its environment."""

    if provider.proxy_mode == "environment" and provider.proxy_environment is None:
        return
    for name in _PROXY_VARIABLES:
        os.environ.pop(name, None)
    if provider.proxy_mode == "environment":
        os.environ.update(provider.proxy_environment or {})
    elif provider.proxy_mode == "custom" and provider.proxy:
        for name in (
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "DDGS_PROXY",
            "http_proxy", "https_proxy", "all_proxy",
        ):
            os.environ[name] = provider.proxy


async def invoke_serialized_web_provider(payload: dict[str, Any]) -> str:
    provider_data = payload.get("provider")
    if not isinstance(provider_data, dict):
        raise ValueError("provider payload must be an object")
    options = provider_data.get("options")
    if not isinstance(options, dict):
        raise ValueError("provider options must be an object")
    provider = resolve_web_provider(
        str(provider_data.get("operation", "")),
        str(provider_data.get("provider", "")),
        options,
    )
    configure_web_proxy_environment(provider)
    arguments = payload.get("arguments")
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    return await invoke_web_provider(provider, arguments, float(payload.get("timeout_seconds", 30)))


async def invoke_isolated_web_provider(
    provider: ResolvedWebProvider,
    arguments: dict[str, Any],
    timeout_seconds: float,
) -> str:
    """Invoke a provider in a subprocess so proxy environment changes stay local."""

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "science_agent_gateway.web_worker",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    payload = json.dumps({
        "arguments": arguments,
        "provider": provider.serialize(),
        "timeout_seconds": timeout_seconds,
    }).encode()
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(payload), timeout=timeout_seconds)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise TimeoutError("Web provider subprocess timed out") from None
    try:
        result = json.loads(stdout)
    except (TypeError, ValueError) as exc:
        detail = stderr.decode(errors="replace")[-1_000:]
        raise RuntimeError(f"Web provider subprocess returned invalid output: {detail}") from exc
    if process.returncode != 0 or not isinstance(result, dict) or not isinstance(result.get("content"), str):
        message = result.get("error") if isinstance(result, dict) else None
        raise RuntimeError(message or "Web provider subprocess failed")
    return result["content"]
