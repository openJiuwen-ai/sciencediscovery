"""HTTP lifecycle for autonomous research; use one ASGI worker."""
import asyncio
import copy
import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from ...auth import require_internal_token
from .research import IdeaTreeEngine, ResearchStore, node, now
from .prompts import DEFAULTS, CRITERIA


class Settings(BaseModel):
    maxRounds: int = Field(default=3, ge=1, le=100)
    candidatesPerRound: int = Field(default=3, ge=1, le=20)
    maxSearchRounds: int = Field(default=10, ge=1, le=10000)
    maxNodes: int = Field(default=100, ge=2, le=10000)
    maxDepth: int = Field(default=5, ge=1, le=20)
    maxTokens: int | None = Field(default=None, ge=1)
    maxTokensPerCall: int = Field(default=4000, ge=256, le=32000)
    designSystemPrompt: str | None = Field(default=None, max_length=24000)
    aggregatorSystemPrompt: str | None = Field(default=None, max_length=24000)
    propagateInsightSystemPrompt: str | None = Field(default=None, max_length=24000)
    assessorActivity: dict = Field(default_factory=dict)
    assessorStability: dict = Field(default_factory=dict)
    assessorSustainability: dict = Field(default_factory=dict)
    scoreDirection: str = 'maximize'

    @model_validator(mode='after')
    def weights(self):
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


def state_for(project, session, identifier):
    active = _running.get(identifier)
    if active:
        s = active[0].state
        if s['projectId'] != project or s['sessionId'] != session:
            raise HTTPException(404, 'Research not found')
        return s
    s = store().read(project, session, identifier)
    if s['status'] in ['running', 'pausing']:
        s.update(status='interrupted', reason='Service restarted; continue manually')
        store().save(s)
    return s


def view(s):
    engine = IdeaTreeEngine(s, store(), {})
    return dict(research={k: copy.deepcopy(v) for k, v in s.items() if k not in ['nodes', 'materials']}, graph=engine.graph())


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
                     objective=c.objective, materials=c.materials, settings=c.settings.model_dump(), modelId=c.modelId,
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
            if s['status'] in ['completed', 'ended']:
                raise HTTPException(409, 'Research has ended; create a new research')
            start(s, c.llm)
        elif c.operation in ['pause', 'end']:
            if s['status'] in ['completed', 'ended']:
                return view(s)
            active = _running.get(s['id'])
            if active:
                active[0].stop_action = c.operation
                s['status'] = 'pausing'
            else:
                s.update(status='ended' if c.operation == 'end' else 'paused', reason='Ended by user' if c.operation == 'end' else 'Paused by user')
            store().save(s)
        else:
            raise ValueError('Unknown research operation')
        return view(s)
    except FileNotFoundError as error:
        raise HTTPException(404, 'Research not found') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
