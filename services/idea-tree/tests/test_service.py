import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from sciencediscovery_idea_tree import research_service, idea_tree_service
from sciencediscovery_idea_tree.mcp import _scopes
from sciencediscovery_idea_tree.server import app
from sciencediscovery_idea_tree.storage import save_json

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
AUTH = {"authorization": "Bearer idea-test"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN", "idea-test")
    monkeypatch.setenv("SCIENCE_AGENT_IDEA_TREE_DATA_DIR", str(tmp_path / "independent"))
    monkeypatch.setenv("SCIENCE_AGENT_IDEA_TREE_LEGACY_DATA_DIR", str(tmp_path / "legacy"))
    research_service._store = None
    idea_tree_service._store = None
    _scopes.clear()
    with TestClient(app) as c:
        yield c


def scope(client, **fields):
    response = client.post('/mcp/scopes', headers=AUTH, json=dict(projectId='p', sessionId='s', **fields))
    assert response.status_code == 200, response.text
    return '/mcp/' + response.json()['token']


def call(client, url, name, arguments):
    response = client.post(url, json=dict(jsonrpc='2.0', id=1, method='tools/call', params=dict(name=name, arguments=arguments)))
    assert response.status_code == 200, response.text
    return response.json()


def test_own_auth_health_and_mcp_protocol(client):
    assert client.get('/health').json()['service'] == 'idea-tree'
    assert client.get('/api/settings/idea-tree').status_code == 401
    assert client.post('/mcp/scopes', json=dict(projectId='p', sessionId='s')).status_code == 401
    assert client.post('/mcp/unknown', json={}).status_code == 401
    url = scope(client)
    initialized = client.post(url, json=dict(jsonrpc='2.0', id=1, method='initialize')).json()['result']
    assert initialized['protocolVersion'] == '2025-03-26'
    tools = client.post(url, json=dict(jsonrpc='2.0', id=2, method='tools/list')).json()['result']['tools']
    assert {tool['name'] for tool in tools} == {'create_idea_research', 'get_idea_research', 'control_idea_research', 'view_idea_tree'}
    for tool in tools:
        assert not {'projectId', 'sessionId', 'llm', 'token'} & tool['inputSchema']['properties'].keys()
    assert client.post(url, json=dict(jsonrpc='2.0', method='notifications/initialized')).status_code == 202
    assert client.post(url, json=[]).json()['error']['code'] == -32600
    assert client.delete(url).status_code == 204
    assert client.post(url, json={}).status_code == 401


def test_scope_isolation_and_invalid_arguments(client):
    url = scope(client)
    result = call(client, url, 'get_idea_research', {})['result']
    assert json.loads(result['content'][0]['text']) == {'items': []}
    assert call(client, url, 'get_idea_research', {'sessionId': 'other'})['error']['code'] == -32602
    assert call(client, url, 'get_idea_research', {'researchId': 123})['error']['code'] == -32602
    assert call(client, url, 'create_idea_research', {'objective': 'x', 'materials': ''})['result']['isError']
    assert call(client, url, 'control_idea_research', {'researchId': 'foreign', 'operation': 'continue'})['result']['isError']
    _scopes[url.rsplit('/', 1)[1]].expires = time.monotonic() - 1
    assert client.post(url, json={}).status_code == 401


def test_settings_import_is_once_and_updates_survive_restart(client, tmp_path):
    url = '/api/settings/idea-tree'
    before = client.get(url, headers=AUTH).json()
    assert before['maxDepth'] == 5
    imported = client.post('/settings/import', headers=AUTH, json={'maxDepth': 3}).json()
    assert imported['maxDepth'] == 3
    assert client.put(url, headers=AUTH, json={'maxDepth': 4, 'designSystemPrompt': '  plan  '}).json()['designSystemPrompt'] == 'plan'
    assert client.post('/settings/import', headers=AUTH, json={'maxDepth': 2}).json()['maxDepth'] == 4
    assert client.put(url, headers=AUTH, json={'designSystemPrompt': None}).status_code == 200
    assert 'designSystemPrompt' not in client.get(url, headers=AUTH).json()
    saved = json.loads((tmp_path / 'independent/settings.json').read_text())
    assert saved['maxDepth'] == 4
    assert client.put(url, headers=AUTH, json={'maxDepth': 0}).status_code == 400
    assert client.get(url, headers=AUTH).json()['maxDepth'] == 4


def test_mcp_runs_real_engine_and_streams_terminal_snapshot(client, monkeypatch):
    async def model(self, role, payload):
        await asyncio.sleep(.005)
        if role == 'ideate':
            value = dict(candidates=[dict(parentId='ROOT', hypothesis='Iron catalyst')], reason='Compare')
        elif role in {a['id'] for a in self.assessors()}:
            value = dict(text='Evidence-aware assessment', score=7)
        elif role == 'aggregate':
            value = dict(text='Synthesis', strengths=[], failureModes=[], uncertainties=[], evidenceGaps=[], recommendedNextMoves=[], constraintFlags=[], confidence=.5)
        else:
            value = dict(text='Synthesis with uncertainty')
        return json.dumps(value), 10
    # Replace only the model transport; lifecycle, persistence, tools and SSE are real.
    async def transport(self, role, payload):
        return await model(self, role, payload)
    original = research_service.IdeaTreeEngine.__init__
    def init(self, state, store, llm, custom=None):
        original(self, state, store, llm, lambda role, payload: transport(self, role, payload))
    monkeypatch.setattr(research_service.IdeaTreeEngine, '__init__', init)
    url = scope(client, researchId='research-test', modelId='model', llm=dict(url='http://127.0.0.1:1', token='model-secret-never-emit'), settings=dict(maxRounds=1, candidatesPerRound=1, maxDepth=1))
    created = call(client, url, 'create_idea_research', dict(objective='Compare iron catalysts', materials='User supplied evidence'))['result']
    assert not created['isError'], created
    assert json.loads(created['content'][0]['text'])['research']['id'] == 'research-test'
    payload = dict(projectId='p', sessionId='s', researchId='research-test', operation='get')
    response = client.post('/idea-tree/research/events', headers=AUTH, json=payload)
    assert response.headers['content-type'].startswith('text/event-stream')
    frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert frames[-1]['research']['status'] == 'completed', frames[-1]['research'].get('reason')
    assert any(n['score'] == 7 for n in frames[-1]['graph']['nodes'])
    assert 'model-secret-never-emit' not in response.text
    assert client.post('/idea-tree/research/command', headers=AUTH, json={**payload, 'sessionId': 'other'}).status_code == 404
    research_service._store = None
    restored = client.post('/idea-tree/research/command', headers=AUTH, json=payload).json()
    assert restored == frames[-1]


def test_legacy_tree_is_read_only(client):
    payload = dict(projectId='p', sessionId='s', operation='listTreeIds')
    assert client.post('/idea-tree/command', headers=AUTH, json=payload).json() == {'result': []}
    assert client.post('/idea-tree/command', headers=AUTH, json={**payload, 'operation': 'create'}).status_code == 409


def test_legacy_migration_preserves_originals_and_is_idempotent(tmp_path, monkeypatch):
    from sciencediscovery_idea_tree.migration import migrate_legacy
    legacy = tmp_path / 'legacy'
    target = tmp_path / 'target'
    monkeypatch.setenv('SCIENCE_AGENT_IDEA_TREE_LEGACY_DATA_DIR', str(legacy))
    monkeypatch.setenv('SCIENCE_AGENT_IDEA_TREE_DATA_DIR', str(target))
    source = legacy / 'idea-research/p/s/research-one.json'
    save_json(source, {'id': 'research-one', 'status': 'paused'})
    migrate_legacy()
    copy = target / 'idea-research/p/s/research-one.json'
    assert copy.read_bytes() == source.read_bytes()
    save_json(copy, {'id': 'research-one', 'status': 'completed'})
    migrate_legacy()
    assert json.loads(copy.read_text())['status'] == 'completed'
    assert json.loads(source.read_text())['status'] == 'paused'
