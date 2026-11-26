"""HTTP lifecycle for autonomous research; use one ASGI worker."""
import asyncio
import copy
import json
import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from ...auth import require_internal_token
from ...logging_config import get_logger
from .research import IdeaTreeEngine, ResearchStore, node, now
from .prompts import DEFAULTS, CRITERIA
from .templates import INTENSITIES, TEMPLATES, apply_intensity, snapshot

log = get_logger('idea_research')


class Settings(BaseModel):
    templateId: str = 'scientific-hypothesis-general/v1'
    explorationIntensity: str = 'standard'
    maxRounds: int = Field(default=3, ge=1, le=100)
    candidatesPerRound: int = Field(default=3, ge=1, le=20)
    maxSearchRounds: int = Field(default=10, ge=1, le=10000)
    maxNodes: int = Field(default=100, ge=2, le=10000)
    maxDepth: int = Field(default=5, ge=1, le=20)
    maxActiveDirections: int = Field(default=3, ge=1, le=20)
    pruneMinAssessments: int = Field(default=3, ge=1, le=100)
    pruneScoreGap: float = Field(default=2.5, ge=0, le=9)
    maxTokens: int | None = Field(default=None, ge=1)
    designSystemPrompt: str | None = Field(default=None, max_length=24000)
    aggregatorSystemPrompt: str | None = Field(default=None, max_length=24000)
    propagateInsightSystemPrompt: str | None = Field(default=None, max_length=24000)
    assessorActivity: dict = Field(default_factory=dict)
    assessorStability: dict = Field(default_factory=dict)
    assessorSustainability: dict = Field(default_factory=dict)
    scoreDirection: str = 'maximize'

    @model_validator(mode='after')
    def weights(self):
        if self.templateId not in TEMPLATES or self.explorationIntensity not in INTENSITIES:
            raise ValueError('Unknown research template or exploration intensity')
        weights = [c.get('weight', w) for c, w in zip([self.assessorActivity, self.assessorStability, self.assessorSustainability], [.35, .35, .30])]
        if any(isinstance(w, bool) or not isinstance(w, (float, int)) or not 0 <= w <= 1 for w in weights) or abs(sum(weights) - 1) > 1e-6:
            raise ValueError('Assessment weights must sum to 1')
        for cfg in [self.assessorActivity, self.assessorStability, self.assessorSustainability]:
            for key in ['systemPrompt', 'scoringCriteria']:
                if key in cfg and (not isinstance(cfg[key], str) or len(cfg[key]) > 24000):
                    raise ValueError(f'Invalid {key}')
        return self


class Command(BaseModel):
    projectId: str
    sessionId: str
    operation: str
    researchId: str = ''
    objective: str = Field(default='', max_length=16000)
    materials: str = Field(default='', max_length=32000)
    settings: Settings = Field(default_factory=Settings)
    modelId: str = ''
    llm: dict = Field(default_factory=dict)


router = APIRouter(prefix='/idea-tree/research', dependencies=[Depends(require_internal_token)])
_store = None
_cleanup_tasks: set[asyncio.Task] = set()
_running: dict[str, tuple[IdeaTreeEngine, asyncio.Task]] = {}


def store():
    global _store
    if _store is None:
        _store = ResearchStore(Path(os.environ.get('SCIENCE_AGENT_DATA_DIR', '.sciencediscovery-data')) / 'idea-research')
    return _store


RESTART_REASON = 'Service restarted; continue manually'
ACTIVE_STATUSES = ('running', 'pausing')


def state_for(project, session, identifier):
    """The research as it is; a read, never a recovery step.

    `list`, `get` and `events` (once per streamed frame) all call this, and a
    read of an archived, read-only Session reaches it too, so it must not
    write. A research a previous process left `running` is settled once at boot
    by `reconcile_orphaned_researches()`, not by whichever request reads first.
    """
    active = _running.get(identifier)
    if active:
        s = active[0].state
        if s['projectId'] != project or s['sessionId'] != session:
            raise HTTPException(404, 'Research not found')
        return s
    return store().read(project, session, identifier)


def settle_after_restart(state):
    """The restart verdict for one research, its activities closed.

    A stop the user requested while the run was in flight is persisted as
    `pendingStop`, because the engine that would have settled it died with the
    process. That request outranks the crash verdict (#1464): `end` restores the
    research as `ended`, so continuing it stays refused, and `pause` as the
    `paused` the user asked for. Without the mark a `running`/`pausing` record
    is an interrupted run, which is also how records written before the mark
    existed are read.
    """
    pending = state.pop('pendingStop', None)
    if pending == 'end':
        state.update(status='ended', reason='Ended by user')
    elif pending == 'pause':
        state.update(status='paused', reason='Paused by user')
    else:
        state.update(status='interrupted', reason=RESTART_REASON)
    for activity in state.get('activities', []):
        if activity.get('status') == 'running':
            activity.update(status='stopped', finishedAt=now(), error='Service restarted')


def reconcile_orphaned_researches():
    """Settle researches a previous process left running; called once at startup.

    The engine lives in this process, so a `running`/`pausing` research found
    on disk cannot still be driven: it is a restart orphan. The transition has
    to happen at the restart itself instead of on a read, because reads happen
    per streamed frame and for archived Sessions, where persisting a status
    turns an observation into an irreversible write. Returns how many were
    settled, so the caller can log a count and tests can assert on it.
    """
    root = store().root
    if not root.is_dir():
        return 0
    settled = 0
    for path in sorted(root.glob('*/*/*.json')):
        project, session, identifier = path.parts[-3], path.parts[-2], path.stem
        # Never settle a research this process is driving, even if this pass is
        # invoked again: it is not an orphan.
        if identifier in _running:
            continue
        try:
            s = store().read(project, session, identifier)
        except (OSError, ValueError) as error:
            log.warning('restart reconciliation skipped unreadable research %s/%s/%s: %s',
                        project, session, identifier, error)
            continue
        if s.get('status') not in ACTIVE_STATUSES:
            continue
        settle_after_restart(s)
        try:
            store().save(s)
        except (OSError, ValueError) as error:
            log.warning('restart reconciliation could not save research %s/%s/%s: %s',
                        project, session, identifier, error)
            continue
        settled += 1
    if settled:
        log.info('settled %d research(es) interrupted by a service restart', settled)
    return settled


def research_view(s):
    """The research's own state, without the tree (and without the tree's revision)."""
    return {k: copy.deepcopy(v) for k, v in s.items() if k not in ['nodes', 'materials', 'revision']}


def view(s):
    """A command's answer: the research and the whole tree, heavy fields included."""
    engine = IdeaTreeEngine(s, store(), {})
    return dict(research=research_view(s), graph=engine.graph())


def start(s, llm):
    if not llm.get('url') or not llm.get('token'):
        raise ValueError('Model access is required')
    if s['id'] in _running:
        raise HTTPException(409, 'Research is already running')
    if any(e.state['sessionId'] == s['sessionId'] for e, _ in _running.values()):
        raise HTTPException(409, 'This session already has running research')
    engine = IdeaTreeEngine(s, store(), llm)
    s.update(status='running', reason=None)
    store().save(s)
    async def drive():
        try:
            await engine.run()
        finally:
            _running.pop(s['id'], None)
    task = asyncio.create_task(drive())
    _running[s['id']] = (engine, task)


@router.post('/command')
async def command(c: Command):
    try:
        store().path(c.projectId, c.sessionId, 'validate')
        if c.operation == 'delete':
            active = [(e, t) for e, t in _running.values() if e.state['projectId'] == c.projectId and e.state['sessionId'] == c.sessionId]
            for engine, _ in active:
                engine.stop_action = 'end'
            async def remove_after_stop():
                await asyncio.gather(*(t for _, t in active), return_exceptions=True)
                directory = store().path(c.projectId, c.sessionId, 'unused').parent
                if directory.exists():
                    shutil.rmtree(directory)
            task = asyncio.create_task(remove_after_stop())
            _cleanup_tasks.add(task)
            task.add_done_callback(_cleanup_tasks.discard)
            return dict(deleted=True)
        if c.operation == 'defaults':
            return dict(prompts=DEFAULTS, criteria=CRITERIA)
        if c.operation == 'list':
            states = [state_for(c.projectId, c.sessionId, s['id']) for s in store().list(c.projectId, c.sessionId)]
            return dict(items=[view(s) for s in states])
        if c.operation == 'create':
            if not c.objective.strip():
                raise ValueError('Research objective is required')
            if any(e.state['sessionId'] == c.sessionId for e, _ in _running.values()):
                raise HTTPException(409, 'This session already has running research')
            s = dict(id=c.researchId or 'research-' + uuid.uuid4().hex, projectId=c.projectId, sessionId=c.sessionId,
                     objective=c.objective, materials=c.materials, settings=apply_intensity(c.settings.model_dump(), c.settings.explorationIntensity), template=snapshot(c.settings.templateId), modelId=c.modelId,
                     status='paused', phase='ideate', round=0, batch=[], batchCompleted=0, tokens=0, usageKnown=True,
                     reason=None, currentNodeId=None, createdAt=now(), updatedAt=now(), nodes=[node('ROOT', None, c.objective, 'direction', 0)])
            if store().path(c.projectId, c.sessionId, s['id']).exists():
                raise HTTPException(409, 'Research already exists')
            start(s, c.llm)
            return view(s)
        s = state_for(c.projectId, c.sessionId, c.researchId)
        if c.operation == 'get':
            return view(s)
        if c.operation == 'continue':
            if s['status'] == 'budget_exhausted':
                raise HTTPException(409, 'Research exhausted its token budget; increase the token limit and start a new research')
            if s['status'] in ['completed', 'ended']:
                raise HTTPException(409, 'Research has ended; create a new research')
            start(s, c.llm)
        elif c.operation in ['pause', 'end']:
            # A spent budget is terminal: pause/end must not resurrect it as a resumable
            # user pause or as an ended research.
            if s['status'] in ['completed', 'ended', 'budget_exhausted']:
                return view(s)
            active = _running.get(s['id'])
            if active:
                active[0].stop_action = c.operation
                # The engine still owns the settle, so the runtime status stays
                # `pausing` and the SSE stream keeps running. Persisting the request
                # is what lets a restart before that settle report the user's own
                # verdict instead of folding it into `interrupted` (#1464).
                s['pendingStop'] = c.operation
                s['status'] = 'pausing'
            else:
                s.pop('pendingStop', None)
                s.update(status='ended' if c.operation == 'end' else 'paused', reason='Ended by user' if c.operation == 'end' else 'Paused by user')
            store().save(s)
        else:
            raise ValueError('Unknown research operation')
        return view(s)
    except FileNotFoundError as error:
        raise HTTPException(404, 'Research not found') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post('/events')
async def events(c: Command):
    try:
        state_for(c.projectId, c.sessionId, c.researchId)
    except FileNotFoundError as error:
        raise HTTPException(404, 'Research not found') from error
    queue = asyncio.Queue(maxsize=1)
    listeners = store().listeners.setdefault(c.researchId, set())
    listeners.add(queue)

    async def stream():
        # Per-stream cursor: a listener that attaches mid-research starts from the
        # whole (compact) tree, and every later frame carries only what changed since
        # the frame before it. Two listeners therefore keep independent cursors.
        cursor = None
        try:
            while True:
                s = state_for(c.projectId, c.sessionId, c.researchId)
                research = research_view(s)
                graph, cursor = IdeaTreeEngine(s, store(), {}).graph_frame(cursor)
                yield 'data: ' + json.dumps(dict(research=research, graph=graph), ensure_ascii=False) + '\n\n'
                # The frame just sent decides whether this stream is done: the engine
                # mutates its state in place, so re-reading `s` here could see a status
                # the client has not been told about and close on a running frame.
                if research['status'] not in ['running', 'pausing']:
                    return
                try:
                    await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
        finally:
            listeners.discard(queue)
            if not listeners:
                store().listeners.pop(c.researchId, None)

    return StreamingResponse(stream(), media_type='text/event-stream')
