"""Run: services/idea-tree/.venv/bin/python test/api/idea-tree-service-journey.py

Purpose: start research over MCP, pause, restart the independent service, continue,
and recover scored candidates through SSE. Starts the product CLI, not an ASGI test app.
Environment: Python with services/idea-tree installed; loopback ports and owned data only.
Type: mocked. LLM: local HTTP stub. WebSearch/PaperSources/OtherExternal: none.
MCP: real service tools. Credentials: generated local service and model tokens.
CostSideEffects: no paid calls; writes only under --output (default .tmp/idea-tree-journey).
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='.tmp/idea-tree-journey')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = (root / args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    run = output / secrets.token_hex(6)
    run.mkdir()
    token, model_token = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    entered, release = threading.Event(), threading.Event()
    steps = []
    process = None
    log = (run / 'service.log').open('w')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()
    if dirty:
        raise SystemExit('Commit the candidate before this formal journey; tracked source must remain unchanged.')

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            if self.headers.get('Authorization') != 'Bearer ' + model_token:
                self.send_error(401)
                return
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            payload = json.loads(body['messages'][-1]['content'])
            entered.set()
            if not release.wait(30):
                self.send_error(504)
                return
            value = dict(text='Local fixture synthesis with uncertainty', score=7, confidence=.5,
                         strengths=[], failureModes=[], uncertainties=[], evidenceGaps=[],
                         recommendedNextMoves=[], constraintFlags=[], reason='Explore the supplied evidence',
                         candidates=[dict(parentId='ROOT', hypothesis=f'Iron catalyst variant {payload.get("round", 1)}')])
            reply = json.dumps(dict(choices=[dict(message=dict(content=json.dumps(value)))], usage=dict(total_tokens=10))).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

    model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    thread = threading.Thread(target=model.serve_forever, daemon=True)
    thread.start()
    env = {**os.environ, 'SCIENCE_AGENT_IDEA_TREE_PORT': str(port),
           'SCIENCE_AGENT_IDEA_TREE_HOST': '127.0.0.1', 'SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN': token,
           'SCIENCE_AGENT_IDEA_TREE_DATA_DIR': str(run / 'data'),
           'SCIENCE_AGENT_IDEA_TREE_LEGACY_DATA_DIR': str(run / 'empty-legacy')}

    def request(path, body=None, method=None, auth=True):
        headers = {'Content-Type': 'application/json'}
        if auth:
            headers['Authorization'] = 'Bearer ' + token
        return urllib.request.urlopen(urllib.request.Request(origin + path,
            data=None if body is None else json.dumps(body).encode(), headers=headers, method=method), timeout=30)

    def api(path, body=None, method=None):
        with request(path, body, method) as response:
            return json.load(response)

    def until(check, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                result = check()
                if result:
                    return result
            except (urllib.error.URLError, ConnectionError):
                pass
            threading.Event().wait(.05)
        raise AssertionError('Expected observable state did not arrive before the deadline')

    def start():
        nonlocal process
        process = subprocess.Popen([sys.executable, '-m', 'sciencediscovery_idea_tree.server'], cwd=root, env=env, stdout=log, stderr=log)
        until(lambda: api('/health')['service'] == 'idea-tree')

    def stop():
        nonlocal process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process = None

    def new_scope(session='session', research='research-journey'):
        return '/mcp/' + api('/mcp/scopes', dict(projectId='project', sessionId=session, researchId=research,
            modelId='fixture', llm=dict(url=f'http://127.0.0.1:{model.server_port}/v1/chat/completions', token=model_token)))['token']

    def call(scope, name, arguments):
        reply = api(scope, dict(jsonrpc='2.0', id=1, method='tools/call', params=dict(name=name, arguments=arguments)))
        assert 'error' not in reply, reply
        result = reply['result']
        assert not result.get('isError'), result
        return json.loads(result['content'][0]['text'])

    def state(scope):
        return call(scope, 'get_idea_research', dict(researchId='research-journey'))

    def step(name, details):
        steps.append((name, details))
        print(f'{len(steps)}. PASS: {name}', flush=True)

    outcome, failure = 'FAIL', ''
    try:
        start()
        api('/api/settings/idea-tree', dict(maxDepth=1, explorationIntensity='quick'), 'PUT')
        scope = new_scope()
        names = api(scope, dict(jsonrpc='2.0', id=1, method='tools/list'))['result']['tools']
        assert len(names) == 4
        step('Discover scoped MCP tools and save research settings', 'Four tools; independent service process; no evolve process.')
        created = call(scope, 'create_idea_research', dict(objective='Compare iron catalysts', materials='User-supplied evidence: study-A'))
        assert created['research']['status'] == 'running'
        assert entered.wait(10)
        step('Start research through MCP with prepared evidence', 'Research running; real engine reached the local model callback.')
        call(scope, 'control_idea_research', dict(researchId='research-journey', operation='pause'))
        release.set()
        paused = until(lambda: value if (value := state(scope))['research']['status'] == 'paused' else None)
        step('Pause active research', 'Paused status persisted; model response does not advance a paused stage.')
        stop()
        start()
        scope = new_scope()
        restored = state(scope)
        assert restored['research']['status'] == 'paused'
        assert api('/api/settings/idea-tree')['maxDepth'] == 1
        step('Restart the service and recover state', 'Paused research and saved settings survive process restart.')
        foreign = new_scope(session='other')
        denied = api(foreign, dict(jsonrpc='2.0', id=1, method='tools/call', params=dict(name='get_idea_research', arguments=dict(researchId='research-journey'))))
        assert denied['result']['isError']
        step('Reject a cross-session read', 'A capability for another session cannot read this research.')
        call(scope, 'control_idea_research', dict(researchId='research-journey', operation='continue'))
        with request('/idea-tree/research/events', dict(projectId='project', sessionId='session', operation='get', researchId='research-journey')) as stream:
            frames = [json.loads(line[6:]) for line in stream.read().decode().splitlines() if line.startswith('data: ')]
        final = frames[-1]
        assert final['research']['status'] == 'completed', final['research']
        assert any(n['score'] == 7 for n in final['graph']['nodes'])
        assert model_token not in json.dumps(frames)
        step('Continue and receive scored results through SSE', f'{len(frames)} snapshots; completed research; independently assessed candidate score 7.')
        golden = json.loads((root / 'test/contract/fixtures/idea-tree-lifecycle.json').read_text())
        observed = [item['research']['status'] for item in [created, paused, restored, final]]
        assert observed == golden['statuses']
        assert api('/references/skill', dict(projectId='project', sessionId='session', skillId='idea-tree-team'))['referenced']
        api('/idea-tree/research/command', dict(projectId='project', sessionId='session', operation='delete'))
        until(lambda: call(scope, 'get_idea_research', {})['items'] == [])
        step('Check skill references and delete journey-owned research', 'Persistent reference detected; cleanup removes only the owned session research.')
        outcome = 'PASS'
    except Exception as exc:
        failure = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        release.set()
        stop()
        model.shutdown()
        model.server_close()
        log.close()
        report = [f'# Idea Tree service journey: {outcome}', '', f'Commit: `{sha}`',
                  f'Command: `{sys.executable} test/api/idea-tree-service-journey.py --output {args.output}`',
                  'Mocked model, no external services, separate CLI process and owned data directory.', '',
                  '| Step | Outcome | Evidence |', '| --- | --- | --- |']
        report += [f'| {i}. {name} | PASS | {detail} |' for i, (name, detail) in enumerate(steps, 1)]
        if failure:
            report += ['', f'Failure: {failure}', 'See service.log for the process boundary evidence.']
        (run / 'report.md').write_text('\n'.join(report) + '\n', encoding='utf-8')
        print(f'{outcome}: {run / "report.md"}', flush=True)


if __name__ == '__main__':
    main()
