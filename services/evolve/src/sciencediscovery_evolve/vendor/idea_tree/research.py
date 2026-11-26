"""Single-writer, stage-persisted research. Models supply content, never control tools."""
from __future__ import annotations

import asyncio
import json
import math
import os
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import prompts
from .research_tree import ResearchTree
from .templates import snapshot


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Interrupted(Exception):
    pass


class BudgetReached(Exception):
    pass


class EmptyAnswer(ValueError):
    """The model returned no content; the correction asks for the same answer again."""


def text(value: Any, name: str, limit: int = 24000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{name} must contain 1–{limit} characters")
    return value.strip()


def parse_json(raw: str) -> Any:
    """The model's JSON, also when it is wrapped in one Markdown code fence as many models do.

    `strict=False` accepts a raw control character inside a string — the newline a
    model writes into a multi-line field instead of escaping it as \\n. That is the
    one deviation a stage cannot recover from: it gets a single correction, and a
    research that spent its whole budget reaches `propagate` with the longest text.
    Truncated or non-JSON answers still raise.
    """
    body = raw.strip() if isinstance(raw, str) else raw
    if isinstance(body, str) and body.startswith('```'):
        first, _, rest = body.partition('\n')
        if rest.rstrip().endswith('```') and first.strip('`').strip().lower() in ('', 'json'):
            body = rest.rstrip()[:-3].strip()
    try:
        return json.loads(body, strict=False)
    except json.JSONDecodeError as error:
        # A model sometimes emits two consecutive JSON objects and `json.loads`
        # stops with "Extra data: line N column 1". Every trailing chunk has to
        # parse as JSON for that reading to be accepted; objects are merged, and
        # anything else re-raises the original error so genuine garbage still fails.
        # Two rules make the tolerance predictable instead of accidental: at most
        # eight objects in total are read (a ninth keeps the original error rather
        # than merging forever), and a key both objects carry keeps the later value
        # — a list is not concatenated, so a restated field replaces the first one.
        if 'Extra data' not in str(error):
            raise
        decoder = json.JSONDecoder(strict=False)
        try:
            value, index = decoder.raw_decode(body)
            # `raw_decode` reports an offset relative to the slice it was given, so
            # the next slice starts where that chunk ended inside the whole body.
            chunks = 1
            while True:
                rest = body[index:].lstrip(" \t\r\n,")
                if not rest:
                    return value
                if chunks >= 8:
                    raise error
                extra, end = decoder.raw_decode(rest)
                if not (isinstance(value, dict) and isinstance(extra, dict)):
                    raise error
                value = {**value, **extra}
                index = len(body) - len(rest) + end
                chunks += 1
        except json.JSONDecodeError:
            raise error
        raise error


def validate_result(role: str, value: Any, assessor_roles: set[str]) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    if role == "ideate":
        if not isinstance(value.get("candidates"), list):
            raise ValueError("candidates must be an array")
        for item in value["candidates"]:
            if not isinstance(item, dict):
                raise ValueError("Invalid candidate")
            text(item.get("hypothesis"), "hypothesis", 4000)
            if not isinstance(item.get('refinements', []), list):
                raise ValueError('refinements must be an array')
            for refinement in item.get('refinements', []):
                text(refinement, 'refinement', 1000)
            for key in ('basedOnCandidateIds', 'addressesInsightIds'):
                if key in item and (not isinstance(item[key], list) or not all(isinstance(identifier, str) for identifier in item[key])):
                    raise ValueError(f'{key} must be an array of ids')
            if item.get('targetedWeakness') is not None:
                text(item['targetedWeakness'], 'targetedWeakness', 2000)
            for key in ('expectedImprovement', 'newRisk', 'rationale'):
                if item.get(key) is not None:
                    text(item[key], key, 2000)
            if item.get('explorationType') not in (None, 'exploit', 'explore'):
                raise ValueError('explorationType must be exploit or explore')
            if not item.get("parentId"):
                text(item.get("direction"), "direction", 1000)
        text(value.get("reason"), "reason", 4000)
    else:
        text(value.get("text"), "text")
        if role in assessor_roles:
            score = value.get("score")
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 1 <= score <= 10:
                raise ValueError("Assessment score must be finite and between 1 and 10")
        if role == 'aggregate':
            for key in ('strengths', 'failureModes', 'uncertainties', 'evidenceGaps', 'recommendedNextMoves', 'constraintFlags'):
                if not isinstance(value.get(key), list) or not all(isinstance(item, str) and item.strip() for item in value[key]):
                    raise ValueError(f'{key} must be an array of non-empty strings')
            confidence = value.get('confidence')
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
                raise ValueError('confidence must be between 0 and 1')
    return value


class ResearchStore:
    def __init__(self, root: Path):
        self.root = root
        self.listeners: dict[str, set[asyncio.Queue]] = {}

    def path(self, project: str, session: str, research: str) -> Path:
        for part in (project, session, research):
            if not part or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in part):
                raise ValueError("Invalid research scope")
        return self.root / project / session / f"{research}.json"

    def save(self, state: dict) -> None:
        path = self.path(state['projectId'], state['sessionId'], state['id'])
        path.parent.mkdir(parents=True, exist_ok=True)
        # One durable checkpoint, one revision. A live frame names the revision its
        # changes were computed from, so the counter has to move with every save
        # rather than with the tree shape: token counts and activities change too.
        state['revision'] = int(state.get('revision', 0)) + 1
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

        # Publish only after the checkpoint is durable. Each subscriber needs the
        # latest state, not a backlog of full trees while its network is slow.
        for queue in self.listeners.get(state['id'], ()):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(True)

    def read(self, project: str, session: str, research: str) -> dict:
        # The writer stores UTF-8 (see save above); a read that lets the host pick
        # the codec fails on a Chinese Windows install, where the default is cp936.
        return json.loads(self.path(project, session, research).read_text(encoding='utf-8'))

    def list(self, project: str, session: str) -> list[dict]:
        directory = self.path(project, session, 'unused').parent
        return sorted((json.loads(p.read_text(encoding='utf-8')) for p in directory.glob('*.json')), key=lambda s: s['createdAt'], reverse=True)


def node(identifier: str, parent: str | None, hypothesis: str, kind: str, depth: int) -> dict:
    return dict(id=identifier, parentId=parent, hypothesis=hypothesis, kind=kind, depth=depth,
                status='pending', score=None, insight=None, insightRecords=[], stages={}, childrenIds=[],
                searchStatus='active', priority=0.0, createdAt=now(), updatedAt=now())


def graph_node(n: dict, heavy: bool = True) -> dict:
    """One node in the shape the read models expose.

    `heavy=False` is the shape a live frame carries: `result` is a serialisation of
    `stages` the tree view never draws (it duplicates, it does not summarise), and
    `insightRecords` is the engine's own learning log. Both grow with the research
    rather than with what changed, so a frame leaves them out; both stay available
    on an explicit `get`.
    """
    view = {**n, 'searchStatus': n.get('searchStatus', 'active'), 'priority': n.get('priority', 0),
            'attemptCount': n.get('attemptCount', 0), 'artifactRefs': [], 'activeExecutionId': None,
            'lastExecutionId': None, 'completedResultHandle': None, 'pruneReason': n.get('pruneReason')}
    if heavy:
        # Serialised only for an explicit `get`: a frame never builds the string it
        # would drop, which is the whole point of the lean shape.
        view['result'] = json.dumps(n['stages'], ensure_ascii=False) if n['stages'] else None
    else:
        view.pop('insightRecords', None)
    return view


def node_signature(n: dict) -> tuple:
    """Everything a frame's node carries, as something cheap to compare.

    A delta frame only serialises a node whose signature moved, so every mutable
    node field has to be named here: a field this misses is a change no connected
    client would ever see. A stage object is compared by its own text and score, so
    a rewritten stage is still a change; stages hold opaque strings, which compare
    in O(1) when they are the same object and by length first when they are not.
    """
    return (n.get('parentId'), n.get('hypothesis'), n.get('kind'), n.get('depth'), n.get('status'),
            n.get('score'), n.get('insight'), n.get('searchStatus', 'active'), n.get('priority', 0),
            n.get('pruneReason'), n.get('attemptCount', 0), tuple(n['childrenIds']),
            tuple((role, value.get('text'), value.get('score')) for role, value in n['stages'].items()),
            n.get('createdAt'), n.get('updatedAt'),
            n.get('cycleComplete'), tuple(n.get('propagatedTo', ())), n.get('trimmedDirection'),
            tuple(n.get('derivedFromCandidateIds', ())), tuple(n.get('addressesInsightIds', ())),
            n.get('targetedWeakness'), n.get('explorationType'))


def graph_edges(nodes: list[dict], only: set[str] | None = None) -> list[dict]:
    """The tree's child edges, in node order; `only` limits them to the given targets."""
    return [dict(source=n['parentId'], target=n['id'], type='child', ordinal=i)
            for i, n in enumerate(nodes) if n['parentId'] and (only is None or n['id'] in only)]


def is_permanent_quota(detail: str) -> bool:
    """True when a 429 body reports exhausted quota/billing, which no wait fixes.

    Provider-agnostic: only the `insufficient_quota` marker is treated as
    permanent. A plain `rate_limit_exceeded` is transient and stays retriable.
    """
    return 'insufficient_quota' in detail.lower()


# The budget check sets this aside before one model call. It is a reservation,
# not a cap: since #1281 the request itself sends no max_tokens.
OUTPUT_RESERVATION_TOKENS = 32768

class IdeaTreeEngine:
    # Retry budget for the model transport, shared by 429 and 5xx: one retry
    # after the first attempt. The protocol-compatibility suite pins exactly
    # two upstream calls on a persistent provider failure, so enlarging this
    # needs that suite updated in the same change.
    MAX_ATTEMPTS = 2
    # Longest single backoff wait. A provider may ask for more, but the wait
    # must stay bounded and pause/cancel must stay responsive.
    MAX_RETRY_AFTER_SECONDS = 60.0
    # Poll interval while waiting out a retry, so a pause/end lands promptly.
    RETRY_POLL_SECONDS = 0.25

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
        template = self.state.setdefault('template', snapshot('scientific-hypothesis-general/v1'))
        fields = {'design': 'designSystemPrompt', 'aggregate': 'aggregatorSystemPrompt', 'propagate': 'propagateInsightSystemPrompt'}
        if role == 'ideate':
            nodes = self.state['nodes']
            if not any(n['kind'] == 'candidate' for n in nodes) or not any(n.get('insightRecords') for n in nodes):
                return prompts.IDEATE + '\n' + prompts.IDEATE_EXPLORE_ONLY
            return prompts.IDEATE
        assessor = next((item for item in template['assessors'] if item['id'] == role), None)
        if assessor:
            return assessor.get('systemPrompt') or prompts.ASSESS
        return config.get(fields[role]) or template[role]

    def assessors(self):
        return self.state.setdefault('template', snapshot('scientific-hypothesis-general/v1'))['assessors']

    def retry_delay(self, error: urllib.error.HTTPError, attempt: int) -> float:
        """Backoff before retrying `attempt` (0-based). Honors the provider's
        Retry-After delay when it is a plain number of seconds, capped so the
        wait stays bounded; otherwise the fixed backoff the Agent client uses
        (500ms, doubling, capped at 4s)."""
        headers = getattr(error, 'headers', None) or {}
        try:
            after = float(headers.get('Retry-After'))
        except (TypeError, ValueError):
            after = None
        if after is not None and math.isfinite(after):
            return max(0.0, min(after, self.MAX_RETRY_AFTER_SECONDS))
        return min(4.0, 0.5 * 2 ** attempt)

    def wait_for_retry(self, delay: float) -> None:
        """Wait out a retry delay in short slices, so pause/cancel lands
        promptly instead of only after the whole wait."""
        remaining = delay
        while remaining > 0:
            self.check_stop()
            step = min(self.RETRY_POLL_SECONDS, remaining)
            time.sleep(step)
            remaining -= step
        self.check_stop()

    def transport(self, system, payload):
        # No temperature: some gateways accept only their own value (Kimi: "only 1 is allowed"). See completion.py.
        # No max_tokens either: the per-call cap was removed (#1281), so the call
        # leaves that ceiling to the model and the service behind it.
        # No reasoning_effort either: every stage keeps the model profile's own thinking level.
        fields = dict(messages=[dict(role='system', content=system), dict(role='user', content=json.dumps(payload, ensure_ascii=False))])
        body = json.dumps(fields).encode()
        request = urllib.request.Request(self.endpoint['url'], data=body, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.endpoint['token']})
        for attempt in range(self.MAX_ATTEMPTS):
            try:
                with urllib.request.urlopen(request, timeout=1230) as response:
                    result = json.load(response)
                usage = result.get('usage')
                return result['choices'][0]['message']['content'], usage.get('total_tokens') if isinstance(usage, dict) else None
            except urllib.error.HTTPError as error:
                detail = error.read(1000).decode(errors='replace')
                try:
                    if error.code == 429 and is_permanent_quota(detail):
                        raise RuntimeError(f"Model HTTP 429: permanent quota error, not retried: {detail}") from error
                    if (error.code == 429 or error.code >= 500) and attempt + 1 < self.MAX_ATTEMPTS:
                        self.wait_for_retry(self.retry_delay(error, attempt))
                        continue
                    if error.code == 429:
                        raise RuntimeError(f"Model HTTP 429: retry budget exhausted after {self.MAX_ATTEMPTS} attempts: {detail}") from error
                    raise RuntimeError(f"Model HTTP {error.code}: {detail}") from error
                finally:
                    error.close()
            except (urllib.error.URLError, TimeoutError):
                raise

    async def ask(self, role: str, payload: dict, check=None) -> dict:
        activity = dict(role=role, nodeId=self.state.get('currentNodeId'),
                        round=self.state['round'] + (1 if role == 'ideate' else 0), status='running', startedAt=now(), finishedAt=None, error=None)
        self.state.setdefault('activities', []).append(activity)
        self.save()
        try:
            result = await self._ask(role, payload, check)
            activity['status'] = 'completed'
            return result
        except (Interrupted, BudgetReached):
            activity['status'] = 'stopped'
            raise
        except Exception as error:
            activity.update(status='failed', error=str(error))
            raise
        finally:
            activity['finishedAt'] = now()
            self.save()

    async def _ask(self, role: str, payload: dict, check=None) -> dict:
        """The model's validated result. `check` adds rules that need the tree; breaking one gets the same one correction."""
        self.check_stop()
        shape = '{"candidates":[{"parentId":"selected id", "direction":"new direction when needed", "refinements":[], "hypothesis":"...", "basedOnCandidateIds":[], "addressesInsightIds":[], "targetedWeakness":"...", "expectedImprovement":"...", "newRisk":"...", "rationale":"...", "explorationType":"exploit or explore"}],"reason":"..."}' if role == 'ideate' else ('{"text":"...","score":1.0}' if role in {item['id'] for item in self.assessors()} else ('{"text":"...","strengths":[],"failureModes":[],"uncertainties":[],"evidenceGaps":[],"recommendedNextMoves":[],"constraintFlags":[],"confidence":0.0}' if role == 'aggregate' else '{"text":"..."}'))
        system = self.role_prompt(role) + '\nReturn JSON only, matching: ' + shape
        for attempt in range(2):
            self.check_stop()
            # Reservation only, not a cap: the request no longer sends max_tokens
            # (#1281). The bound stays so the total-budget check keeps its shape.
            estimate = len((system + json.dumps(payload, ensure_ascii=False)).encode()) + OUTPUT_RESERVATION_TOKENS + 256
            async with self.usage_lock:
                budget = self.state['settings'].get('maxTokens')
                if budget and self.state['tokens'] + self.state.get('unreportedBudgetEstimate', 0) + self.reserved + estimate > budget:
                    raise BudgetReached('Remaining token budget cannot fund the next stage')
                self.reserved += estimate
            usage = None
            received = False
            try:
                if self.call_override:
                    raw, usage = await self.call_override(role, payload)
                else:
                    raw, usage = await asyncio.to_thread(self.transport, system, payload)
                received = True
            finally:
                async with self.usage_lock:
                    # Settle actual usage and release its reservation together.
                    if isinstance(usage, int) and not isinstance(usage, bool) and 0 <= usage <= 2**53 - 1:
                        self.state['tokens'] += usage
                    else:
                        self.state['usageKnown'] = False
                        # Admission reserve only, never reported usage or a cost estimate.
                        if received:
                            self.state['unreportedBudgetEstimate'] = self.state.get('unreportedBudgetEstimate', 0) + estimate
                    self.reserved -= estimate
            self.save()
            self.check_stop()
            try:
                # An empty answer is a content failure like any other, so it takes the
                # same single correction and the model is told its previous answer was
                # empty. Raising here instead used to end a research that one more
                # call could have saved, because the check sat outside this branch
                # (#1327). A second empty answer still fails the stage, by name.
                if raw is None or isinstance(raw, str) and not raw.strip():
                    raise EmptyAnswer('empty or truncated model output; stage cannot continue')
                result = validate_result(role, parse_json(raw), {item['id'] for item in self.assessors()})
                if check:
                    check(result)
                return result
            except (ValueError, TypeError) as error:
                if attempt:
                    raise ValueError(f'{role}: invalid model result after one correction: {error}') from error
                # An empty answer is not a malformed one, so the correction asks for the
                # same answer again instead of repeating a rejection the model cannot act on.
                correction = ('empty or truncated model output; answer again with the required JSON'
                              if isinstance(error, EmptyAnswer) else str(error))
                payload = {**payload, 'correction': correction, 'previousResponse': str(raw)[:4000] if raw is not None else ''}
        raise AssertionError('unreachable')

    def context(self):
        return dict(objective=self.state['objective'], materials=self.state['materials'])

    def descendant_candidates(self, parent):
        by_parent = {}
        for current in self.state['nodes']:
            by_parent.setdefault(current['parentId'], []).append(current)
        descendants = []
        pending = list(by_parent.get(parent['id'], []))
        while pending:
            current = pending.pop()
            if current['kind'] == 'candidate' and current['score'] is not None:
                descendants.append(current)
            pending.extend(by_parent.get(current['id'], []))
        return descendants

    def select_directions(self):
        """Choose branches from evidence, unresolved lessons, and exploration budget."""
        settings = self.state['settings']
        scored = [n['score'] for n in self.state['nodes'] if n['kind'] == 'candidate' and n['score'] is not None]
        high = max(scored, default=10)
        low = min(scored, default=1)
        direction = settings['scoreDirection']
        choices = []
        for current in self.state['nodes']:
            if current.get('searchStatus', 'active') != 'active' or current['depth'] >= settings['maxDepth']:
                continue
            if current['kind'] == 'candidate' and current['status'] != 'done':
                continue
            if current['kind'] not in ('direction', 'candidate') and current['id'] != 'ROOT':
                continue
            descendants = self.descendant_candidates(current)
            visits = len(descendants)
            records = [record for candidate in descendants for record in candidate.get('insightRecords', [])]
            unresolved = sum(len(record.get('uncertainties', [])) + len(record.get('evidenceGaps', [])) for record in records)
            hard_constraints = sum(len(record.get('constraintFlags', [])) for record in records)
            if visits >= settings.get('pruneMinAssessments', 3) and descendants:
                best = max(n['score'] for n in descendants) if direction == 'maximize' else min(n['score'] for n in descendants)
                global_best = high if direction == 'maximize' else low
                behind_frontier = (global_best - best if direction == 'maximize' else best - global_best) >= settings.get('pruneScoreGap', 2.5)
                if behind_frontier and (hard_constraints >= visits or unresolved == 0):
                    current.update(searchStatus='pruned', pruneReason='Repeated assessments are below the evidence frontier without a remaining validation question')
                    continue
            evidence = .5 if not descendants or high == low else ((max(n['score'] for n in descendants) - low) / (high - low) if direction == 'maximize' else (high - min(n['score'] for n in descendants)) / (high - low))
            uncertainty = 1 / math.sqrt(visits + 1)
            coverage = 1 / (len(current['childrenIds']) + 1)
            learning_need = min(1, unresolved / max(1, 2 * visits))
            current['priority'] = round(evidence + .25 * uncertainty + .15 * coverage + .2 * learning_need, 4)
            choices.append(current)
        root = next((item for item in choices if item['id'] == 'ROOT'), None)
        ranked = sorted((item for item in choices if item['id'] != 'ROOT'), key=lambda item: (-item['priority'], item['id']))
        limit = settings.get('maxActiveDirections', 3)
        exploration_slots = min(settings.get('explorationSlots', 0), limit)
        should_explore = root and (not ranked or (exploration_slots and self.state['round'] % max(1, limit) < exploration_slots))
        selected = ranked[:limit - int(bool(should_explore))]
        if should_explore:
            selected.append(root)
        return selected

    def overview(self, selected):
        """Give ideation the chosen branches, their lineage, and representative evidence."""
        included = {n['id']: n for n in selected}
        for current in selected:
            for ancestor in self.ancestors(current):
                included[ancestor['id']] = self.find(ancestor['id'])
            for candidate in self.descendant_candidates(current):
                included[candidate['id']] = candidate
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate' and n['score'] is not None]
        best = sorted(candidates, key=lambda n: n['score'], reverse=self.state['settings']['scoreDirection'] == 'maximize')[:10]
        included.update({n['id']: n for n in best})
        return [dict(id=n['id'], parentId=n['parentId'], depth=n['depth'], kind=n['kind'], hypothesis=n['hypothesis'][:600], score=n['score'], status=n['status'], searchStatus=n.get('searchStatus', 'active'), priority=n.get('priority', 0), insight=(n['insight'] or '')[:1200], insightRecords=n.get('insightRecords', [])[-3:]) for n in included.values()]

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

    async def evaluate(self, candidate, propagate_insight=True):
        if candidate['kind'] != 'candidate' or candidate['childrenIds']:
            raise ValueError('Only candidate leaves can be evaluated')
        candidate['status'] = 'running'
        candidate['attemptCount'] = candidate.get('attemptCount', 0) + 1
        self.save()
        base = {**self.context(), 'hypothesis': candidate['hypothesis'], 'ancestorInsights': self.ancestors(candidate)}
        design = await self.stage(candidate, 'design', base)
        async def assess(spec):
            role = spec['id']
            return await self.stage(candidate, role, {**base, 'candidate': design, 'perspective': role, 'criteria': spec['criteria']})
        # With a token cap, sequential requests avoid falsely exhausting the budget on reservations.
        if self.state['settings'].get('maxTokens'):
            assessments = [await assess(spec) for spec in self.assessors()]
        else:
            results = await asyncio.gather(*(assess(spec) for spec in self.assessors()), return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
            assessments = results
        weights = [spec['weight'] for spec in self.assessors()]
        score = sum(a['score'] * w for a, w in zip(assessments, weights))
        aggregate = await self.stage(candidate, 'aggregate', {**base, 'candidate': design, 'assessments': dict(zip((spec['id'] for spec in self.assessors()), assessments)), 'weightedScore': score})
        candidate.update(status='done', score=round(score, 4), insight=aggregate['text'], updatedAt=now())
        candidate.setdefault('insightRecords', []).append(dict(
            id=f"insight-{candidate['id']}-{len(candidate.get('insightRecords', [])) + 1}",
            sourceCandidateId=candidate['id'], score=candidate['score'], scoreBreakdown={spec['id']: assessment['score'] for spec, assessment in zip(self.assessors(), assessments)},
            summary=aggregate['text'], strengths=aggregate['strengths'], failureModes=aggregate['failureModes'], uncertainties=aggregate['uncertainties'], evidenceGaps=aggregate['evidenceGaps'], recommendedNextMoves=aggregate['recommendedNextMoves'], constraintFlags=aggregate['constraintFlags'], confidence=aggregate['confidence'], createdAt=now(),
        ))
        self.save()
        if propagate_insight:
            await self.propagate(candidate)

    def ancestors(self, candidate):
        tree = ResearchTree(self.state['nodes'])
        return [dict(id=n.data['id'], insight=(n.data['insight'] or '')[:1200]) for n in tree.get_ancestors(tree.find(candidate['id']).index)]

    def find(self, identifier):
        return ResearchTree(self.state['nodes']).find(identifier).data

    async def propagate(self, candidate):
        completed = candidate.setdefault('propagatedTo', [])
        changed = candidate
        for ancestor in self.ancestors(candidate):
            identifier = ancestor['id']
            parent = self.find(identifier)
            if identifier in completed:
                changed = parent
                continue
            children = [self.find(i) for i in parent['childrenIds']]
            # Incremental summarization: retain prior lessons and the changed branch,
            # together with a bounded set of recent and best sibling findings.
            assessed = [n for n in children if n['score'] is not None]
            best = sorted(assessed, key=lambda n: n['score'], reverse=self.state['settings']['scoreDirection'] == 'maximize')[:5]
            relevant = {n['id']: n for n in children[-10:] + best + [changed]}
            self.state.update(phase='propagate', currentNodeId=identifier)
            self.save()
            summary = await self.ask('propagate', {**self.context(), 'parent': parent['hypothesis'], 'isRoot': identifier == 'ROOT', 'priorSummary': (parent['insight'] or '')[:4000], 'ownAssessment': parent['stages'].get('aggregate'), 'children': [dict(hypothesis=n['hypothesis'][:600], score=n['score'], insight=n['insight'][:1200]) for n in relevant.values() if n['insight']]})
            parent['insight'] = summary['text']
            parent.setdefault('insightRecords', []).append(dict(id=f"insight-{parent['id']}-{len(parent.get('insightRecords', [])) + 1}", sourceCandidateId=candidate['id'], summary=summary['text'], createdAt=now()))
            changed = parent
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

    def proposal_path(self, proposal):
        depth = self.state['settings']['maxDepth']
        parent_id = proposal.get('parentId')
        parent = self.find(parent_id) if parent_id else self.find('ROOT')
        if parent.get('searchStatus', 'active') != 'active' or parent['depth'] >= depth:
            raise ValueError('Parent is not an active expandable branch')
        if parent['kind'] == 'candidate' and parent['status'] != 'done':
            raise ValueError('A candidate can branch only after evaluation')
        if parent['kind'] == 'candidate' and not proposal.get('direction'):
            raise ValueError('A completed candidate needs a direction for a deeper branch')
        if parent['id'] == 'ROOT' and depth > 1 and not proposal.get('direction'):
            raise ValueError('ROOT proposals need a research direction')
        intended = self.proposal_head(proposal, parent, depth) + proposal.get('refinements', [])
        # maxDepth is a ceiling, not a target. A proposal that walks a refinement past
        # it keeps the steps that fit and loses the rest; rejecting it instead ended
        # the whole research, because a stage gets one correction and a research that
        # had already spent its budget reaches ideation three rounds deep.
        return parent, intended[:self.proposal_allowance(parent, depth)]

    def proposal_head(self, proposal, parent, depth):
        """The direction step a proposal contributes, empty when the parent already is one."""
        if (proposal.get('parentId') and parent['kind'] == 'direction') or (parent['id'] == 'ROOT' and depth == 1):
            return []
        return [proposal['direction']]

    def proposal_allowance(self, parent, depth=None):
        depth = self.state['settings']['maxDepth'] if depth is None else depth
        return max(0, depth - parent['depth'] - 1)

    def expansion_constraints(self, parent):
        """Describe the path budget using the same allowance as insertion's safety trim."""
        depth = self.state['settings']['maxDepth']
        direction_required = parent['kind'] == 'candidate' or (parent['id'] == 'ROOT' and depth > 1)
        path_steps = self.proposal_allowance(parent, depth)
        direction_steps = len(self.proposal_head(dict(parentId=parent['id'], direction=''), parent, depth))
        return dict(parentId=parent['id'], remainingDepth=depth - parent['depth'],
                    maxPathSteps=path_steps, directionRequired=direction_required,
                    directionNodeAllowed=direction_steps > 0 and path_steps > 0,
                    maxRefinements=max(0, path_steps - direction_steps))

    def trimmed_direction(self, proposal):
        """The direction the ceiling removed, or None when every step fit.

        Only a direction the trim actually cut is reported: a direction parent and a
        ROOT proposal carrying a direction never contribute one to the path, so their
        value is not "dropped" and must not be recorded.
        """
        parent_id = proposal.get('parentId')
        parent = self.find(parent_id) if parent_id else self.find('ROOT')
        if parent is None:
            return None
        depth = self.state['settings']['maxDepth']
        intended = self.proposal_head(proposal, parent, depth) + proposal.get('refinements', [])
        dropped = intended[self.proposal_allowance(parent, depth):]
        direction = proposal.get('direction')
        return direction if direction and direction in dropped else None

    def is_descendant_of(self, node_id, ancestor_id):
        current = self.find(node_id)
        while current['parentId']:
            if current['parentId'] == ancestor_id:
                return True
            current = self.find(current['parentId'])
        return False

    def validate_proposal(self, proposal, selected_ids):
        parent_id = proposal.get('parentId') or 'ROOT'
        if parent_id not in selected_ids:
            raise ValueError('Proposed parent was not selected for expansion')
        parent, _ = self.proposal_path(proposal)
        candidates = {n['id']: n for n in self.state['nodes'] if n['kind'] == 'candidate'}
        insights = {record['id']: record for n in self.state['nodes'] for record in n.get('insightRecords', [])}
        source_ids = proposal.get('basedOnCandidateIds', [])
        insight_ids = proposal.get('addressesInsightIds', [])
        is_exploit = proposal.get('explorationType') == 'exploit'
        if is_exploit and (not candidates or not insights):
            raise ValueError('Use explorationType=explore until a candidate and an insight exist')
        if not set(source_ids).issubset(candidates) or not set(insight_ids).issubset(insights):
            raise ValueError('Proposal references an unknown candidate or insight')
        if is_exploit:
            for key in ('targetedWeakness', 'expectedImprovement', 'newRisk'):
                text(proposal.get(key), key, 2000)
            if not source_ids or not insight_ids:
                raise ValueError('Exploit proposals must name their evidence and targeted insight')
            if parent['kind'] == 'candidate' and parent['id'] not in source_ids:
                raise ValueError('A deeper exploit must cite its parent candidate')
            if parent['kind'] == 'direction' and not any(self.is_descendant_of(source, parent['id']) for source in source_ids):
                raise ValueError('An exploit under a direction must cite a candidate in that direction')
        elif proposal.get('explorationType') == 'explore':
            text(proposal.get('rationale'), 'rationale', 2000)

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
                    selected = self.select_directions()
                    if not selected:
                        s['reason'] = 'No active expandable direction remains'
                        break
                    s.update(phase='select_directions', currentNodeId=None, selectedDirectionIds=[n['id'] for n in selected])
                    self.save()
                    count = min(s['settings']['candidatesPerRound'], remaining)
                    s['phase'] = 'ideate'
                    def check_proposals(ideas, count=count):
                        # Reject the whole proposal before changing the tree.
                        known_ids = {n['id'] for n in s['nodes']}
                        if any(p.get('parentId') and p['parentId'] not in known_ids for p in ideas['candidates'][:count]):
                            raise ValueError('Proposed parent does not exist')
                        for proposal in ideas['candidates'][:count]:
                            self.validate_proposal(proposal, s['selectedDirectionIds'])
                    # One unusable proposal must not end the research. The stage gets
                    # its single correction inside `ask`; if the answer is still
                    # invalid the round is skipped and the next ideation tries again,
                    # because the failure mode measured in practice is a single bad
                    # field (`targetedWeakness`, an over-deep path, trailing JSON) on an
                    # otherwise healthy run. `round` still advances, so skipping cannot
                    # loop forever, and the activity record keeps the failure visible.
                    try:
                        ideas = await self.ask('ideate', {**self.context(), 'template': dict(id=s['template']['id'], label=s['template']['label'], assessors=[item['label'] for item in s['template']['assessors']]), 'nodes': self.overview(selected), 'selectedParentIds': s['selectedDirectionIds'], 'selectedParentConstraints': [self.expansion_constraints(parent) for parent in selected], 'round': s['round'] + 1, 'maximumCandidates': count, 'maxDepth': s['settings']['maxDepth'], 'scoreDirection': s['settings']['scoreDirection']}, check_proposals)
                    except ValueError as error:
                        s['round'] += 1
                        s['batch'] = []
                        s['batchCompleted'] = 0
                        # The skip stays visible in `activities` (the stage records its
                        # own failure); the research-level `reason` keeps meaning "why
                        # the run ended", which for a recovered run is still the round
                        # limit rather than one recovered hiccup.
                        self.save()
                        # A research that never produced a candidate still ends as
                        # `interrupted` with the model's error: skipping is a second
                        # chance for a healthy run, not a way to finish empty.
                        if s['round'] >= s['settings']['maxRounds'] and not any(n['kind'] == 'candidate' for n in s['nodes']):
                            raise
                        continue
                    batch = []
                    existing = {n['hypothesis'].strip().casefold() for n in s['nodes']}
                    for proposal in ideas['candidates'][:count]:
                        if proposal['hypothesis'].strip().casefold() in existing:
                            continue
                        parent, path = self.proposal_path(proposal)
                        # Reuse existing direction paths; reserve space for the entire
                        # remaining path and leaf before adding any of its nodes.
                        remaining_path = []
                        for index, label in enumerate(path):
                            child = next((self.find(i) for i in parent['childrenIds'] if self.find(i)['kind'] == 'direction' and self.find(i)['hypothesis'] == label), None)
                            if child is None:
                                remaining_path = path[index:]
                                break
                            parent = child
                        if len(s['nodes']) + len(remaining_path) + 1 > s['settings']['maxNodes']:
                            continue
                        for label in remaining_path:
                            parent = self.add(parent, label, 'direction')
                        candidate = self.add(parent, proposal['hypothesis'], 'candidate')
                        if candidate:
                            candidate.update(derivedFromCandidateIds=proposal.get('basedOnCandidateIds', []), addressesInsightIds=proposal.get('addressesInsightIds', []), targetedWeakness=proposal.get('targetedWeakness'), explorationType=proposal.get('explorationType', 'explore'))
                            # A parent at the last expandable depth leaves no room for a
                            # direction node, so the candidate attaches directly under it.
                            # Keep the direction the model named rather than discarding it.
                            trimmed = self.trimmed_direction(proposal)
                            if trimmed:
                                candidate['trimmedDirection'] = trimmed
                            batch.append(candidate['id'])
                            existing.add(candidate['hypothesis'].strip().casefold())
                    if not batch:
                        s['reason'] = ideas['reason'] if not ideas['candidates'] else 'No new legal candidate fits the remaining tree limits'
                        break
                    s['batch'] = batch
                    s['batchCompleted'] = 0
                    s['round'] += 1
                    self.save()
                async def evaluate_candidate(identifier):
                    candidate = self.find(identifier)
                    if candidate.get('cycleComplete') or candidate['status'] == 'done':
                        return None
                    async with semaphore:
                        await self.evaluate(candidate, propagate_insight=False)
                    return candidate

                # Designs and assessments share no mutable candidate state, so run the
                # expensive model calls concurrently. Insight propagation remains below
                # in deterministic batch order because sibling summaries update shared
                # ancestors and form the selector's durable learning record.
                # Match assessor scheduling under a cap: spend actual usage before
                # reserving the next candidate's conservative per-call allowance.
                concurrency = 1 if s['settings'].get('maxTokens') else s['settings'].get('candidateConcurrency', 1)
                semaphore = asyncio.Semaphore(max(1, concurrency))
                results = await asyncio.gather(*(evaluate_candidate(identifier) for identifier in s['batch']), return_exceptions=True)
                for result in results:
                    if isinstance(result, BaseException):
                        raise result
                for identifier in s['batch']:
                    candidate = self.find(identifier)
                    if candidate.get('cycleComplete'):
                        continue
                    if candidate['status'] == 'done':
                        await self.propagate(candidate)
                    candidate['cycleComplete'] = True
                    s['batchCompleted'] += 1
                    self.save()
                s['batch'] = []
                self.save()
            s.update(status='completed', phase='complete', reason=s['reason'] or 'Exploration round limit reached')
        except Interrupted:
            s.update(status='ended' if self.stop_action == 'end' else 'paused', reason='Ended by user' if self.stop_action == 'end' else 'Paused by user')
        except BudgetReached as error:
            # A stop request the user made outranks the budget's own outcome (#1455):
            # the reservation check can fire before the engine reaches a stop check, so
            # resolve it exactly as the Interrupted handler does instead of overwriting
            # the request with a resumable budget state.
            if self.stop_action:
                s.update(status='ended' if self.stop_action == 'end' else 'paused',
                         reason='Ended by user' if self.stop_action == 'end' else 'Paused by user')
            else:
                # A spent token budget is its own terminal outcome, not a pause the user can
                # resume: continuing would hit the same ceiling before doing any work. The
                # reason keeps the engine's text and, only when the provider reported usage,
                # the measured used/limit numbers. An unreported budget is admitted instead of
                # asserting a count we do not have.
                limit = s['settings'].get('maxTokens')
                if s.get('usageKnown'):
                    spent = (f'Used {s["tokens"]} of {limit} tokens' if limit is not None
                             else f'Used {s["tokens"]} tokens with no configured limit')
                else:
                    spent = 'Reported token usage is unavailable'
                s.update(status='budget_exhausted', reason=f'{error}. {spent}')
        except Exception as error:
            if self.stop_action:
                s.update(status='ended' if self.stop_action == 'end' else 'paused', reason='Stopped by user')
            else:
                s.update(status='interrupted', reason=str(error))
        finally:
            # A settled run has folded its stop request into `status`, so the persisted
            # mark must not outlive it: a later restart would otherwise read a stale
            # `pendingStop` as a fresh user request (#1464). A run that did not settle -
            # a cancelled task during graceful shutdown leaves `running`/`pausing` -
            # keeps the mark on disk for the next boot's reconciliation to apply.
            if s.get('status') not in ('running', 'pausing'):
                s.pop('pendingStop', None)
            self.save()

    @property
    def revision(self) -> int:
        return int(self.state.get('revision', 0))

    def graph(self, heavy: bool = True):
        """The whole tree, as a command answer (`heavy`) or as a frame's first read."""
        s = self.state
        return dict(treeId=s['id'], objective=s['objective'], revision=self.revision, updatedAt=s['updatedAt'],
                    nodes=[graph_node(n, heavy) for n in s['nodes']], edges=graph_edges(s['nodes']))

    def graph_frame(self, seen: tuple[int, dict] | None):
        """The graph part of the next live frame, and the state the next one compares with.

        A new stream (`seen is None`) gets the whole compact tree. After that only the
        nodes whose signature moved since the previous frame are serialised, and
        `since` names the revision they moved from, so one frame carries the change
        instead of the tree. The service keeps the returned cursor per stream: a
        listener that attaches later starts from the whole tree again.
        """
        s = self.state
        nodes = s['nodes']
        signatures = {n['id']: node_signature(n) for n in nodes}
        head = dict(treeId=s['id'], objective=s['objective'], revision=self.revision, updatedAt=s['updatedAt'])
        if seen is None:
            return dict(head, full=True, nodes=[graph_node(n, False) for n in nodes],
                        edges=graph_edges(nodes), removed=[]), (self.revision, signatures)
        changed = {n['id'] for n in nodes if seen[1].get(n['id']) != signatures[n['id']]}
        return dict(head, full=False, since=seen[0], nodes=[graph_node(n, False) for n in nodes if n['id'] in changed],
                    edges=graph_edges(nodes, changed), removed=[i for i in seen[1] if i not in signatures]), (self.revision, signatures)
