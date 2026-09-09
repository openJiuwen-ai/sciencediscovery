"""Session-serialized, atomic file storage for the Python Idea Tree tools."""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ...auth import require_internal_token
from .idea_tree import IdeaTree, IdeaTreeError, digest, now, require, text


class IdeaTreeStore:
    def __init__(self, root: Path):
        self.root = root
        self._locks: dict[tuple[str, str], threading.Lock] = {}
        self._guard = threading.Lock()

    def _save(self, path: Path, state: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
                temporary = output.name
                json.dump(state, output, ensure_ascii=False, allow_nan=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def call(self, project: str, session: str, operation: str, params: dict[str, Any], owner: str = "", settings: dict[str, Any] | None = None, fingerprint: str | None = None) -> Any:
        for identifier in (project, session):
            require(bool(re.fullmatch(r"[A-Za-z0-9_-]{1,160}", identifier)), "INVALID_ARGUMENT", "Invalid session scope")
        with self._guard:
            lock = self._locks.setdefault((project, session), threading.Lock())
        with lock:
            path = self.root / project / session / "state.json"
            try:
                state = json.loads(path.read_text()) if path.exists() else dict(version=1, trees={}, creates={})
                require(state.get("version") == 1, "STORAGE_ERROR", "Unsupported Idea Tree file format")
                before = copy.deepcopy(state)
                trees = {key: IdeaTree(value) for key, value in state["trees"].items()}
                # A crashed owner becomes retryable once its lease expires. The API
                # explicitly abandons its own execution on ordinary completion/cancel.
                recovered = 0
                for tree in trees.values():
                    execution = tree.active()
                    if execution and datetime.fromisoformat(execution["leaseExpiresAt"]) <= datetime.fromisoformat(now()):
                        tree.fail_execution(execution, True, dict(reasonCode="lease_expired", message="Execution owner lease expired"))
                        recovered += 1
                result = self._dispatch(trees, state, operation, copy.deepcopy(params), owner, settings or {}, fingerprint, recovered)
                state["trees"] = {key: tree.dump() for key, tree in trees.items()}
                if state != before:
                    self._save(path, state)
                return copy.deepcopy(result)
            except (OSError, json.JSONDecodeError) as error:
                raise IdeaTreeError("STORAGE_ERROR", f"Idea Tree storage failed: {error}") from error

    def _dispatch(self, trees: dict[str, IdeaTree], state: dict[str, Any], operation: str,
                  params: dict[str, Any], owner: str, settings: dict[str, Any], fingerprint: str | None, recovered: int) -> Any:
        ordered = sorted(trees.values(), key=lambda t: (bool(t.active() or t.pending()), t.state["updatedAt"]), reverse=True)
        if operation == "recover":
            return dict(recoveredExecutions=recovered, trees=len(trees))
        if operation == "listTreeIds":
            return list(trees)
        if operation == "deleteAll":
            trees.clear()
            state["creates"].clear()
            return None
        if operation == "list":
            return dict(currentTreeId=ordered[0].state["treeId"] if ordered else None, trees=[dict(
                treeId=t.state["treeId"], executorKey=t.state["executor"]["key"], objective=t.state["objective"], nodes=len(t.nodes),
                revision=t.state["revision"], searchRound=t.state["searchRound"], updatedAt=t.state["updatedAt"],
                pendingPropagationNodeId=t.pending(), preflightStatus=t.state["context"]["preflightStatus"],
                runningNodeId=t.active()["nodeId"] if t.active() else None) for t in ordered])
        if operation in {"activeExecution", "activeExecutor", "renewOwnedExecutionLease", "abandonOwnedExecution"}:
            active = next((t for t in ordered if t.active()), None)
            if not active:
                return False if operation in {"renewOwnedExecutionLease", "abandonOwnedExecution"} else None
            execution = active.active()
            if operation == "activeExecutor":
                return active.state["executor"]
            if operation == "activeExecution":
                return dict(treeId=active.state["treeId"], executor=active.state["executor"], **{k: execution[k] for k in ["executionId", "nodeId", "ownerRunId"]})
            if execution["ownerRunId"] != owner:
                return False
            if operation == "renewOwnedExecutionLease":
                active.heartbeat(execution)
            else:
                active.fail_execution(execution, True, {k: text(params.get(k), k) for k in ["message", "reasonCode"]})
            return True
        if operation == "recordSubagent":
            tree = next((t for t in ordered if t.active() and t.active()["ownerRunId"] == owner), None)
            if tree is None:
                return None
            node = tree.node(tree.active()["nodeId"])
            identifier = text(params.get("subagentId"), "subagentId", 200)
            if identifier not in node.data["subagentIds"]:
                node.data["subagentIds"].append(identifier)
                node.data["updatedAt"] = tree.state["updatedAt"] = now()
            return None
        if operation in {"resumeExecutor", "resumeSettings"}:
            tree = next((t for t in ordered if not t.state["finished"] and t.state["executor"]["workflowSkill"]["id"] == params["workflowSkillId"]), None)
            return tree.state["executor" if operation == "resumeExecutor" else "settings"] if tree else None
        if operation == "create":
            key = text(params.get("idempotencyKey"), "idempotencyKey", 160)
            request_hash = digest([params, settings])
            previous = state["creates"].get(key)
            if previous:
                require(previous["hash"] == request_hash, "IDEMPOTENCY_CONFLICT", "Create key already used with different input")
                return previous["response"]
            tree = IdeaTree.create(params, settings)
            trees[tree.state["treeId"]] = tree
            result = tree.response(root=tree.public_node(tree.nodes[0]))
            state["creates"][key] = dict(hash=request_hash, response=result)
            return result
        identifier = params.get("treeId") or (ordered[0].state["treeId"] if ordered else None)
        tree = trees.get(identifier)
        if operation in {"readTree", "readGraph"} and tree is None:
            return None
        require(tree is not None, "TREE_NOT_FOUND", "No matching Idea Tree in this session")
        if operation == "readTree":
            return tree.public()
        if operation == "readGraph":
            return tree.graph()
        if operation == "view":
            return tree.view(params.get("format", "compact"), params.get("nodeId"))
        if operation == "select":
            return tree.select(params.get("strategy", "highest_priority"))
        if operation == "check":
            return tree.check()
        if operation in {"listExecutions", "listVerifiedResults"}:
            return list(tree.state["executions" if operation == "listExecutions" else "results"].values())
        if operation in {"readExecution", "readVerifiedResult"}:
            return tree.state["executions" if operation == "readExecution" else "results"].get(params.get("executionId") or params.get("handle"))
        require(bool(owner), "INVALID_ARGUMENT", "Mutation requires an owning run")
        if fingerprint:
            require(tree.state["executor"]["fingerprint"] == fingerprint, "EXECUTOR_SNAPSHOT_MISMATCH", "Tree executor does not match this run")
        if operation == "issueVerifiedResult":
            return tree.issue_verified_result(params, owner)
        methods = {"addNode": tree.add_node, "updateNode": tree.update_node, "setMeta": tree.set_meta,
                   "attachContext": tree.attach_context, "retry": tree.retry, "prune": tree.prune, "finish": tree.finish,
                   "claim": lambda p: tree.claim(p, owner), "checkpoint": lambda p: tree.checkpoint(p, owner),
                   "complete": lambda p: tree.complete(p, owner), "fail": lambda p: tree.fail(p, owner)}
        require(operation in methods, "INVALID_ARGUMENT", f"Unknown operation {operation}")
        key = text(params.get("idempotencyKey"), "idempotencyKey", 160)
        request_hash = digest([operation, {k: v for k, v in params.items() if k != "expectedRevision"}, owner])
        previous = tree.state["idempotency"].get(key)
        if previous:
            require(previous["hash"] == request_hash, "IDEMPOTENCY_CONFLICT", "Idempotency key already used with different input")
            return previous["response"]
        require(tree.state["revision"] == params.get("expectedRevision"), "REVISION_CONFLICT", f'Current tree revision is {tree.state["revision"]}')
        if operation == "claim":
            require(not any(t.active() for t in trees.values()), "TREE_BUSY", "Session already has a running leaf")
        result = methods[operation](params)
        tree.state["idempotency"][key] = dict(hash=request_hash, response=copy.deepcopy(result))
        return result


class TreeCommand(BaseModel):
    projectId: str
    sessionId: str
    operation: str
    params: dict[str, Any] = Field(default_factory=dict)
    runId: str = ""
    settings: dict[str, Any] = Field(default_factory=dict)
    expectedExecutorFingerprint: str | None = None


router = APIRouter(prefix="/idea-tree", dependencies=[Depends(require_internal_token)])
_store: IdeaTreeStore | None = None


@router.post("/command")
def command(request: TreeCommand) -> dict[str, Any]:
    global _store
    if _store is None:
        _store = IdeaTreeStore(Path(os.environ.get("SCIENCE_AGENT_DATA_DIR", ".sciencediscovery-data")) / "idea-trees")
    try:
        result = _store.call(request.projectId, request.sessionId, request.operation, request.params,
                             request.runId, request.settings, request.expectedExecutorFingerprint)
        return {"result": result}
    except IdeaTreeError as error:
        status = 503 if error.code == "STORAGE_ERROR" else 409 if error.code in {"REVISION_CONFLICT", "TREE_BUSY"} else 400
        raise HTTPException(status, detail=dict(code=error.code, message=str(error))) from error
