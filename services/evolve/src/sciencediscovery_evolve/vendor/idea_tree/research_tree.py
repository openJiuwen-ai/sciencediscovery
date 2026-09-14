"""Research-specific mutations on the shared tree query abstraction."""
from dataclasses import dataclass
from threading import RLock

from ...tree import Node, Tree


@dataclass
class ResearchNode(Node):
    data: dict


class ResearchTree(Tree[ResearchNode]):
    def __init__(self, data: list[dict]):
        self._lock = RLock()
        indices = {n['id']: i for i, n in enumerate(data)}
        self.nodes = [ResearchNode(i, indices.get(n['parentId']), n) for i, n in enumerate(data)]

    def find(self, identifier: str) -> ResearchNode:
        return next(n for n in self.nodes if n.data['id'] == identifier)
