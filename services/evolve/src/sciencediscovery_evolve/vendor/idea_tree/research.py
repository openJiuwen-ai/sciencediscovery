"""Single-writer, stage-persisted research. Models supply content, never control tools."""
from __future__ import annotations

import asyncio
import json
import math
import os
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import prompts
from .research_tree import ResearchTree


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Interrupted(Exception):
    pass


class BudgetReached(Exception):
    pass


def text(value: Any, name: str, limit: int = 24000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{name} must contain 1–{limit} characters")
    return value.strip()


def validate_result(role: str, value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    if role == "ideate":
        if not isinstance(value.get("candidates"), list):
            raise ValueError("candidates must be an array")
        for item in value["candidates"]:
            if not isinstance(item, dict):
                raise ValueError("Invalid candidate")
            text(item.get("hypothesis"), "hypothesis", 4000)
            if not item.get("parentId"):
                text(item.get("direction"), "direction", 1000)
        text(value.get("reason"), "reason", 4000)
    else:
        text(value.get("text"), "text")
        if role in prompts.CRITERIA:
            score = value.get("score")
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 1 <= score <= 10:
                raise ValueError("Assessment score must be finite and between 1 and 10")
    return value


class ResearchStore:
    def __init__(self, root: Path):
        self.root = root

    def path(self, project: str, session: str, research: str) -> Path:
        for part in (project, session, research):
            if not part or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in part):
                raise ValueError("Invalid research scope")
        return self.root / project / session / f"{research}.json"

    def save(self, state: dict) -> None:
        path = self.path(state['projectId'], state['sessionId'], state['id'])
        path.parent.mkdir(parents=True, exist_ok=True)
        state['updatedAt'] = now()
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False, encoding='utf-8') as out:
            temporary = out.name
            try:
                json.dump(state, out, ensure_ascii=False, allow_nan=False)
                out.flush()
                os.fsync(out.fileno())
            except BaseException:
                os.unlink(temporary)
                raise
        try:
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def read(self, project: str, session: str, research: str) -> dict:
        return json.loads(self.path(project, session, research).read_text())

    def list(self, project: str, session: str) -> list[dict]:
        directory = self.path(project, session, 'unused').parent
        return sorted((json.loads(p.read_text()) for p in directory.glob('*.json')), key=lambda s: s['createdAt'], reverse=True)


def node(identifier: str, parent: str | None, hypothesis: str, kind: str, depth: int) -> dict:
    return dict(id=identifier, parentId=parent, hypothesis=hypothesis, kind=kind, depth=depth,
                status='pending', score=None, insight=None, stages={}, childrenIds=[], createdAt=now(), updatedAt=now())


class IdeaTreeEngine:
    def __init__(self, state: dict, store: ResearchStore, endpoint: dict, call=None):
        self.state, self.store, self.endpoint = state, store, endpoint
        self.stop_action: str | None = None
        self.call_override = call
        self.reserved = 0
        self.usage_lock = asyncio.Lock()

    def save(self):
        self.store.save(self.state)

    def check_stop(self):
        if self.stop_action:
            raise Interrupted()

    def role_prompt(self, role):
        config = self.state['settings']
        fields = {'design': 'designSystemPrompt', 'aggregate': 'aggregatorSystemPrompt', 'propagate': 'propagateInsightSystemPrompt'}
        if role == 'ideate':
            return prompts.IDEATE
        if role in prompts.CRITERIA:
            return config.get('assessor' + role.title(), {}).get('systemPrompt') or prompts.ASSESS
        return config.get(fields[role]) or prompts.DEFAULTS[role]

    def transport(self, system, payload, ceiling):
        body = json.dumps(dict(messages=[dict(role='system', content=system), dict(role='user', content=json.dumps(payload, ensure_ascii=False))], max_tokens=ceiling, temperature=0.5)).encode()
        request = urllib.request.Request(self.endpoint['url'], data=body, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.endpoint['token']})
        for attempt in range(2):
            try:
                with urllib.request.urlopen(request, timeout=1230) as response:
                    result = json.load(response)
                return result['choices'][0]['message']['content'], result.get('usage', {}).get('total_tokens')
            except urllib.error.HTTPError as error:
                if error.code >= 500 and attempt == 0:
                    continue
                detail = error.read(1000).decode(errors='replace')
                raise RuntimeError(f"Model HTTP {error.code}: {detail}") from error
            except (urllib.error.URLError, TimeoutError):
                raise

    async def ask(self, role: str, payload: dict) -> dict:
        self.check_stop()
        shape = '{"candidates":[{"parentId":"existing id or omit", "direction":"new direction", "hypothesis":"..."}],"reason":"..."}' if role == 'ideate' else ('{"text":"...","score":1.0}' if role in prompts.CRITERIA else '{"text":"..."}')
        system = self.role_prompt(role) + '\nReturn JSON only, matching: ' + shape
        for attempt in range(2):
            self.check_stop()
            ceiling = self.state['settings']['maxTokensPerCall']
            # Conservative UTF-8 bound; no tokenizer/model dependency in the state engine.
            estimate = len((system + json.dumps(payload, ensure_ascii=False)).encode()) + ceiling + 256
            async with self.usage_lock:
                budget = self.state['settings'].get('maxTokens')
                if budget and self.state['tokens'] + self.reserved + estimate > budget:
                    raise BudgetReached('Remaining token budget cannot fund the next stage')
                self.reserved += estimate
            try:
                if self.call_override:
                    raw, usage = await self.call_override(role, payload)
                else:
                    raw, usage = await asyncio.to_thread(self.transport, system, payload, ceiling)
                if isinstance(usage, int) and not isinstance(usage, bool) and usage >= 0:
                    self.state['tokens'] += usage
                else:
                    self.state['usageKnown'] = False
                self.save()
                self.check_stop()
                if budget and not self.state['usageKnown']:
                    raise RuntimeError('Model did not report token usage; cannot enforce the configured token budget')
            finally:
                async with self.usage_lock:
                    self.reserved -= estimate
            try:
                return validate_result(role, json.loads(raw))
            except (ValueError, TypeError) as error:
                if attempt:
                    raise ValueError(f'{role}: invalid model result after one correction: {error}') from error
                payload = {**payload, 'correction': str(error), 'previousResponse': str(raw)[:4000]}
        raise AssertionError('unreachable')

    def context(self):
        return dict(objective=self.state['objective'], materials=self.state['materials'])

    def overview(self):
        # Keep every direction, plus recent and best candidates. Full stage outputs stay on disk.
        directions = [n for n in self.state['nodes'] if n['kind'] == 'direction']
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        best = sorted((n for n in candidates if n['score'] is not None), key=lambda n: n['score'], reverse=self.state['settings']['scoreDirection'] == 'maximize')[:10]
        selected = {n['id']: n for n in directions[:20] + candidates[-20:] + best}
        return [dict(id=n['id'], parentId=n['parentId'], depth=n['depth'], kind=n['kind'], hypothesis=n['hypothesis'], score=n['score'], status=n['status'], insight=(n['insight'] or '')[:1200]) for n in selected.values()]

    async def stage(self, candidate, role, payload):
        if role not in candidate['stages']:
            self.state['phase'] = role
            self.state['currentNodeId'] = candidate['id']
            self.save()
            value = await self.ask(role, payload)
            self.check_stop()
            candidate['stages'][role] = value
            self.save()
        return candidate['stages'][role]

    async def evaluate(self, candidate):
        candidate['status'] = 'running'
        candidate['attemptCount'] = candidate.get('attemptCount', 0) + 1
        self.save()
        base = {**self.context(), 'hypothesis': candidate['hypothesis'], 'ancestorInsights': self.ancestors(candidate)}
        design = await self.stage(candidate, 'design', base)
        async def assess(role):
            cfg = self.state['settings'].get('assessor' + role.title(), {})
            return await self.stage(candidate, role, {**base, 'candidate': design, 'perspective': role, 'criteria': cfg.get('scoringCriteria') or prompts.CRITERIA[role]})
        # With a token cap, sequential requests avoid falsely exhausting the budget on reservations.
        if self.state['settings'].get('maxTokens'):
            assessments = [await assess(role) for role in prompts.CRITERIA]
        else:
            results = await asyncio.gather(*(assess(role) for role in prompts.CRITERIA), return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
            assessments = results
        weights = [self.state['settings'].get('assessor' + role.title(), {}).get('weight', default) for role, default in zip(prompts.CRITERIA, [0.35, 0.35, 0.30])]
        score = sum(a['score'] * w for a, w in zip(assessments, weights))
        aggregate = await self.stage(candidate, 'aggregate', {**base, 'candidate': design, 'assessments': dict(zip(prompts.CRITERIA, assessments)), 'weightedScore': score})
        candidate.update(status='done', score=round(score, 4), insight=aggregate['text'], updatedAt=now())
        self.save()
        await self.propagate(candidate)

    def ancestors(self, candidate):
        tree = ResearchTree(self.state['nodes'])
        return [dict(id=n.data['id'], insight=n.data['insight']) for n in tree.get_ancestors(tree.find(candidate['id']).index)]

    def find(self, identifier):
        return ResearchTree(self.state['nodes']).find(identifier).data

    async def propagate(self, candidate):
        completed = candidate.setdefault('propagatedTo', [])
        for ancestor in self.ancestors(candidate):
            identifier = ancestor['id']
            if identifier in completed:
                continue
            parent = self.find(identifier)
            children = [self.find(i) for i in parent['childrenIds']]
            self.state.update(phase='propagate', currentNodeId=identifier)
            self.save()
            summary = await self.ask('propagate', {**self.context(), 'parent': parent['hypothesis'], 'ownAssessment': parent['stages'].get('aggregate'), 'children': [dict(hypothesis=n['hypothesis'], score=n['score'], insight=n['insight']) for n in children if n['insight']]})
            parent['insight'] = summary['text']
            completed.append(identifier)
            self.save()

    def add(self, parent, hypothesis, kind):
        config = self.state['settings']
        if parent['depth'] >= config['maxDepth'] or len(self.state['nodes']) >= config['maxNodes']:
            return None
        identifier = str(len(self.state['nodes']))
        n = node(identifier, parent['id'], hypothesis, kind, parent['depth'] + 1)
        self.state['nodes'].append(n)
        parent['childrenIds'].append(identifier)
        return n

    async def run(self):
        s = self.state
        s.update(status='running', reason=None)
        self.save()
        try:
            while s['round'] < s['settings']['maxRounds'] or s['batch']:
                self.check_stop()
                if not s['batch']:
                    remaining = s['settings']['maxSearchRounds'] - sum(n['kind'] == 'candidate' for n in s['nodes'])
                    if remaining <= 0 or len(s['nodes']) >= s['settings']['maxNodes']:
                        s['reason'] = 'Candidate or node limit reached'
                        break
                    s.update(phase='ideate', currentNodeId=None)
                    self.save()
                    count = min(s['settings']['candidatesPerRound'], remaining)
                    ideas = await self.ask('ideate', {**self.context(), 'nodes': self.overview(), 'round': s['round'] + 1, 'maximumCandidates': count, 'maxDepth': s['settings']['maxDepth'], 'scoreDirection': s['settings']['scoreDirection']})
                    # Reject the whole proposal before changing the tree.
                    known_ids = {n['id'] for n in s['nodes']}
                    if any(p.get('parentId') and p['parentId'] not in known_ids for p in ideas['candidates'][:count]):
                        raise ValueError('Proposed parent does not exist')
                    batch = []
                    existing = {n['hypothesis'].strip().casefold() for n in s['nodes']}
                    for proposal in ideas['candidates'][:count]:
                        if proposal['hypothesis'].strip().casefold() in existing:
                            continue
                        parent_id = proposal.get('parentId')
                        parent = next((n for n in s['nodes'] if n['id'] == parent_id), None)
                        if not parent:
                            if parent_id:
                                raise ValueError('Proposed parent does not exist')
                            direction = proposal['direction']
                            parent = next((n for n in s['nodes'] if n['kind'] == 'direction' and n['hypothesis'] == direction), None)
                            required = 1 if parent or s['settings']['maxDepth'] == 1 else 2
                            if len(s['nodes']) + required > s['settings']['maxNodes']:
                                break
                            parent = self.find('ROOT') if s['settings']['maxDepth'] == 1 else (parent or self.add(self.find('ROOT'), direction, 'direction'))
                        if parent and parent['depth'] >= s['settings']['maxDepth']:
                            parent = self.find(parent['parentId']) if parent['parentId'] else parent
                        candidate = self.add(parent, proposal['hypothesis'], 'candidate') if parent else None
                        if candidate:
                            batch.append(candidate['id'])
                            existing.add(candidate['hypothesis'].strip().casefold())
                    if not batch:
                        s['reason'] = ideas['reason'] if not ideas['candidates'] else 'No new legal candidate fits the remaining tree limits'
                        break
                    s['batch'] = batch
                    s['batchCompleted'] = 0
                    s['round'] += 1
                    self.save()
                for identifier in s['batch']:
                    candidate = self.find(identifier)
                    if candidate.get('cycleComplete'):
                        continue
                    if candidate['status'] == 'done':
                        await self.propagate(candidate)
                    else:
                        await self.evaluate(candidate)
                    candidate['cycleComplete'] = True
                    s['batchCompleted'] += 1
                    self.save()
                s['batch'] = []
                self.save()
            s.update(status='completed', phase='complete', reason=s['reason'] or 'Exploration round limit reached')
        except Interrupted:
            s.update(status='ended' if self.stop_action == 'end' else 'paused', reason='Ended by user' if self.stop_action == 'end' else 'Paused by user')
        except BudgetReached as error:
            s.update(status='paused', reason=str(error))
        except Exception as error:
            if self.stop_action:
                s.update(status='ended' if self.stop_action == 'end' else 'paused', reason='Stopped by user')
            else:
                s.update(status='interrupted', reason=str(error))
        finally:
            self.save()

    def graph(self):
        s = self.state
        nodes = []
        for n in s['nodes']:
            nodes.append({**n, 'searchStatus': 'active', 'priority': 0, 'attemptCount': n.get('attemptCount', 0), 'artifactRefs': [], 'activeExecutionId': None, 'lastExecutionId': None, 'completedResultHandle': None, 'pruneReason': None, 'result': json.dumps(n['stages'], ensure_ascii=False) if n['stages'] else None})
        return dict(treeId=s['id'], objective=s['objective'], revision=0, updatedAt=s['updatedAt'], nodes=nodes, edges=[dict(source=n['parentId'], target=n['id'], type='child', ordinal=i) for i, n in enumerate(nodes) if n['parentId']])
