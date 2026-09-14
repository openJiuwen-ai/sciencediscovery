import json
from concurrent.futures import ThreadPoolExecutor
import pytest
from sciencediscovery_evolve.vendor.idea_tree.idea_tree import IdeaTreeError
from sciencediscovery_evolve.vendor.idea_tree.idea_tree_service import IdeaTreeStore
from sciencediscovery_evolve.tree import Tree

EXECUTOR = dict(kind="workflow_skill", key="idea-tree-team", fingerprint="sha256:" + "a"*64,
    workflowSkill=dict(id="idea-tree-team"), resultAuthority=dict(key="idea-tree-result", version="1"),
    scoreSpec=dict(direction="maximize", minimum=1, maximum=10, name="score", rubricVersion="1"))

@pytest.fixture
def api(tmp_path):
    store = IdeaTreeStore(tmp_path)
    def call(op, params=None, owner="run-1", settings=None):
        return store.call("project", "session", op, params or {}, owner, settings)
    call.store, call.root = store, tmp_path
    return call

def create(api, key="create"):
    return api("create", dict(executor=EXECUTOR, idempotencyKey=key, maxDepth=2, maxNodes=20,
        maxSearchRounds=3, objective="Catalyst", rootHypothesis="Explore catalysts"))

def mutate(api, tree, op, **params):
    result = api(op, dict(treeId=tree["treeId"], expectedRevision=tree["revision"], idempotencyKey=f'{op}-{tree["revision"]}', **params))
    tree["revision"] = result["revision"]
    return result

def leaf(api, tree):
    mutate(api, tree, "addNode", parentId="ROOT", hypothesis="Metal direction")
    mutate(api, tree, "addNode", parentId="1", hypothesis="Candidate", priority=5)
    return mutate(api, tree, "claim", nodeId="1.1")["request"]

def result(api, tree, request):
    return api("issueVerifiedResult", dict(treeId=tree["treeId"], executionId=request["executionId"], attempt=request["attempt"],
        requestHash=request["requestHash"], authority={**EXECUTOR["resultAuthority"], "requestId":f'result-{request["attempt"]}'},
        scoreValue=7.5, insight="Stable but low activity", artifactRefs=[]))

def test_full_leaf_and_bottom_up_insight_survive_restart(api):
    tree = create(api)
    request = leaf(api, tree)
    completed = mutate(api, tree, "complete", resultHandle=result(api, tree, request)["handle"])
    assert completed["node"]["score"] == 7.5
    assert completed["pendingPropagationNodeId"] == "1"
    with pytest.raises(IdeaTreeError, match="propagation"):
        mutate(api, tree, "addNode", parentId="ROOT", hypothesis="Too early")
    for identifier in ["1", "ROOT"]:
        view = api("view", dict(treeId=tree["treeId"], format="node", nodeId=identifier))
        mutate(api, tree, "updateNode", nodeId=identifier, insight=f"Lessons for {identifier}", propagationChildDigest=view["propagation"]["childDigest"])
    mutate(api, tree, "finish")
    graph = IdeaTreeStore(api.root).call("project", "session", "readGraph", dict(treeId=tree["treeId"]))
    assert graph["nodes"][0]["insight"] == "Lessons for ROOT"
    assert graph["nodes"][2]["score"] == 7.5
    assert [(e["source"],e["target"]) for e in graph["edges"]] == [("ROOT","1"),("1","1.1")]
    stored = json.loads((api.root / "project/session/state.json").read_text())
    nodes = stored["trees"][tree["treeId"]]["nodes"]
    assert nodes[2]["parent_index"] == 1
    assert "childrenIds" not in nodes[0]["data"] and "parentId" not in nodes[2]["data"]
    assert not hasattr(Tree, "add_node")

def test_only_terminal_depth_and_one_session_claim(api):
    trees = [create(api, key) for key in ["first", "other"]]
    for tree in trees:
        mutate(api, tree, "addNode", parentId="ROOT", hypothesis="Direction")
        with pytest.raises(IdeaTreeError, match="max-depth"):
            mutate(api, tree, "claim", nodeId="1")
        mutate(api, tree, "addNode", parentId="1", hypothesis="Leaf")
    def claim(t):
        try: return mutate(api, t, "claim", nodeId="1.1")
        except IdeaTreeError as error: return error.code
    with ThreadPoolExecutor(2) as pool:
        answers = list(pool.map(claim, trees))
    assert sum(isinstance(a, dict) for a in answers) == 1
    assert "TREE_BUSY" in answers

def test_duplicate_save_failure_retry_and_stale_result(api, monkeypatch):
    tree = create(api)
    params = dict(treeId=tree["treeId"], expectedRevision=1, idempotencyKey="add", parentId="ROOT", hypothesis="Direction")
    first = api("addNode", params)
    assert api("addNode", params) == first
    tree["revision"] = first["revision"]
    original = api.store._save
    def broken(*_): raise OSError("disk full")
    monkeypatch.setattr(api.store, "_save", broken)
    with pytest.raises(IdeaTreeError, match="disk full"):
        mutate(api, tree, "addNode", parentId="1", hypothesis="Leaf")
    assert api("readGraph", dict(treeId=tree["treeId"]))["revision"] == tree["revision"]
    monkeypatch.setattr(api.store, "_save", original)
    mutate(api, tree, "addNode", parentId="1", hypothesis="Leaf")
    request = mutate(api, tree, "claim", nodeId="1.1")["request"]
    stale = result(api, tree, request)
    assert api("abandonOwnedExecution", dict(message="cancelled", reasonCode="cancelled"))
    tree["revision"] = api("readGraph", dict(treeId=tree["treeId"]))["revision"]
    mutate(api, tree, "retry", nodeId="1.1")
    request = mutate(api, tree, "claim", nodeId="1.1")["request"]
    assert request["attempt"] == 2
    with pytest.raises(IdeaTreeError, match="Stale"):
        mutate(api, tree, "complete", resultHandle=stale["handle"])
    complete = mutate(api, tree, "complete", resultHandle=result(api, tree, request)["handle"])
    with pytest.raises(IdeaTreeError, match="already consumed"):
        mutate(api, tree, "complete", resultHandle=complete["node"]["completedResultHandle"])

def test_settings_and_propagation_digest(api):
    settings = dict(maxDepth=2, maxNodes=8, maxSearchRounds=2, designSystemPrompt="Design carefully")
    tree = api("create", dict(executor=EXECUTOR, idempotencyKey="create",
        objective="test", rootHypothesis="root"), settings=settings)
    request = leaf(api, tree)
    assert request["settings"] == settings
    mutate(api, tree, "complete", resultHandle=result(api, tree, request)["handle"])
    with pytest.raises(IdeaTreeError, match="evidence changed"):
        mutate(api, tree, "updateNode", nodeId="1", insight="bad", propagationChildDigest="sha256:" + "0"*64)
    assert api("resumeSettings", dict(workflowSkillId="idea-tree-team")) == settings


@pytest.mark.parametrize("budgets", [dict(maxDepth=1, maxNodes=3, maxSearchRounds=1), dict(maxNodes=4)])
def test_explicit_budgets_override_settings_and_persist(api, budgets):
    defaults = dict(maxDepth=2, maxNodes=8, maxSearchRounds=2, designSystemPrompt="Keep this prompt")
    tree = api("create", dict(executor=EXECUTOR, idempotencyKey="budget", objective="test", rootHypothesis="root", **budgets), settings=defaults)
    state = IdeaTreeStore(api.root).call("project", "session", "readTree", dict(treeId=tree["treeId"]))
    expected = {**defaults, **budgets}
    assert state["settings"] == expected
    for key in ["maxDepth", "maxNodes", "maxSearchRounds"]:
        assert state[key] == expected[key]
    assert api("resumeSettings", dict(workflowSkillId="idea-tree-team")) == expected


def test_lease_comparison_handles_microseconds_at_millisecond_boundary(api, monkeypatch):
    from sciencediscovery_evolve.vendor.idea_tree import idea_tree, idea_tree_service
    tree = create(api)
    request = leaf(api, tree)
    path = api.root / "project/session/state.json"
    state = json.loads(path.read_text())
    execution = state["trees"][tree["treeId"]]["executions"][request["executionId"]]
    # Newly written leases use the same precision as now().
    assert len(execution["leaseExpiresAt"].split(".")[1]) == 4
    execution["leaseExpiresAt"] = "2026-09-10T12:00:00.123500Z"
    path.write_text(json.dumps(state))
    monkeypatch.setattr(idea_tree, "now", lambda: "2026-09-10T12:00:00.123Z")
    monkeypatch.setattr(idea_tree_service, "now", idea_tree.now)
    assert api("recover")["recoveredExecutions"] == 0
    assert result(api, tree, request)["handle"]
    monkeypatch.setattr(idea_tree_service, "now", lambda: "2026-09-10T12:00:00.124Z")
    assert api("recover")["recoveredExecutions"] == 1
