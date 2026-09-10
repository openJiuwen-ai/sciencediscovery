"""Idea Tree state transitions. The lead Agent owns the workflow and LLM calls."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from ...tree import Node, Tree


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class IdeaTreeError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def require(condition: bool, code: str, message: str) -> None:
    if not condition:
        raise IdeaTreeError(code, message)


def text(value: Any, name: str, limit: int = 4000) -> str:
    require(isinstance(value, str) and 0 < len(value.strip()) <= limit,
            "INVALID_ARGUMENT", f"{name} must contain 1-{limit} characters")
    return value.strip()


@dataclass
class IdeaNode(Node):
    # Relationships exist only in index / parent_index; UI fields are derived.
    data: dict[str, Any]


class IdeaTree(Tree[IdeaNode]):
    def __init__(self, state: dict[str, Any]):
        self.state = state
        self.nodes = [IdeaNode(**row) for row in state["nodes"]]
        self._lock = threading.RLock()

    @classmethod
    def create(cls, params: dict[str, Any], settings: dict[str, Any]) -> IdeaTree:
        for key, minimum, maximum in [("maxDepth", 1, 20), ("maxNodes", 2, 10000), ("maxSearchRounds", 1, 10000)]:
            value = params.get(key, settings.get(key))
            require(type(value) is int and minimum <= value <= maximum, "INVALID_ARGUMENT", f"Invalid {key}")
            params[key] = value
        executor = copy.deepcopy(params["executor"])
        require(executor.get("kind") == "workflow_skill", "INVALID_EXECUTOR", "A workflow Skill executor is required")
        if not settings:
            settings = {**{k: params[k] for k in ["maxDepth", "maxNodes", "maxSearchRounds"]},
                        "scoreDirection": executor["scoreSpec"]["direction"], "assessorActivity": {},
                        "assessorStability": {}, "assessorSustainability": {}}
        settings = {**settings, **{key: params[key] for key in ["maxDepth", "maxNodes", "maxSearchRounds"]}}
        stamp = now()
        tree = cls(dict(treeId="tree-" + uuid.uuid4().hex[:16], version=1,
                        objective=text(params.get("objective"), "objective"), nodes=[],
                        maxDepth=params["maxDepth"], maxNodes=params["maxNodes"], maxSearchRounds=params["maxSearchRounds"],
                        executor=executor, settings=copy.deepcopy(settings), revision=1, searchRound=0,
                        createdAt=stamp, updatedAt=stamp, finished=False, meta={},
                        context=dict(artifactVersions=[], completedAt=None, contextDigest=digest([]), preflightStatus="complete"),
                        propagation=dict(entries={}, pendingNodeIds=[]), executions={}, results={}, idempotency={}))
        tree.nodes.append(tree._new_node(None, "ROOT", text(params.get("rootHypothesis"), "rootHypothesis"), 0))
        return tree

    def dump(self) -> dict[str, Any]:
        return {**self.state, "nodes": [asdict(node) for node in self.nodes]}

    def _new_node(self, parent: IdeaNode | None, identifier: str, hypothesis: str, priority: float) -> IdeaNode:
        stamp = now()
        return IdeaNode(len(self.nodes), parent.index if parent else None, dict(
            id=identifier, hypothesis=hypothesis, priority=priority, status="pending", searchStatus="active",
            score=None, insight=None, result=None, artifactRefs=[], subagentIds=[], attemptCount=0,
            activeExecutionId=None, lastExecutionId=None, completedResultHandle=None,
            pruneReason=None, createdAt=stamp, updatedAt=stamp))

    def node(self, identifier: str) -> IdeaNode:
        result = next((node for node in self.nodes if node.data["id"] == identifier), None)
        require(result is not None, "NODE_NOT_FOUND", f"Unknown node {identifier}")
        return result

    def public_node(self, node: IdeaNode) -> dict[str, Any]:
        return {**node.data, "parentId": self.nodes[node.parent_index].data["id"] if node.parent_index is not None else None,
                "childrenIds": [child.data["id"] for child in self.get_children(node.index)],
                "depth": len(self.get_ancestors(node.index))}

    def public(self) -> dict[str, Any]:
        return {**{key: value for key, value in self.state.items() if key not in {"nodes", "executions", "results", "idempotency"}},
                "rootId": "ROOT", "nodes": {node.data["id"]: self.public_node(node) for node in self.nodes}}

    def graph(self) -> dict[str, Any]:
        return dict(treeId=self.state["treeId"], objective=self.state["objective"], revision=self.state["revision"],
                    updatedAt=self.state["updatedAt"], nodes=[self.public_node(n) for n in self.nodes],
                    edges=[dict(source=parent.data["id"], target=child.data["id"], ordinal=i, type="child")
                           for parent in self.nodes for i, child in enumerate(self.get_children(parent.index))])

    def pending(self) -> str | None:
        return next(iter(self.state["propagation"]["pendingNodeIds"]), None)

    def active(self) -> dict[str, Any] | None:
        return next((e for e in self.state["executions"].values() if e["status"] == "running"), None)

    def touch(self) -> None:
        self.state["revision"] += 1
        self.state["updatedAt"] = now()

    def response(self, **fields: Any) -> dict[str, Any]:
        return dict(treeId=self.state["treeId"], revision=self.state["revision"], **fields)

    def open(self) -> None:
        require(not self.state["finished"] and self.state["searchRound"] < self.state["maxSearchRounds"], "SEARCH_FINISHED", "Search budget exhausted or tree finished")
        require(not self.pending(), "PROPAGATION_PENDING", "Finish bottom-up insight propagation first")
        require(not self.active(), "TREE_BUSY", "A leaf is already running")

    def eligible(self, node: IdeaNode) -> bool:
        return (node.data["status"] == "pending" and node.data["searchStatus"] == "active"
                and len(self.get_ancestors(node.index)) == self.state["maxDepth"] and not self.get_children(node.index))

    def add_node(self, params: dict[str, Any]) -> dict[str, Any]:
        self.open()
        require(len(self.nodes) < self.state["maxNodes"], "NODE_LIMIT", "Node budget exhausted")
        parent = self.node(params["parentId"])
        require(parent.data["status"] == "pending" and parent.data["searchStatus"] == "active", "INVALID_PARENT", "Parent must be active and pending")
        require(len(self.get_ancestors(parent.index)) < self.state["maxDepth"], "DEPTH_LIMIT", "Cannot expand beyond maxDepth")
        priority = params.get("priority", 0)
        require(isinstance(priority, (int, float)) and math.isfinite(priority) and -1000 <= priority <= 1000, "INVALID_ARGUMENT", "Invalid priority")
        ordinal = len(self.get_children(parent.index)) + 1
        identifier = str(ordinal) if parent.index == 0 else f'{parent.data["id"]}.{ordinal}'
        node = self._new_node(parent, identifier, text(params.get("hypothesis"), "hypothesis"), priority)
        self.nodes.append(node)
        parent.data["updatedAt"] = now()
        self.touch()
        return self.response(node=self.public_node(node))

    def select(self, strategy: str = "highest_priority") -> dict[str, Any]:
        require(strategy in {"highest_priority", "fifo"}, "INVALID_ARGUMENT", "Unknown selection strategy")
        candidates = [n for n in self.nodes if self.eligible(n)] if not self.state["finished"] and self.state["searchRound"] < self.state["maxSearchRounds"] else []
        if strategy == "highest_priority":
            candidates.sort(key=lambda n: -n.data["priority"])
        return self.response(selected=self.public_node(candidates[0]) if candidates else None,
                             candidates=[self.public_node(n) for n in candidates], pendingPropagationNodeId=self.pending())

    def claim(self, params: dict[str, Any], owner: str) -> dict[str, Any]:
        self.open()
        node = self.node(params["nodeId"])
        require(self.eligible(node), "LEAF_NOT_ELIGIBLE", "Only an active pending max-depth terminal leaf can run")
        execution = self.state["executions"].get(node.data["lastExecutionId"])
        if execution:
            execution.update(attempt=execution["attempt"] + 1, ownerRunId=owner, status="running", finishedAt=None)
            execution.pop("failure", None)
        else:
            identifier = str(uuid.uuid4())
            context = dict(ancestorInsights=[n.data["insight"] for n in reversed(self.get_ancestors(node.index)) if n.data["insight"]],
                           constraints=[], contextArtifactVersions=self.state["context"]["artifactVersions"],
                           contextDigest=self.state["context"]["contextDigest"], hypothesis=node.data["hypothesis"], objective=self.state["objective"])
            execution = dict(executionId=identifier, nodeId=node.data["id"], attempt=1, ownerRunId=owner,
                             requestContext=copy.deepcopy(context), requestHash=digest([identifier, context, self.state["executor"]]),
                             status="running", artifactRefs=[], checkpoints=[], createdAt=now(), finishedAt=None)
            self.state["executions"][identifier] = execution
        self.heartbeat(execution)
        node.data.update(status="running", activeExecutionId=execution["executionId"], lastExecutionId=execution["executionId"],
                         attemptCount=execution["attempt"], updatedAt=now())
        self.state["searchRound"] += 1
        self.touch()
        request = {**execution["requestContext"], **{k: execution[k] for k in ["executionId", "nodeId", "attempt", "requestHash", "checkpoints"]},
                   "treeId": self.state["treeId"], "executor": self.state["executor"], "settings": self.state["settings"]}
        return self.response(request=request)

    @staticmethod
    def heartbeat(execution: dict[str, Any]) -> None:
        execution.update(heartbeatAt=now(), updatedAt=now(), leaseExpiresAt=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z"))

    def current_execution(self, params: dict[str, Any], owner: str) -> dict[str, Any]:
        execution = self.state["executions"].get(params.get("executionId"))
        require(execution is not None and execution["status"] == "running", "EXECUTION_NOT_RUNNING", "Execution is not running")
        require(execution["ownerRunId"] == owner and datetime.fromisoformat(execution["leaseExpiresAt"]) > datetime.fromisoformat(now()), "EXECUTION_LEASE_OWNED", "Execution owner or lease does not match")
        require(execution["attempt"] == params.get("attempt") and execution["requestHash"] == params.get("requestHash"), "EXECUTION_MISMATCH", "Stale execution attempt or request")
        return execution

    def checkpoint(self, params: dict[str, Any], owner: str) -> dict[str, Any]:
        execution = self.current_execution(params, owner)
        step = text(params.get("stepKey"), "stepKey", 160)
        versions = params["artifactVersions"]
        require(isinstance(versions, list) and 0 < len(versions) <= 100, "INVALID_ARGUMENT", "Checkpoint needs artifact versions")
        payload = dict(stepKey=step, inputDigest=text(params.get("inputDigest"), "inputDigest", 200), artifactVersions=versions)
        prior = next((c for c in execution["checkpoints"] if c["stepKey"] == step), None)
        require(prior is None or prior["payloadHash"] == digest(payload), "CHECKPOINT_CONFLICT", "Checkpoint already contains different evidence")
        if prior is None:
            prior = dict(**payload, payloadHash=digest(payload), attempt=execution["attempt"], createdAt=now(), artifactRefs=[v["artifactId"] for v in versions])
            execution["checkpoints"].append(prior)
            execution["artifactRefs"] = list(dict.fromkeys(execution["artifactRefs"] + prior["artifactRefs"]))
        self.touch()
        return self.response(checkpoint=prior)

    def issue_verified_result(self, params: dict[str, Any], owner: str) -> dict[str, Any]:
        execution = self.current_execution(params, owner)
        spec = self.state["executor"]["scoreSpec"]
        authority = self.state["executor"]["resultAuthority"]
        require(all(params["authority"].get(k) == authority[k] for k in ["key", "version"]), "INVALID_AUTHORITY", "Result authority mismatch")
        value = params["scoreValue"]
        require(isinstance(value, (int, float)) and math.isfinite(value) and spec["minimum"] <= value <= spec["maximum"], "INVALID_SCORE", "Score is outside the configured range")
        insight = text(params.get("insight"), "insight", 12000)
        for result in self.state["results"].values():
            if result["authority"]["requestId"] == params["authority"]["requestId"]:
                require(result["requestHash"] == params["requestHash"] and result["attempt"] == params["attempt"] and result["score"]["value"] == value and result["insight"] == insight,
                        "RESULT_CONFLICT", "Result request id already used")
                return result
        result = dict(handle="result-" + uuid.uuid4().hex, treeId=self.state["treeId"], nodeId=execution["nodeId"],
                      executionId=execution["executionId"], attempt=execution["attempt"], requestHash=execution["requestHash"],
                      executorFingerprint=self.state["executor"]["fingerprint"], authority=params["authority"],
                      artifactRefs=params.get("artifactRefs", []), score={**spec, "value": value, "artifactRef": params.get("scoreArtifactRef")},
                      insight=insight, issuedAt=now(), consumedAt=None)
        result["resultDigest"] = digest(result)
        self.state["results"][result["handle"]] = result
        return result

    def child_digest(self, node: IdeaNode) -> str:
        return digest([self.public_node(n) for n in self.get_children(node.index)])

    def queue_propagation(self, node: IdeaNode, execution_id: str) -> None:
        ancestors = self.get_ancestors(node.index)
        self.state["propagation"]["pendingNodeIds"] = [n.data["id"] for n in ancestors]
        for ancestor in ancestors:
            self.state["propagation"]["entries"][ancestor.data["id"]] = dict(
                nodeId=ancestor.data["id"], childDigest=self.child_digest(ancestor), status="pending",
                completedAt=None, createdAt=now(), sourceRevision=self.state["revision"], triggeredByExecutionId=execution_id)

    def complete(self, params: dict[str, Any], owner: str) -> dict[str, Any]:
        result = self.state["results"].get(params.get("resultHandle"))
        require(result is not None and result["consumedAt"] is None, "RESULT_HANDLE_INVALID", "Result handle missing or already consumed")
        execution = self.current_execution(result, owner)
        node = self.node(execution["nodeId"])
        result["consumedAt"] = now()
        execution.update(status="done", finishedAt=now(), updatedAt=now(), result=dict(
            artifactRefs=result["artifactRefs"], insight=result["insight"], resultHandle=result["handle"], score=result["score"]["value"]))
        node.data.update(status="done", score=result["score"]["value"], insight=result["insight"],
                         artifactRefs=result["artifactRefs"], activeExecutionId=None, completedResultHandle=result["handle"], updatedAt=now())
        self.touch()
        self.queue_propagation(node, execution["executionId"])
        return self.response(node=self.public_node(node), pendingPropagationNodeId=self.pending())

    def update_node(self, params: dict[str, Any]) -> dict[str, Any]:
        node = self.node(params["nodeId"])
        if "insight" in params:
            require(node.data["id"] == self.pending(), "PROPAGATION_PENDING", "Only the next ancestor may receive propagated insight")
            require(params.get("propagationChildDigest") == self.child_digest(node), "PROPAGATION_DIGEST_CONFLICT", "Child evidence changed; read node again")
            require("hypothesis" not in params and "priority" not in params, "INVALID_ARGUMENT", "Propagation cannot edit the hypothesis")
            node.data["insight"] = text(params["insight"], "insight", 12000)
            self.state["propagation"]["entries"][node.data["id"]].update(status="complete", completedAt=now())
            self.state["propagation"]["pendingNodeIds"].pop(0)
            node.data["updatedAt"] = now()
            if self.pending():
                parent = self.node(self.pending())
                self.state["propagation"]["entries"][parent.data["id"]]["childDigest"] = self.child_digest(parent)
        else:
            self.open()
            require(node.data["status"] == "pending" and node.data["lastExecutionId"] is None, "INVALID_STATE", "Executed hypotheses are immutable")
            if "hypothesis" in params:
                node.data["hypothesis"] = text(params["hypothesis"], "hypothesis")
            if "priority" in params:
                priority = params["priority"]
                require(isinstance(priority, (int, float)) and math.isfinite(priority) and -1000 <= priority <= 1000, "INVALID_ARGUMENT", "Invalid priority")
                node.data["priority"] = priority
            node.data["updatedAt"] = now()
        self.touch()
        return self.response(node=self.public_node(node), pendingPropagationNodeId=self.pending())

    def fail_execution(self, execution: dict[str, Any], retryable: bool, reason: dict[str, str]) -> None:
        execution.update(status="retryable_failure" if retryable else "permanent_failure", failure=reason, finishedAt=now(), updatedAt=now())
        self.node(execution["nodeId"]).data.update(status="needs_retry" if retryable else "failed", activeExecutionId=None, updatedAt=now())
        if retryable:
            self.state["searchRound"] = max(0, self.state["searchRound"] - 1)
        self.touch()

    def fail(self, params: dict[str, Any], owner: str) -> dict[str, Any]:
        execution = self.current_execution(params, owner)
        self.fail_execution(execution, params["retryable"], {k: text(params.get(k), k) for k in ["message", "reasonCode"]})
        return self.response(node=self.public_node(self.node(execution["nodeId"])))

    def retry(self, params: dict[str, Any]) -> dict[str, Any]:
        self.open()
        node = self.node(params["nodeId"])
        require(node.data["searchStatus"] == "active" and (node.data["status"] == "needs_retry" or params.get("force") and node.data["status"] == "failed"), "INVALID_STATE", "Node is not retryable")
        node.data.update(status="pending", updatedAt=now())
        self.touch()
        return self.response(node=self.public_node(node))

    def prune(self, params: dict[str, Any]) -> dict[str, Any]:
        require(not self.active() and not self.pending() and not self.state["finished"], "TREE_BUSY", "Tree is busy or finished")
        node = self.node(params["nodeId"])
        require(node.index != 0, "INVALID_ARGUMENT", "Cannot prune ROOT")
        reason = text(params.get("reason"), "reason")
        affected = [n for n in self.nodes if n.index == node.index or node in self.get_ancestors(n.index)]
        for child in affected:
            child.data.update(searchStatus="pruned", pruneReason=reason, updatedAt=now())
        self.touch()
        self.queue_propagation(node, "prune")
        return self.response(node=self.public_node(node), prunedNodeIds=[n.data["id"] for n in affected], pendingPropagationNodeId=self.pending())

    def finish(self, params: dict[str, Any]) -> dict[str, Any]:
        require(not self.active() and not self.pending(), "TREE_BUSY", "Finish running leaves and insight propagation first")
        self.state["finished"] = True
        for node in self.nodes:
            if self.get_children(node.index):
                node.data.update(status="done", updatedAt=now())
        self.touch()
        return self.response(completedNodeIds=[n.data["id"] for n in self.nodes if self.get_children(n.index)])

    def attach_context(self, params: dict[str, Any]) -> dict[str, Any]:
        require(not self.state["executions"], "CONTEXT_FROZEN", "Shared context cannot change after first execution")
        versions = params["artifactVersions"]
        self.state["context"] = dict(artifactVersions=versions, completedAt=now(), contextDigest=digest(versions), preflightStatus="complete")
        self.touch()
        return self.response(context=self.state["context"])

    def set_meta(self, params: dict[str, Any]) -> dict[str, Any]:
        patch = params["patch"]
        require(isinstance(patch, dict) and not any(k in {"executor", "scoreSpec", "settings", "finished"} for k in patch), "INVALID_ARGUMENT", "Reserved metadata")
        self.state["meta"].update(patch)
        self.touch()
        return self.response(meta=self.state["meta"])

    def view(self, format: str = "compact", node_id: str | None = None) -> dict[str, Any]:
        if format == "full":
            return self.public()
        if format == "node":
            node = self.node(node_id)
            return self.response(node=self.public_node(node), executor=self.state["executor"],
                                 execution=self.state["executions"].get(node.data["lastExecutionId"]),
                                 propagation=self.state["propagation"]["entries"].get(node.data["id"]))
        if format == "pending":
            return self.response(nodes=[self.public_node(n) for n in self.nodes if self.eligible(n)], blockedByPropagation=self.pending())
        if format == "constraints":
            return self.response(**{k: self.public()[k] for k in ["context", "executor", "propagation", "settings"]},
                                 limits={k: self.state[k] for k in ["maxDepth", "maxNodes", "maxSearchRounds", "searchRound"]},
                                 root=self.public_node(self.nodes[0]), completedLeaves=[self.public_node(n) for n in self.nodes if n.data["score"] is not None],
                                 pendingLeaves=[self.public_node(n) for n in self.nodes if self.eligible(n)])
        require(format == "compact", "INVALID_ARGUMENT", "Unknown view format")
        lines = [f'# {self.state["objective"]}']
        for node in self.nodes:
            n = self.public_node(node)
            lines.append('  ' * n["depth"] + f'- {n["id"]} [{n["status"]}/{n["searchStatus"]}] {n["hypothesis"]} (score={n["score"]}, priority={n["priority"]})')
            if n["insight"]:
                lines.append('  ' * (n["depth"] + 1) + n["insight"])
        return self.response(markdown="\n".join(lines), pendingPropagationNodeId=self.pending(), settings=self.state["settings"])

    def check(self) -> dict[str, Any]:
        errors = []
        for index, node in enumerate(self.nodes):
            if node.index != index or (index == 0 and node.parent_index is not None) or (index > 0 and (node.parent_index is None or not 0 <= node.parent_index < index)):
                errors.append(f"Invalid parent/index: {index}")
            if node.data["status"] == "running" and node.data["activeExecutionId"] not in self.state["executions"]:
                errors.append(f"Missing execution: {index}")
        return self.response(ok=not errors, errors=errors)
