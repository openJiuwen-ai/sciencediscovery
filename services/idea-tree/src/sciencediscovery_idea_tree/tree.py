"""Shared node identity and tree queries; mutations belong to each algorithm."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, TypeVar


@dataclass
class Node:
    index: int
    parent_index: int | None


N = TypeVar("N", bound=Node)


class Tree(Generic[N]):
    # Subclasses own initialization and their mutation lock. Queries acquire it
    # once; callers already holding it use the node collection directly.
    nodes: list[N]

    def get_node(self, index: int) -> N:
        with self._lock:
            if index < 0 or index >= len(self.nodes):
                raise IndexError(index)
            return self.nodes[index]

    def get_children(self, index: int) -> list[N]:
        with self._lock:
            return [node for node in self.nodes if node.parent_index == index]

    def get_ancestors(self, index: int) -> list[N]:
        """Nearest parent first, excluding the node itself."""
        with self._lock:
            if index < 0 or index >= len(self.nodes):
                raise IndexError(index)
            result = []
            parent = self.nodes[index].parent_index
            while parent is not None:
                result.append(self.nodes[parent])
                parent = self.nodes[parent].parent_index
            return result
