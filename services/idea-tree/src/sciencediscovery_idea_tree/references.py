"""Cross-service deletion checks include both autonomous and historical trees."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .auth import require_internal_token
from .research_service import store
from .idea_tree_service import command, TreeCommand

router = APIRouter(dependencies=[Depends(require_internal_token)])


class ReferenceQuery(BaseModel):
    projectId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")
    sessionId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")
    skillId: str


@router.post('/references/skill')
def references(query: ReferenceQuery):
    scope = dict(projectId=query.projectId, sessionId=query.sessionId)
    research_ids = [s['id'] for s in store().list(query.projectId, query.sessionId)] if query.skillId == 'idea-tree-team' else []
    tree_ids = command(TreeCommand(**scope, operation='listTreeIds'))['result']
    matching = []
    for identifier in tree_ids:
        tree = command(TreeCommand(**scope, operation='readTree', params=dict(treeId=identifier)))['result']
        if tree and tree.get('executor', {}).get('workflowSkill', {}).get('id') == query.skillId:
            matching.append(identifier)
    return dict(referenced=bool(research_ids or matching), researchIds=research_ids, treeIds=matching)
