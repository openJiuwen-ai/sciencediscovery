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

"""pytest adapter for frozen tag plans. No per-case sidecar configuration."""
from __future__ import annotations

import ast
import contextvars
import hashlib
import json
import os
from pathlib import Path
import platform
from typing import Any

import pytest

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / 'schema.json').read_text())['groups']
CURRENT = contextvars.ContextVar('science_tagged_test', default=None)


def normalize_tags(values: list[str], *, partial: bool = False) -> list[str]:
    groups: dict[str, set[str]] = {}
    for tag in values:
        if not isinstance(tag, str) or tag.count(':') != 1:
            raise ValueError(f'Invalid tag: {tag!r}')
        group, value = tag.split(':')
        if group not in SCHEMA or value not in SCHEMA[group]['values']:
            raise ValueError(f'Unknown tag: {tag}')
        members = groups.setdefault(group, set())
        if value in members:
            raise ValueError(f'Duplicate tag: {tag}')
        members.add(value)
    for name, rule in SCHEMA.items():
        count = len(groups.get(name, set()))
        # A group with a default is declared only where a test deviates from it.
        # Materialised on the complete identity, never on the inheritance pass.
        if not partial and not count and 'default' in rule:
            groups[name] = {rule['default']}
            continue
        if not partial and 'default' not in rule and not count:
            raise ValueError(f'Missing tag group: {name}')
        if count > 1 and not rule['multiple']:
            raise ValueError(f'Conflicting values for {name}')
    return sorted(f'{group}:{value}' for group, values in groups.items() for value in values)


def tags_for(item: pytest.Item) -> list[str]:
    inherited: dict[str, list[str]] = {}
    for scope in item.listchain():
        own: dict[str, list[str]] = {}
        for mark in scope.own_markers:
            if mark.name != 'science_tags':
                continue
            if mark.args:
                raise ValueError('science_tags accepts keyword arguments only')
            for group, raw in mark.kwargs.items():
                if group in own:
                    raise ValueError(f'Duplicate tag group at one scope: {group}')
                values = [raw] if isinstance(raw, str) else raw
                if not isinstance(values, (list, tuple)):
                    raise ValueError(f'Invalid values for {group}')
                own[group] = [f'{group}:{value}' for value in values]
        normalize_tags([tag for values in own.values() for tag in values], partial=True)
        inherited.update(own)
    return normalize_tags([tag for values in inherited.values() for tag in values])


def audit_source(path: Path) -> None:
    """Reject dynamic identity/marker generation without importing test bodies."""
    tree = ast.parse(path.read_text(encoding='utf8'), filename=str(path))
    marks = {n.targets[0].id: n.value for n in tree.body if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Call) and ast.unparse(n.value.func).startswith('pytest.mark.')}
    def fail(node: ast.AST) -> None:
        raise ValueError(f'DYNAMIC_REGISTRATION: {path}:{getattr(node, "lineno", 1)}')
    def literal(node: ast.AST) -> bool:
        try:
            ast.literal_eval(node)
            return True
        except (ValueError, TypeError, SyntaxError):
            return False
    def check_mark(node: ast.AST) -> None:
        if isinstance(node, ast.Name) and node.id in marks:
            return check_mark(marks[node.id])
        if isinstance(node, (ast.List, ast.Tuple)):
            for child in node.elts:
                check_mark(child)
            return
        if isinstance(node, ast.Attribute):
            return
        if not isinstance(node, ast.Call):
            fail(node)
        for arg in node.args:
            if not literal(arg):
                # A source-owned JSON fixture is a static parameter table.
                helper = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name) and n.name == arg.func.id), None)
                if not helper or len(helper.body) != 1 or not isinstance(helper.body[0], ast.Return) or ast.unparse(helper.body[0].value) != "json.loads(_GOLDEN.read_text(encoding='utf-8'))['cases']":
                    fail(arg)
        for kw in node.keywords:
            if kw.arg == 'ids' and isinstance(kw.value, ast.Lambda) and ast.unparse(kw.value.body) == "case['name']":
                continue
            if kw.arg is None or not literal(kw.value):
                fail(kw.value)
    def visit_statements(nodes: list[ast.stmt]) -> None:
        for node in nodes:
            if isinstance(node, (ast.If, ast.For, ast.While, ast.Try, ast.With)):
                # Do not allow conditional definitions, deletions or mutations of
                # test names. Runtime checks belong inside tests/fixtures.
                main_guard = (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
                              and ast.unparse(node.test) in ["__name__ == '__main__'", '"__main__" == __name__'])
                if not main_guard:
                    fail(node)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name.startswith(('pytest_generate_tests', 'pytest_collection_', 'pytest_ignore_collect')):
                    fail(node)
                for decorator in node.decorator_list:
                    text = ast.unparse(decorator)
                    if isinstance(decorator, ast.Name) and decorator.id in marks:
                        check_mark(decorator)
                        continue
                    if node.name.startswith('test_') and not text.startswith(('pytest.mark.', 'unittest.skip', 'unittest.expectedFailure', 'staticmethod', 'classmethod')):
                        fail(decorator)
                    if 'pytest.mark.' in text or 'pytest.fixture' in text or 'unittest.skip' in text:
                        check_mark(decorator)
                # Function bodies are runtime code, not test registration.
            elif isinstance(node, ast.ClassDef):
                for decorator in node.decorator_list:
                    if node.name.startswith('Test') and not ast.unparse(decorator).startswith(('pytest.mark.', 'unittest.skip')):
                        fail(decorator)
                    if 'pytest.mark.' in ast.unparse(decorator):
                        check_mark(decorator)
                visit_statements(node.body)
            elif isinstance(node, ast.Assign):
                if any(not isinstance(target, ast.Name) or target.id.startswith('test_') for target in node.targets):
                    fail(node)
                if any(target.id == 'pytestmark' for target in node.targets):
                    check_mark(node.value)
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                if ast.unparse(node.value.func) == 'sys.path.insert':
                    continue  # Import-path bootstrap has no testcase identities.
                # Top-level calls can dynamically register tests, skip a module,
                # perform network I/O or change the collection environment.
                fail(node)
    visit_statements(tree.body)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def descriptor(item: pytest.Item, root: Path) -> dict[str, Any]:
    source = Path(item.path).resolve()
    relative = source.relative_to(root).as_posix()
    suffix = '::'.join(item.nodeid.split('::')[1:])
    return {'id': f'python:{relative}::{suffix}', 'source': relative,
            'sourceHash': hashlib.sha256(source.read_bytes()).hexdigest(),
            'runner': 'python', 'tags': tags_for(item)}


def pytest_addoption(parser):
    group = parser.getgroup('science-tags')
    group.addoption('--science-root')
    group.addoption('--science-catalog')
    group.addoption('--science-plan')
    group.addoption('--science-report')


def pytest_configure(config):
    config.addinivalue_line('markers', 'science_tags(**groups): closed, orthogonal static test tags')
    if not config.getoption('--science-root'):
        raise pytest.UsageError('--science-root is required for the science_tags plugin')
    if any(getattr(config.option, name, False) for name in ['markexpr', 'keyword', 'lf', 'failedfirst']):
        raise pytest.UsageError('Do not use -m/-k/--lf/--ff: the frozen plan owns selection')
    config.option.strict_markers = True
    config._science_state = {'root': Path(config.getoption('--science-root')).resolve(),
                             'catalog': [], 'original': [], 'selected': [], 'reports': {},
                             'contexts': {}, 'errors': [], 'audited': set()}


def pytest_collect_file(file_path, parent):
    state = parent.config._science_state
    path = Path(file_path).resolve()
    if path.suffix == '.py' and (path.name.startswith('test_') or path.name.endswith('_test.py') or path.name == 'conftest.py'):
        if path not in state['audited']:
            audit_source(path)
            state['audited'].add(path)



def pytest_pycollect_makemodule(module_path, parent):
    state = parent.config._science_state
    path = Path(module_path).resolve()
    if path not in state['audited']:
        audit_source(path)
        state['audited'].add(path)
    return None


def pytest_sessionstart(session):
    for _, plugin in session.config.pluginmanager.list_name_plugin():
        path = getattr(plugin, '__file__', '')
        if path and Path(path).name == 'conftest.py':
            audit_source(Path(path))


def pytest_itemcollected(item):
    item.config._science_state['original'].append(item.nodeid)


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(session, config, items):
    state = config._science_state
    if set(state['original']) != {item.nodeid for item in items}:
        raise pytest.UsageError('Another plugin modified the candidate set before tag selection')
    catalog = [descriptor(item, state['root']) for item in items]
    ids = [c['id'] for c in catalog]
    if len(set(ids)) != len(ids):
        raise pytest.UsageError('Duplicate collected testcase identities')
    state['catalog'] = catalog
    output = config.getoption('--science-catalog')
    if output:
        Path(output).write_text(json.dumps({'catalog': catalog}, ensure_ascii=False), encoding='utf8')
    plan_path = config.getoption('--science-plan')
    if not plan_path:
        if not config.option.collectonly:
            raise pytest.UsageError('Execution requires --science-plan; collection requires --collect-only')
        return
    plan = json.loads(Path(plan_path).read_text(encoding='utf8'))
    content = {key: value for key, value in plan.items() if key != 'digest'}
    if plan.get('version') != 1 or plan.get('digest') != sha(content) or not plan.get('entries'):
        raise pytest.UsageError('Invalid, empty or modified frozen plan')
    expected = {entry['id']: entry for entry in plan['entries']}
    if len(expected) != len(plan['entries']):
        raise pytest.UsageError('One Python worker accepts one target per testcase')
    selected, deselected = [], []
    for item, actual in zip(items, catalog):
        entry = expected.get(actual['id'])
        if entry is None:
            deselected.append(item)
            continue
        if actual['sourceHash'] != entry['sourceHash'] or actual['tags'] != entry['tags']:
            raise pytest.UsageError(f'COLLECTION_DRIFT: {actual["id"]}')
        item._science_entry = entry
        selected.append(item)
    if {item._science_entry['id'] for item in selected} != set(expected):
        raise pytest.UsageError('COLLECTION_DRIFT: planned testcase missing at execution')
    if not selected:
        raise pytest.UsageError('EMPTY_SELECTION')
    config.hook.pytest_deselected(items=deselected)
    items[:] = selected
    state['selected'] = selected


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_protocol(item, nextitem):
    entry = item._science_entry
    context = {'entry': entry, 'judge_calls': 0, 'evidence': []}
    item.config._science_state['contexts'][item.nodeid] = context
    token = CURRENT.set(context)
    try:
        yield
    finally:
        CURRENT.reset(token)


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    entry = item._science_entry
    for name in ['skip', 'skipif', 'xfail']:
        if item.get_closest_marker(name):
            pytest.fail(f'Forbidden {name}: selected cases must run and pass', pytrace=False)
    actual = {'os': {'Darwin': 'macos', 'Windows': 'windows', 'Linux': 'linux'}.get(platform.system(), platform.system()),
              'arch': {'x86_64': 'amd64', 'AMD64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine(), platform.machine())}
    if entry['target'] != actual:
        pytest.fail('Execution target mismatch', pytrace=False)
    if 'npu:required' in entry['tags']:
        pytest.fail('NPU runtime has not been verified by an execution adapter', pytrace=False)
    if 'model:real' in entry['tags'] or 'judge:llm' in entry['tags']:
        if os.environ.get('CI_ALLOW_REAL') != '1':
            pytest.fail('CI_ALLOW_REAL=1 is required', pytrace=False)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    context = CURRENT.get()
    if report.when == 'call' and report.passed and 'judge:llm' in item._science_entry['tags'] and not context['judge_calls']:
        report.outcome = 'failed'
        report.longrepr = 'judge:llm test did not call llm_assert'
    item.config._science_state['reports'].setdefault(item.nodeid, []).append(report)


def pytest_sessionfinish(session, exitstatus):
    config = session.config
    state = config._science_state
    destination = config.getoption('--science-report')
    if not destination:
        return
    results = []
    for item in state['selected']:
        reports = state['reports'].get(item.nodeid, [])
        if not reports:
            continue  # Missing identities remain NOT_RUN in the coordinator.
        outcome = 'PASS'
        if any(getattr(r, 'wasxfail', None) for r in reports):
            outcome = 'XFAIL'
        elif any(r.skipped for r in reports):
            outcome = 'SKIPPED'
        elif any(r.failed for r in reports) or not any(r.when == 'call' and r.passed for r in reports):
            outcome = 'FAIL'
        if any(sum(r.when == phase for r in reports) != 1 for phase in ['setup', 'call', 'teardown']):
            outcome = 'FAIL'
        if not any(r.when == 'teardown' and r.passed for r in reports):
            outcome = 'FAIL'
        entry = item._science_entry
        actual = {'os': {'Darwin': 'macos', 'Windows': 'windows', 'Linux': 'linux'}.get(platform.system(), platform.system()),
                  'arch': {'x86_64': 'amd64', 'AMD64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine(), platform.machine())}
        results.append({'key': entry['key'], 'outcome': outcome, 'actualTarget': actual,
                        'evidence': state['contexts'].get(item.nodeid, {}).get('evidence', [])})
    Path(destination).write_text(json.dumps({'results': results}, ensure_ascii=False), encoding='utf8')
    if not results or len(results) != len(state['selected']) or any(r['outcome'] != 'PASS' for r in results):
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
