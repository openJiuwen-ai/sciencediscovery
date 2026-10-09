from sciencediscovery_adapter.config import Settings
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))


def test_defaults_are_the_native_backend_on_the_documented_ports():
    settings = Settings.from_env({})
    assert (settings.port, settings.legacy_url, settings.executor) == (4310, "http://127.0.0.1:4410", "native")
    assert settings.tool_timeout_s == 3600 and settings.agent_token == ""


def test_the_executor_is_read_from_the_same_variable_the_api_reads():
    assert Settings.from_env({"SCIENCE_AGENT_EXECUTOR": "jiuwenswarm"}).executor == "jiuwenswarm"
    assert Settings.from_env({"SCIENCE_AGENT_EXECUTOR": " jiuwenswarm "}).executor == "jiuwenswarm"
    assert Settings.from_env({"SCIENCE_AGENT_EXECUTOR": "something-else"}).executor == "native"


def test_ports_urls_token_and_tool_timeout_come_from_the_environment():
    settings = Settings.from_env({
        "SCIENCE_AGENT_PORT": "5000", "JIUWENSWARM_GATEWAY_URL": "ws://h:1/tui", "JIUWENSWARM_MGMT_URL": "ws://h:2/ws",
        "SCIENCE_AGENT_ADAPTER_TOKEN": "t", "SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S": "120",
    })
    assert settings.port == 5000 and settings.legacy_url == "http://127.0.0.1:5100" and settings.public_url == "http://127.0.0.1:5000"
    assert (settings.gateway_url, settings.mgmt_url, settings.agent_token, settings.tool_timeout_s) == ("ws://h:1/tui", "ws://h:2/ws", "t", 120)


def test_the_apis_access_token_is_read_for_the_info_route():
    assert Settings.from_env({"SCIENCE_AGENT_AUTH_TOKEN": " abc "}).api_token == "abc"
    assert Settings.from_env({}).api_token == ""
