"""Standalone Idea Tree HTTP and MCP service. Run exactly one ASGI worker."""
import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import research_service
from .idea_tree_service import router as tree_router
from .mcp import router as mcp_router, _scopes
from .settings import router as settings_router
from .migration import migrate_legacy
from .references import router as references_router


@asynccontextmanager
async def lifespan(app):
    migrate_legacy()
    yield
    tasks = [task for _, task in research_service._running.values()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, *research_service._cleanup_tasks, return_exceptions=True)
    research_service._running.clear()
    _scopes.clear()


app = FastAPI(title="sciencediscovery-idea-tree", lifespan=lifespan)
app.include_router(tree_router)
app.include_router(research_service.router)
app.include_router(settings_router)
app.include_router(mcp_router)
app.include_router(references_router)


@app.get("/health")
def health():
    return dict(status="healthy", service="idea-tree", running=len(research_service._running))


def main():
    import uvicorn
    if not os.environ.get("SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN"):
        raise SystemExit("SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN is required")
    uvicorn.run(app, host=os.environ.get("SCIENCE_AGENT_IDEA_TREE_HOST", "127.0.0.1"),
                port=int(os.environ.get("SCIENCE_AGENT_IDEA_TREE_PORT", "4314")), workers=1,
                access_log=False)  # MCP capability URLs must not appear in access logs.


if __name__ == "__main__":
    main()
