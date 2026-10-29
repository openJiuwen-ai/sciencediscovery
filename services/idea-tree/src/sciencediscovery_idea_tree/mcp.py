"""Session-scoped MCP capabilities, provisioned only by the trusted control plane.

The model never supplies project/session identity, credentials or callback URLs.
Scopes are short-lived transport capabilities; research survives their removal.
"""
import json
import secrets
import time
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from .auth import require_internal_token
from .research_service import Command, command
from .idea_tree_service import TreeCommand, command as tree_command
from .settings import read_settings

router = APIRouter()
TOOLS = [
    dict(name="create_idea_research", description="Start autonomous Idea Tree research with the user's constraints and prepared evidence. Report the handoff and end the turn; the research card streams progress. Do not poll to wait for completion.",
         inputSchema=dict(type="object", properties=dict(objective=dict(type="string", minLength=1, maxLength=16000), materials=dict(type="string", maxLength=32000)), required=["objective", "materials"], additionalProperties=False)),
    dict(name="get_idea_research", description="Read this session's research, candidate findings and progress. Omit researchId for the latest research.",
         inputSchema=dict(type="object", properties=dict(researchId=dict(type="string", maxLength=200)), additionalProperties=False)),
    dict(name="control_idea_research", description="Pause, continue or end an existing research when requested by the user.",
         inputSchema=dict(type="object", properties=dict(researchId=dict(type="string", minLength=1, maxLength=200), operation=dict(type="string", enum=["pause", "continue", "end"])), required=["researchId", "operation"], additionalProperties=False)),
    dict(name="view_idea_tree", description="Read a historical Idea Tree graph from this session.",
         inputSchema=dict(type="object", properties=dict(treeId=dict(type="string", maxLength=200)), additionalProperties=False)),
]


class Scope(BaseModel):
    projectId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")
    sessionId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")
    researchId: str = ""
    modelId: str = ""
    llm: dict = Field(default_factory=dict)
    settings: dict = Field(default_factory=dict)


@dataclass
class Grant:
    scope: Scope
    expires: float


_scopes: dict[str, Grant] = {}


@router.post("/mcp/scopes", dependencies=[Depends(require_internal_token)])
def register(scope: Scope):
    now = time.monotonic()
    for token in list(_scopes):
        if _scopes[token].expires <= now:
            del _scopes[token]
    if len(_scopes) >= 4096:
        raise HTTPException(503, "Too many active MCP scopes")
    token = secrets.token_urlsafe(32)
    _scopes[token] = Grant(scope, now + 300)
    return dict(token=token)


def resolve(token):
    grant = _scopes.get(token)
    if grant is None or grant.expires <= time.monotonic():
        _scopes.pop(token, None)
        raise HTTPException(401, "Invalid or expired MCP scope")
    return grant.scope


@router.delete("/mcp/{token}")
def revoke(token: str):
    resolve(token)
    _scopes.pop(token, None)
    return Response(status_code=204)


@router.get("/mcp/tools", dependencies=[Depends(require_internal_token)])
def tools():
    return dict(tools=TOOLS)


@router.post("/mcp/{token}")
async def rpc(token: str, request: Request):
    scope = resolve(token)
    try:
        message = await request.json()
    except ValueError:
        return JSONResponse(dict(jsonrpc="2.0", id=None, error=dict(code=-32700, message="Parse error")))
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return JSONResponse(dict(jsonrpc="2.0", id=None, error=dict(code=-32600, message="Invalid Request")))
    identifier = message.get("id")
    method = message["method"]
    if identifier is None:
        return Response(status_code=202)
    params = message.get("params") or {}
    def reply(result):
        return dict(jsonrpc="2.0", id=identifier, result=result)
    def error(code, text):
        return dict(jsonrpc="2.0", id=identifier, error=dict(code=code, message=text))
    if not isinstance(params, dict):
        return error(-32602, "Invalid params")
    if method == "initialize":
        return reply(dict(protocolVersion="2025-03-26", capabilities=dict(tools=dict(listChanged=False)), serverInfo=dict(name="idea-tree", version="0.0.0")))
    if method == "ping":
        return reply({})
    if method == "tools/list":
        return reply(dict(tools=TOOLS))
    if method != "tools/call":
        return error(-32601, "Method not found")
    name, args = params.get("name"), params.get("arguments", {})
    tool = next((t for t in TOOLS if t["name"] == name), None)
    if not tool:
        return error(-32602, "Unknown tool")
    schema = tool["inputSchema"]
    if not isinstance(args, dict) or set(args) - set(schema["properties"]) or any(k not in args for k in schema.get("required", [])):
        return error(-32602, "Invalid tool arguments")
    for key, value in args.items():
        field = schema["properties"][key]
        if not isinstance(value, str) or not field.get("minLength", 0) <= len(value) <= field.get("maxLength", 200) or ("enum" in field and value not in field["enum"]):
            return error(-32602, "Invalid tool arguments")
    try:
        payload = scope.model_dump()
        if name == "create_idea_research":
            value = await command(Command(**{**payload, "operation": "create", **args, "settings": {**read_settings(), **scope.settings}}))
        elif name == "get_idea_research":
            value = await command(Command(**{**payload, "operation": "get" if args.get("researchId") else "list", **args}))
        elif name == "control_idea_research":
            # A model cannot repurpose one run's callback token for another research.
            if args["operation"] == "continue" and args["researchId"] != scope.researchId:
                raise ValueError("A model grant pinned to this research is required")
            value = await command(Command(**{**payload, **args}))
        else:
            value = tree_command(TreeCommand(projectId=scope.projectId, sessionId=scope.sessionId,
                                 operation="readGraph", params=args))["result"]
        return reply(dict(content=[dict(type="text", text=json.dumps(value, ensure_ascii=False))], isError=False))
    except (HTTPException, ValueError, ValidationError) as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        return reply(dict(content=[dict(type="text", text=json.dumps(detail, ensure_ascii=False))], isError=True))
