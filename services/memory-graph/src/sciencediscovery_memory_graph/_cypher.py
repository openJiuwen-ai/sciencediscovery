# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""A small openCypher interpreter over :class:`~.local_graph.Graph`.

It implements exactly the subset this service's statements use, so the
persistence / query / search-graph modules run unchanged on the local backend:

* clauses ``MATCH`` / ``OPTIONAL MATCH`` (+ ``WHERE``), ``WITH`` (``DISTINCT``,
  ``ORDER BY``, ``SKIP``, ``LIMIT``, ``WHERE``), ``UNWIND``, ``MERGE`` (``ON
  CREATE`` / ``ON MATCH SET``), ``CREATE``, ``SET`` (``x.p = v``, ``x += map``),
  ``DELETE`` / ``DETACH DELETE``, ``RETURN``, ``UNION [ALL]``, ``CALL { }`` /
  ``CALL (v) { }`` unit and returning subqueries, ``FOREACH``;
* patterns with labels, property maps, relationship type alternation, all three
  directions and variable-length hops (``*0..``, ``*1..3``);
* expressions with three-valued logic, ``CASE``, list / map literals, indexing,
  ``IN`` / ``STARTS WITH`` / ``CONTAINS`` / ``IS NULL``, ``reduce`` and the
  handful of functions in ``_FUNCS`` plus the aggregates.

Execution is eager (each clause maps a list of rows to a list of rows), which
matches how these statements behave on Neo4j closely enough that no caller
depends on lazy evaluation. Schema DDL (``CREATE CONSTRAINT`` / ``INDEX``,
``DROP``, ``SHOW``) is accepted and does nothing: uniqueness is guaranteed by the
``MERGE`` keys, and the graph indexes property equality on its own.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterator

from .local_graph import Graph, Node, Rel, index_key


class CypherError(RuntimeError):
    """Syntax or evaluation error, raised the way a server-side error would be."""


class CypherBudgetExceeded(CypherError):
    """The local interpreter stopped a query before unbounded work or memory."""


_MAX_QUERY_WORK = 250_000
_MAX_INTERMEDIATE_ROWS = 50_000
_MAX_QUERY_SECONDS = 10.0


@dataclass
class QueryStats:
    work: int = 0
    intermediate_peak: int = 0
    traversals: int = 0


# --- Lexer -------------------------------------------------------------------

_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+|//[^\n]*|/\*.*?\*/)
  | (?P<num>\d+\.\d+(?:[eE][+-]?\d+)?|\d+)
  | (?P<str>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")
  | (?P<param>\$[A-Za-z_][A-Za-z0-9_]*)
  | (?P<bt>`[^`]*`)
  | (?P<id>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op><-|->|<>|!=|<=|>=|=~|\+=|\.\.|[-+*/%=<>()\[\]{}:,.|^])
    """,
    re.X | re.S,
)

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"'}


def _unescape(body: str) -> str:
    return re.sub(r"\\(.)", lambda m: _ESCAPES.get(m.group(1), m.group(1)), body)


class Tok:
    __slots__ = ("kind", "val", "start", "end")

    def __init__(self, kind: str, val: Any, start: int, end: int) -> None:
        self.kind = kind
        self.val = val
        self.start = start
        self.end = end


def _lex(src: str) -> list[Tok]:
    toks: list[Tok] = []
    pos = 0
    while pos < len(src):
        m = _TOKEN_RE.match(src, pos)
        if m is None:
            raise CypherError(f"unexpected character {src[pos]!r} at {pos}")
        kind = m.lastgroup
        text = m.group()
        if kind == "num":
            toks.append(Tok("num", float(text) if ("." in text or "e" in text.lower()) else int(text),
                            pos, m.end()))
        elif kind == "str":
            toks.append(Tok("str", _unescape(text[1:-1]), pos, m.end()))
        elif kind == "param":
            toks.append(Tok("param", text[1:], pos, m.end()))
        elif kind == "bt":
            toks.append(Tok("id", text[1:-1], pos, m.end()))
        elif kind == "id":
            toks.append(Tok("id", text, pos, m.end()))
        elif kind == "op":
            toks.append(Tok("op", text, pos, m.end()))
        pos = m.end()
    toks.append(Tok("eof", None, len(src), len(src)))
    return toks


# --- AST ---------------------------------------------------------------------
# Expressions are tuples tagged by their first element; clauses and patterns
# are small classes / dicts.

_AGGREGATES = {"count", "collect", "max", "min", "sum", "avg"}


class NodePat:
    def __init__(self, var: str, labels: list[str], props: list[tuple[str, Any]]) -> None:
        self.var, self.labels, self.props = var, labels, props


class RelPat:
    def __init__(self, var: str, types: list[str], props: list[tuple[str, Any]],
                 direction: str, varlen: bool, lo: int, hi: int | None) -> None:
        self.var, self.types, self.props = var, types, props
        self.direction, self.varlen, self.lo, self.hi = direction, varlen, lo, hi


class Part:
    def __init__(self, nodes: list[NodePat], rels: list[RelPat]) -> None:
        self.nodes, self.rels = nodes, rels


class Item:
    def __init__(self, expr: Any, name: str, agg: bool) -> None:
        self.expr, self.name, self.agg = expr, name, agg


class Proj:
    def __init__(self, items: list[Item], distinct: bool, star: bool,
                 order: list[tuple[Any, bool]], skip: Any, limit: Any, where: Any) -> None:
        self.items, self.distinct, self.star = items, distinct, star
        self.order, self.skip, self.limit, self.where = order, skip, limit, where


# --- Parser ------------------------------------------------------------------

class Parser:
    def __init__(self, src: str) -> None:
        self.src = src
        self.toks = _lex(src)
        self.i = 0
        self._anon = 0

    # token helpers
    @property
    def cur(self) -> Tok:
        return self.toks[self.i]

    def _peek(self, k: int = 1) -> Tok:
        return self.toks[min(self.i + k, len(self.toks) - 1)]

    def _adv(self) -> Tok:
        t = self.toks[self.i]
        self.i += 1
        return t

    def _is_kw(self, *words: str, tok: Tok | None = None) -> bool:
        t = tok or self.cur
        return t.kind == "id" and t.val.upper() in words

    def _accept_kw(self, *words: str) -> bool:
        if self._is_kw(*words):
            self.i += 1
            return True
        return False

    def _expect_kw(self, word: str) -> None:
        if not self._accept_kw(word):
            self._fail(f"expected {word}")

    def _is_op(self, op: str, tok: Tok | None = None) -> bool:
        t = tok or self.cur
        return t.kind == "op" and t.val == op

    def _accept_op(self, op: str) -> bool:
        if self._is_op(op):
            self.i += 1
            return True
        return False

    def _expect_op(self, op: str) -> None:
        if not self._accept_op(op):
            self._fail(f"expected {op!r}")

    def _ident(self) -> str:
        if self.cur.kind != "id":
            self._fail("expected identifier")
        return self._adv().val

    def _fail(self, msg: str) -> None:
        t = self.cur
        raise CypherError(f"syntax error: {msg} near {self.src[t.start:t.start + 24]!r}")

    def _anon_name(self) -> str:
        self._anon += 1
        return f" anon{self._anon}"

    # queries
    def parse(self) -> tuple[list[Any], bool]:
        """Returns ``(branches, union_all)``; each branch is a clause list."""
        branches = [self._clauses()]
        union_all = True
        while self._accept_kw("UNION"):
            if not self._accept_kw("ALL"):
                union_all = False
            branches.append(self._clauses())
        if self.cur.kind != "eof":
            self._fail("unexpected trailing input")
        return branches, union_all

    def _clauses(self) -> list[Any]:
        out: list[Any] = []
        while True:
            t = self.cur
            if t.kind != "id":
                break
            w = t.val.upper()
            if w == "MATCH":
                self.i += 1
                out.append(self._match(False))
            elif w == "OPTIONAL":
                self.i += 1
                self._expect_kw("MATCH")
                out.append(self._match(True))
            elif w == "WITH":
                self.i += 1
                out.append(("with", self._projection()))
            elif w == "RETURN":
                self.i += 1
                out.append(("return", self._projection()))
            elif w == "UNWIND":
                self.i += 1
                e = self._expr()
                self._expect_kw("AS")
                out.append(("unwind", e, self._ident()))
            elif w == "MERGE":
                self.i += 1
                out.append(self._merge())
            elif w == "CREATE":
                self.i += 1
                out.append(("create", self._pattern_list()))
            elif w == "SET":
                self.i += 1
                out.append(("set", self._set_items()))
            elif w in ("DELETE", "DETACH"):
                detach = w == "DETACH"
                self.i += 1
                if detach:
                    self._expect_kw("DELETE")
                exprs = [self._expr()]
                while self._accept_op(","):
                    exprs.append(self._expr())
                out.append(("delete", exprs, detach))
            elif w == "CALL":
                self.i += 1
                out.append(self._call())
            elif w == "FOREACH":
                self.i += 1
                out.append(self._foreach())
            else:
                break
        if not out:
            self._fail("expected a clause")
        return out

    def _match(self, optional: bool) -> Any:
        parts = self._pattern_list()
        where = self._expr() if self._accept_kw("WHERE") else None
        return ("match", parts, where, optional)

    def _merge(self) -> Any:
        part = self._pattern_part()
        on_create: list[Any] = []
        on_match: list[Any] = []
        while self._is_kw("ON"):
            self.i += 1
            if self._accept_kw("CREATE"):
                self._expect_kw("SET")
                on_create += self._set_items()
            else:
                self._expect_kw("MATCH")
                self._expect_kw("SET")
                on_match += self._set_items()
        return ("merge", part, on_create, on_match)

    def _call(self) -> Any:
        imports: list[str] | None = None
        if self._accept_op("("):
            imports = []
            while not self._is_op(")"):
                imports.append(self._ident())
                self._accept_op(",")
            self._expect_op(")")
        self._expect_op("{")
        branches, union_all = self._sub_body()
        self._expect_op("}")
        if imports is None:
            # Legacy import form: a leading ``WITH a, b`` of bare variables.
            first = branches[0][0]
            if first[0] == "with":
                proj = first[1]
                if (proj.items and not proj.distinct and not proj.where and not proj.order
                        and all(i.expr[0] == "var" and i.expr[1] == i.name for i in proj.items)):
                    imports = [i.name for i in proj.items]
                    branches[0] = branches[0][1:]
        return ("call", imports, branches, union_all)

    def _sub_body(self) -> tuple[list[Any], bool]:
        branches = [self._clauses()]
        union_all = True
        while self._accept_kw("UNION"):
            if not self._accept_kw("ALL"):
                union_all = False
            branches.append(self._clauses())
        return branches, union_all

    def _foreach(self) -> Any:
        self._expect_op("(")
        var = self._ident()
        self._expect_kw("IN")
        lst = self._expr()
        self._expect_op("|")
        body = self._clauses()
        self._expect_op(")")
        return ("foreach", var, lst, body)

    def _set_items(self) -> list[Any]:
        items = [self._set_item()]
        while self._accept_op(","):
            items.append(self._set_item())
        return items

    def _set_item(self) -> Any:
        var = self._ident()
        if self._accept_op("."):
            key = self._ident()
            self._expect_op("=")
            return ("prop", var, key, self._expr())
        if self._accept_op("+="):
            return ("merge_map", var, self._expr())
        if self._accept_op("="):
            return ("replace_map", var, self._expr())
        if self._is_op(":"):
            labels = []
            while self._accept_op(":"):
                labels.append(self._ident())
            return ("labels", var, labels)
        self._fail("bad SET item")

    # projections
    def _projection(self) -> Proj:
        distinct = self._accept_kw("DISTINCT")
        items: list[Item] = []
        star = False
        while True:
            if self._is_op("*"):
                self.i += 1
                star = True
            else:
                start = self.cur.start
                e = self._expr()
                end = self.toks[self.i - 1].end
                name = self._ident() if self._accept_kw("AS") else self.src[start:end].strip()
                items.append(Item(e, name, _has_agg(e)))
            if not self._accept_op(","):
                break
        order: list[tuple[Any, bool]] = []
        skip = limit = where = None
        if self._is_kw("ORDER"):
            self.i += 1
            self._expect_kw("BY")
            while True:
                e = self._expr()
                desc = False
                if self._accept_kw("DESC", "DESCENDING"):
                    desc = True
                else:
                    self._accept_kw("ASC", "ASCENDING")
                order.append((e, desc))
                if not self._accept_op(","):
                    break
        if self._accept_kw("SKIP"):
            skip = self._expr()
        if self._accept_kw("LIMIT"):
            limit = self._expr()
        if self._accept_kw("WHERE"):
            where = self._expr()
        return Proj(items, distinct, star, order, skip, limit, where)

    # patterns
    def _pattern_list(self) -> list[Part]:
        parts = [self._pattern_part()]
        while self._accept_op(","):
            parts.append(self._pattern_part())
        return parts

    def _pattern_part(self) -> Part:
        nodes = [self._node_pat()]
        rels: list[RelPat] = []
        while self._is_op("-") or self._is_op("<-"):
            rels.append(self._rel_pat())
            nodes.append(self._node_pat())
        return Part(nodes, rels)

    def _node_pat(self) -> NodePat:
        self._expect_op("(")
        var = self._adv().val if self.cur.kind == "id" else self._anon_name()
        labels: list[str] = []
        while self._accept_op(":"):
            labels.append(self._ident())
        props = self._prop_map() if self._is_op("{") else []
        self._expect_op(")")
        return NodePat(var, labels, props)

    def _prop_map(self) -> list[tuple[str, Any]]:
        self._expect_op("{")
        out: list[tuple[str, Any]] = []
        while not self._is_op("}"):
            key = self._adv().val
            self._expect_op(":")
            out.append((key, self._expr()))
            if not self._accept_op(","):
                break
        self._expect_op("}")
        return out

    def _rel_pat(self) -> RelPat:
        left_arrow = self._accept_op("<-")
        if not left_arrow:
            self._expect_op("-")
        var = self._anon_name()
        types: list[str] = []
        props: list[tuple[str, Any]] = []
        varlen, lo, hi = False, 1, 1
        if self._accept_op("["):
            if self.cur.kind == "id":
                var = self._adv().val
            if self._accept_op(":"):
                types.append(self._ident())
                while self._accept_op("|"):
                    self._accept_op(":")
                    types.append(self._ident())
            if self._accept_op("*"):
                varlen, lo, hi = True, 1, None
                if self.cur.kind == "num":
                    lo = self._adv().val
                    hi = lo
                    if self._accept_op(".."):
                        hi = self._adv().val if self.cur.kind == "num" else None
                elif self._accept_op(".."):
                    hi = self._adv().val if self.cur.kind == "num" else None
            if self._is_op("{"):
                props = self._prop_map()
            self._expect_op("]")
        if self._accept_op("->"):
            direction = "out"
        else:
            self._expect_op("-")
            direction = "in" if left_arrow else "both"
        if left_arrow and direction == "out":
            direction = "both"
        return RelPat(var, types, props, direction, varlen, lo, hi)

    # expressions
    def _expr(self) -> Any:
        return self._or()

    def _or(self) -> Any:
        left = self._xor()
        while self._accept_kw("OR"):
            left = ("or", left, self._xor())
        return left

    def _xor(self) -> Any:
        left = self._and()
        while self._accept_kw("XOR"):
            left = ("xor", left, self._and())
        return left

    def _and(self) -> Any:
        left = self._not()
        while self._accept_kw("AND"):
            left = ("and", left, self._not())
        return left

    def _not(self) -> Any:
        if self._accept_kw("NOT"):
            return ("not", self._not())
        return self._comparison()

    def _comparison(self) -> Any:
        left = self._additive()
        while True:
            t = self.cur
            if t.kind == "op" and t.val in ("=", "<>", "!=", "<", ">", "<=", ">=", "=~"):
                self.i += 1
                op = "<>" if t.val == "!=" else t.val
                left = ("cmp", op, left, self._additive())
            elif self._is_kw("IN"):
                self.i += 1
                left = ("in", left, self._additive())
            elif self._is_kw("IS"):
                self.i += 1
                neg = self._accept_kw("NOT")
                self._expect_kw("NULL")
                left = ("isnull", left, neg)
            elif self._is_kw("STARTS"):
                self.i += 1
                self._expect_kw("WITH")
                left = ("strop", "starts", left, self._additive())
            elif self._is_kw("ENDS"):
                self.i += 1
                self._expect_kw("WITH")
                left = ("strop", "ends", left, self._additive())
            elif self._is_kw("CONTAINS"):
                self.i += 1
                left = ("strop", "contains", left, self._additive())
            else:
                return left

    def _additive(self) -> Any:
        left = self._multiplicative()
        while self.cur.kind == "op" and self.cur.val in ("+", "-"):
            op = self._adv().val
            left = ("arith", op, left, self._multiplicative())
        return left

    def _multiplicative(self) -> Any:
        left = self._unary()
        while self.cur.kind == "op" and self.cur.val in ("*", "/", "%"):
            op = self._adv().val
            left = ("arith", op, left, self._unary())
        return left

    def _unary(self) -> Any:
        if self._accept_op("-"):
            return ("neg", self._unary())
        if self._accept_op("+"):
            return self._unary()
        return self._postfix()

    def _postfix(self) -> Any:
        e = self._atom()
        while True:
            if self._is_op(".") and self._peek().kind == "id":
                self.i += 1
                e = ("prop", e, self._adv().val)
            elif self._is_op("["):
                self.i += 1
                if self._accept_op(".."):
                    hi = None if self._is_op("]") else self._expr()
                    self._expect_op("]")
                    e = ("slice", e, None, hi)
                    continue
                idx = self._expr()
                if self._accept_op(".."):
                    hi = None if self._is_op("]") else self._expr()
                    self._expect_op("]")
                    e = ("slice", e, idx, hi)
                else:
                    self._expect_op("]")
                    e = ("idx", e, idx)
            elif self._is_op(":") and e[0] == "var" and self._peek().kind == "id":
                labels = []
                while self._is_op(":") and self._peek().kind == "id":
                    self.i += 1
                    labels.append(self._adv().val)
                e = ("haslabel", e, labels)
            else:
                return e

    def _atom(self) -> Any:
        t = self.cur
        if t.kind == "num" or t.kind == "str":
            self.i += 1
            return ("lit", t.val)
        if t.kind == "param":
            self.i += 1
            return ("param", t.val)
        if t.kind == "op":
            if t.val == "(":
                self.i += 1
                e = self._expr()
                self._expect_op(")")
                return e
            if t.val == "[":
                self.i += 1
                items = []
                while not self._is_op("]"):
                    items.append(self._expr())
                    if not self._accept_op(","):
                        break
                self._expect_op("]")
                return ("list", items)
            if t.val == "{":
                self.i += 1
                pairs = []
                while not self._is_op("}"):
                    key = self._adv().val
                    self._expect_op(":")
                    pairs.append((key, self._expr()))
                    if not self._accept_op(","):
                        break
                self._expect_op("}")
                return ("map", pairs)
            self._fail("unexpected token")
        if t.kind == "id":
            w = t.val.upper()
            if w == "TRUE":
                self.i += 1
                return ("lit", True)
            if w == "FALSE":
                self.i += 1
                return ("lit", False)
            if w == "NULL":
                self.i += 1
                return ("lit", None)
            if w == "CASE":
                self.i += 1
                return self._case()
            if w == "REDUCE" and self._is_op("(", self._peek()):
                self.i += 2
                acc = self._ident()
                self._expect_op("=")
                init = self._expr()
                self._expect_op(",")
                var = self._ident()
                self._expect_kw("IN")
                lst = self._expr()
                self._expect_op("|")
                body = self._expr()
                self._expect_op(")")
                return ("reduce", acc, init, var, lst, body)
            if self._is_op("(", self._peek()):
                name = t.val.lower()
                self.i += 2
                distinct = self._accept_kw("DISTINCT")
                if self._is_op("*"):
                    self.i += 1
                    self._expect_op(")")
                    return ("func", name, [], distinct, True)
                args = []
                while not self._is_op(")"):
                    args.append(self._expr())
                    if not self._accept_op(","):
                        break
                self._expect_op(")")
                return ("func", name, args, distinct, False)
            self.i += 1
            return ("var", t.val)
        self._fail("unexpected token")

    def _case(self) -> Any:
        operand = None if self._is_kw("WHEN") else self._expr()
        whens = []
        while self._accept_kw("WHEN"):
            cond = self._expr()
            self._expect_kw("THEN")
            whens.append((cond, self._expr()))
        other = self._expr() if self._accept_kw("ELSE") else None
        self._expect_kw("END")
        return ("case", operand, whens, other)


def _has_agg(e: Any) -> bool:
    if not isinstance(e, tuple):
        return False
    if e[0] == "func" and e[1] in _AGGREGATES:
        return True
    for part in e[1:]:
        if isinstance(part, tuple) and _has_agg(part):
            return True
        if isinstance(part, list):
            for sub in part:
                if isinstance(sub, tuple) and (_has_agg(sub) or (
                        len(sub) == 2 and isinstance(sub[1], tuple) and _has_agg(sub[1]))):
                    return True
    return False


# --- Values ------------------------------------------------------------------

def _key(v: Any) -> Any:
    """Hashable canonical form used for DISTINCT / grouping."""
    if isinstance(v, (Node, Rel)):
        return ("e", v.id)
    if isinstance(v, list):
        return ("l", tuple(_key(x) for x in v))
    if isinstance(v, dict):
        return ("m", tuple(sorted((k, _key(x)) for k, x in v.items())))
    if isinstance(v, bool):
        return ("b", v)
    if isinstance(v, (int, float)):
        return ("n", v)
    return v


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _eq(a: Any, b: Any) -> bool | None:
    if a is None or b is None:
        return None
    if isinstance(a, (Node, Rel)) or isinstance(b, (Node, Rel)):
        return type(a) is type(b) and a.id == b.id
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        result: bool | None = True
        for x, y in zip(a, b):
            r = _eq(x, y)
            if r is False:
                return False
            if r is None:
                result = None
        return result
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return False
        result = True
        for k in a:
            r = _eq(a[k], b[k])
            if r is False:
                return False
            if r is None:
                result = None
        return result
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_num(a) and _is_num(b):
        return a == b
    return type(a) is type(b) and a == b


def _order_cmp(op: str, a: Any, b: Any) -> bool | None:
    if a is None or b is None:
        return None
    if not ((_is_num(a) and _is_num(b)) or (isinstance(a, str) and isinstance(b, str))
            or (isinstance(a, bool) and isinstance(b, bool))):
        return None
    return {"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]


def _truth(v: Any) -> bool | None:
    if v is None or isinstance(v, bool):
        return v
    raise CypherError(f"expected a boolean, got {type(v).__name__}")


def _sort_key(v: Any) -> tuple:
    """Total order: nulls sort as the largest value (last ASC, first DESC)."""
    if v is None:
        return (9, 0)
    if isinstance(v, bool):
        return (3, v)
    if _is_num(v):
        return (4, v)
    if isinstance(v, str):
        return (2, v)
    if isinstance(v, list):
        return (1, tuple(_sort_key(x) for x in v))
    if isinstance(v, (Node, Rel)):
        return (0, v.id)
    return (5, repr(v))


def _export(v: Any) -> Any:
    """Convert internal values to what the HTTP API returns for a row cell."""
    if isinstance(v, (Node, Rel)):
        return dict(v.props)
    if isinstance(v, list):
        return [_export(x) for x in v]
    if isinstance(v, dict):
        return {k: _export(x) for k, x in v.items()}
    return v


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _to_string(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v == int(v) and abs(v) < 1e15:
        return str(v)
    if isinstance(v, (Node, Rel)):
        return str(dict(v.props))
    return str(v)


# --- Executor ----------------------------------------------------------------

Row = dict[str, Any]


class Executor:
    def __init__(self, graph: Graph, params: dict[str, Any], stats: QueryStats | None = None) -> None:
        self.g = graph
        self.params = params
        self.stats = stats if stats is not None else QueryStats()
        self.deadline = time.monotonic() + _MAX_QUERY_SECONDS

    def _charge(self, amount: int = 1) -> None:
        self.stats.work += amount
        if self.stats.work > _MAX_QUERY_WORK or time.monotonic() > self.deadline:
            raise CypherBudgetExceeded("local query work or time budget exceeded")

    def _rows(self, rows: list[Row]) -> list[Row]:
        self.stats.intermediate_peak = max(self.stats.intermediate_peak, len(rows))
        if len(rows) > _MAX_INTERMEDIATE_ROWS:
            raise CypherBudgetExceeded("local query intermediate row budget exceeded")
        return rows

    # -- entry --------------------------------------------------------------

    def run(self, branches: list[list[Any]], union_all: bool) -> tuple[list[str], list[list[Any]]]:
        results = [self._run_clauses(b, [{}]) for b in branches]
        columns: list[str] = []
        rows: list[list[Any]] = []
        for res in results:
            cols, part = res
            if not columns:
                columns = cols
            rows.extend(part)
        if len(branches) > 1 and not union_all:
            seen: set[Any] = set()
            deduped = []
            for r in rows:
                k = _key(r)
                if k not in seen:
                    seen.add(k)
                    deduped.append(r)
            rows = deduped
        return columns, [[_export(c) for c in r] for r in rows]

    def _run_clauses(self, clauses: list[Any], rows: list[Row]) -> tuple[list[str], list[list[Any]]]:
        columns: list[str] = []
        out: list[list[Any]] = []
        returned = False
        for c in clauses:
            kind = c[0]
            if kind == "return":
                proj: Proj = c[1]
                rows, columns = self._project(rows, proj)
                out = [[r[n] for n in columns] for r in rows]
                returned = True
            else:
                rows = self._rows(self._clause(c, rows))
        if not returned:
            return [], []
        return columns, out

    def _clause(self, c: Any, rows: list[Row]) -> list[Row]:
        kind = c[0]
        if kind == "match":
            return self._match(c, rows)
        if kind == "with":
            return self._project(rows, c[1])[0]
        if kind == "unwind":
            return self._unwind(c, rows)
        if kind == "merge":
            return self._merge(c, rows)
        if kind == "create":
            return self._create(c, rows)
        if kind == "set":
            for row in rows:
                self._apply_sets(c[1], row)
            return rows
        if kind == "delete":
            return self._delete(c, rows)
        if kind == "call":
            return self._call(c, rows)
        if kind == "foreach":
            return self._foreach(c, rows)
        raise CypherError(f"unsupported clause {kind}")

    # -- expression evaluation ---------------------------------------------

    def ev(self, e: Any, row: Row, group: list[Row] | None = None) -> Any:
        tag = e[0]
        if tag == "var":
            try:
                return row[e[1]]
            except KeyError:
                raise CypherError(f"variable `{e[1]}` not defined") from None
        if tag == "lit":
            return e[1]
        if tag == "param":
            if e[1] not in self.params:
                raise CypherError(f"expected parameter(s): {e[1]}")
            return self.params[e[1]]
        if tag == "prop":
            base = self.ev(e[1], row, group)
            if base is None:
                return None
            if isinstance(base, (Node, Rel)):
                return base.props.get(e[2])
            if isinstance(base, dict):
                return base.get(e[2])
            raise CypherError(f"cannot read property {e[2]} of {type(base).__name__}")
        if tag == "cmp":
            a, b = self.ev(e[2], row, group), self.ev(e[3], row, group)
            if e[1] == "=":
                return _eq(a, b)
            if e[1] == "=~":
                if not isinstance(a, str) or not isinstance(b, str):
                    return None
                return re.fullmatch(b, a) is not None
            if e[1] == "<>":
                r = _eq(a, b)
                return None if r is None else not r
            return _order_cmp(e[1], a, b)
        if tag == "and":
            a = _truth(self.ev(e[1], row, group))
            if a is False:
                return False
            b = _truth(self.ev(e[2], row, group))
            if b is False:
                return False
            return None if (a is None or b is None) else True
        if tag == "or":
            a = _truth(self.ev(e[1], row, group))
            if a is True:
                return True
            b = _truth(self.ev(e[2], row, group))
            if b is True:
                return True
            return None if (a is None or b is None) else False
        if tag == "xor":
            a, b = _truth(self.ev(e[1], row, group)), _truth(self.ev(e[2], row, group))
            return None if (a is None or b is None) else a != b
        if tag == "not":
            a = _truth(self.ev(e[1], row, group))
            return None if a is None else not a
        if tag == "isnull":
            v = self.ev(e[1], row, group)
            return (v is not None) if e[2] else (v is None)
        if tag == "in":
            x, lst = self.ev(e[1], row, group), self.ev(e[2], row, group)
            if lst is None:
                return None
            if not isinstance(lst, list):
                raise CypherError("IN expects a list")
            saw_null = False
            for item in lst:
                r = _eq(x, item)
                if r is True:
                    return True
                if r is None:
                    saw_null = True
            if x is None and lst:
                return None
            return None if saw_null else False
        if tag == "strop":
            a, b = self.ev(e[2], row, group), self.ev(e[3], row, group)
            if not isinstance(a, str) or not isinstance(b, str):
                return None
            return a.startswith(b) if e[1] == "starts" else a.endswith(b) if e[1] == "ends" else b in a
        if tag == "arith":
            return self._arith(e[1], self.ev(e[2], row, group), self.ev(e[3], row, group))
        if tag == "neg":
            v = self.ev(e[1], row, group)
            return None if v is None else -v
        if tag == "haslabel":
            v = self.ev(e[1], row, group)
            if v is None:
                return None
            return isinstance(v, Node) and all(lb in v.labels for lb in e[2])
        if tag == "func":
            return self._func(e, row, group)
        if tag == "case":
            return self._case(e, row, group)
        if tag == "list":
            return [self.ev(x, row, group) for x in e[1]]
        if tag == "map":
            return {k: self.ev(x, row, group) for k, x in e[1]}
        if tag == "idx":
            base, idx = self.ev(e[1], row, group), self.ev(e[2], row, group)
            if base is None or idx is None:
                return None
            if isinstance(base, dict):
                return base.get(idx)
            try:
                return base[idx]
            except IndexError:
                return None
        if tag == "slice":
            base = self.ev(e[1], row, group)
            if base is None:
                return None
            lo = self.ev(e[2], row, group) if e[2] is not None else None
            hi = self.ev(e[3], row, group) if e[3] is not None else None
            return base[lo:hi]
        if tag == "reduce":
            acc = self.ev(e[2], row, group)
            for item in self.ev(e[4], row, group) or []:
                acc = self.ev(e[5], {**row, e[1]: acc, e[3]: item}, group)
            return acc
        raise CypherError(f"unsupported expression {tag}")

    @staticmethod
    def _arith(op: str, a: Any, b: Any) -> Any:
        if a is None or b is None:
            return None
        if op == "+":
            if isinstance(a, list) or isinstance(b, list):
                return (a if isinstance(a, list) else [a]) + (b if isinstance(b, list) else [b])
            if isinstance(a, str) or isinstance(b, str):
                return f"{_to_string(a)}{_to_string(b)}"
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op in ("/", "%") and b == 0:
            raise CypherError("/ by zero")
        if op == "/":
            if isinstance(a, int) and isinstance(b, int):
                q = abs(a) // abs(b)
                return q if (a >= 0) == (b >= 0) else -q
            return a / b
        if op == "%":
            return a % b
        raise CypherError(f"unsupported operator {op}")

    def _case(self, e: Any, row: Row, group: list[Row] | None) -> Any:
        operand = self.ev(e[1], row, group) if e[1] is not None else None
        for cond, result in e[2]:
            if e[1] is not None:
                hit = _eq(operand, self.ev(cond, row, group)) is True
            else:
                hit = _truth(self.ev(cond, row, group)) is True
            if hit:
                return self.ev(result, row, group)
        return self.ev(e[3], row, group) if e[3] is not None else None

    def _func(self, e: Any, row: Row, group: list[Row] | None) -> Any:
        name, args, distinct, star = e[1], e[2], e[3], e[4]
        if name in _AGGREGATES:
            if group is None:
                raise CypherError(f"aggregate {name}() used outside a projection")
            return self._aggregate(name, args, distinct, star, group)
        vals = [self.ev(a, row, group) for a in args]
        if name == "coalesce":
            for v in vals:
                if v is not None:
                    return v
            return None
        if name == "elementid" or name == "id":
            return vals[0].id if vals[0] is not None else None
        if name == "labels":
            return list(vals[0].labels) if vals[0] is not None else None
        if name == "type":
            return vals[0].type if vals[0] is not None else None
        if name == "properties":
            return dict(vals[0].props) if isinstance(vals[0], (Node, Rel)) else vals[0]
        if name == "keys":
            return list(vals[0].props) if isinstance(vals[0], (Node, Rel)) else list(vals[0] or {})
        if name == "size":
            return None if vals[0] is None else len(vals[0])
        if name == "range":
            lo, hi = vals[0], vals[1]
            step = vals[2] if len(vals) > 2 else 1
            return list(range(lo, hi + (1 if step > 0 else -1), step))
        if name == "tolower":
            return None if vals[0] is None else str(vals[0]).lower()
        if name == "toupper":
            return None if vals[0] is None else str(vals[0]).upper()
        if name == "tostring":
            return _to_string(vals[0])
        if name == "tointeger":
            try:
                return None if vals[0] is None else int(vals[0])
            except (TypeError, ValueError):
                return None
        if name == "tofloat":
            try:
                return None if vals[0] is None else float(vals[0])
            except (TypeError, ValueError):
                return None
        if name == "datetime":
            return _now() if not vals else vals[0]
        if name == "head":
            return vals[0][0] if vals[0] else None
        if name == "last":
            return vals[0][-1] if vals[0] else None
        if name == "abs":
            return None if vals[0] is None else abs(vals[0])
        raise CypherError(f"unknown function {name}()")

    def _aggregate(self, name: str, args: list[Any], distinct: bool, star: bool,
                   group: list[Row]) -> Any:
        if star:
            return len(group)
        values = [self.ev(args[0], r) for r in group]
        values = [v for v in values if v is not None]
        if distinct:
            seen: set[Any] = set()
            uniq = []
            for v in values:
                k = _key(v)
                if k not in seen:
                    seen.add(k)
                    uniq.append(v)
            values = uniq
        if name == "count":
            return len(values)
        if name == "collect":
            return values
        if name == "max":
            return max(values, key=_sort_key) if values else None
        if name == "min":
            return min(values, key=_sort_key) if values else None
        if name == "sum":
            return sum(values) if values else 0
        if name == "avg":
            return sum(values) / len(values) if values else None
        raise CypherError(f"unknown aggregate {name}()")

    # -- projection ---------------------------------------------------------

    def _project(self, rows: list[Row], proj: Proj) -> tuple[list[Row], list[str]]:
        items = proj.items
        columns = [i.name for i in items]
        pairs: list[tuple[Row, Row]] = []  # (source row for ORDER BY, projected row)
        if any(i.agg for i in items):
            keyed = [i for i in items if not i.agg]
            groups: dict[Any, list[Row]] = {}
            for row in rows:
                k = tuple(_key(self.ev(i.expr, row)) for i in keyed)
                groups.setdefault(k, []).append(row)
            if not groups and not keyed:
                groups[()] = []
            for grp in groups.values():
                base = grp[0] if grp else {}
                pairs.append((base, {i.name: self.ev(i.expr, base, grp) for i in items}))
        else:
            for row in rows:
                proj_row = {}
                if proj.star:
                    proj_row.update({k: v for k, v in row.items() if not k.startswith(" ")})
                proj_row.update({i.name: self.ev(i.expr, row) for i in items})
                pairs.append((row, proj_row))
        if proj.star:
            columns = [k for k in (pairs[0][1] if pairs else {}) if k not in columns] + columns
        if proj.distinct:
            seen: set[Any] = set()
            uniq = []
            for src, pr in pairs:
                k = tuple(_key(pr[c]) for c in columns)
                if k not in seen:
                    seen.add(k)
                    uniq.append((src, pr))
            pairs = uniq
        if proj.order:
            for expr, desc in reversed(proj.order):
                pairs.sort(key=lambda p, expr=expr: _sort_key(self.ev(expr, {**p[0], **p[1]})),
                           reverse=desc)
        if proj.skip is not None:
            pairs = pairs[int(self.ev(proj.skip, {})):]
        if proj.limit is not None:
            pairs = pairs[:int(self.ev(proj.limit, {}))]
        if proj.where is not None:
            pairs = [p for p in pairs if _truth(self.ev(proj.where, {**p[0], **p[1]})) is True]
        return [pr for _, pr in pairs], columns

    # -- MATCH --------------------------------------------------------------

    def _match(self, c: Any, rows: list[Row]) -> list[Row]:
        parts, where, optional = c[1], c[2], c[3]
        out: list[Row] = []
        new_vars = _pattern_vars(parts)
        for row in rows:
            matched = False
            for m in self._match_parts(parts, 0, row, frozenset()):
                self._charge()
                if where is not None and _truth(self.ev(where, m)) is not True:
                    continue
                matched = True
                out.append(m)
                self._rows(out)
            if optional and not matched:
                nulls = dict(row)
                for v in new_vars:
                    nulls.setdefault(v, None)
                out.append(nulls)
                self._rows(out)
        return out

    def _match_parts(self, parts: list[Part], i: int, row: Row,
                     used: frozenset[str]) -> Iterator[Row]:
        if i == len(parts):
            yield row
            return
        for r2, used2 in self._match_part(parts[i], row, used):
            yield from self._match_parts(parts, i + 1, r2, used2)

    def _match_part(self, part: Part, row: Row, used: frozenset[str]) -> Iterator[tuple[Row, frozenset[str]]]:
        for r1 in self._bind_start(part.nodes[0], row):
            yield from self._extend(part, 0, r1, used)

    def _bind_start(self, np: NodePat, row: Row) -> Iterator[Row]:
        if np.var in row:
            v = row[np.var]
            if isinstance(v, Node) and self._node_ok(np, v, row):
                yield row
            return
        for node in self._candidates(np, row):
            self._charge()
            if self._node_ok(np, node, row):
                yield {**row, np.var: node}

    def _candidates(self, np: NodePat, row: Row) -> list[Node]:
        ids: list[str] | None = None
        for k, expr in np.props:
            v = self.ev(expr, row)
            if v is None:
                return []
            ik = index_key(v)
            if ik is None:
                continue
            found = self.g.pidx.get(k, {}).get(ik, {})
            ids = list(found) if ids is None else [i for i in ids if i in found]
        if ids is None:
            if np.labels:
                ids = list(self.g.by_label.get(np.labels[0], {}))
            else:
                ids = list(self.g.nodes)
        return [self.g.nodes[i] for i in ids]

    def _node_ok(self, np: NodePat, node: Node, row: Row) -> bool:
        if any(lb not in node.labels for lb in np.labels):
            return False
        for k, expr in np.props:
            if _eq(node.props.get(k), self.ev(expr, row)) is not True:
                return False
        return True

    def _rel_ok(self, rp: RelPat, rel: Rel, row: Row) -> bool:
        if rp.types and rel.type not in rp.types:
            return False
        for k, expr in rp.props:
            if _eq(rel.props.get(k), self.ev(expr, row)) is not True:
                return False
        return True

    def _adjacent(self, rp: RelPat, nid: str) -> Iterator[tuple[Rel, str]]:
        if rp.direction in ("out", "both"):
            for rid in list(self.g.out.get(nid, ())):
                rel = self.g.rels[rid]
                yield rel, rel.dst
        if rp.direction in ("in", "both"):
            for rid in list(self.g.inn.get(nid, ())):
                rel = self.g.rels[rid]
                yield rel, rel.src

    def _extend(self, part: Part, i: int, row: Row, used: frozenset[str]) -> Iterator[tuple[Row, frozenset[str]]]:
        if i == len(part.rels):
            yield row, used
            return
        rp, nxt = part.rels[i], part.nodes[i + 1]
        cur = row[part.nodes[i].var]
        if cur is None:
            return
        if not rp.varlen:
            for rel, other_id in self._adjacent(rp, cur.id):
                if rel.id in used or not self._rel_ok(rp, rel, row):
                    continue
                if rp.var in row and row[rp.var] is not rel:
                    continue
                other = self.g.nodes[other_id]
                nr = self._bind_end(nxt, other, {**row, rp.var: rel})
                if nr is not None:
                    yield from self._extend(part, i + 1, nr, used | {rel.id})
            return
        for end_id, path in self._walk(rp, cur.id, row, used):
            other = self.g.nodes[end_id]
            nr = self._bind_end(nxt, other, {**row, rp.var: list(path)})
            if nr is not None:
                yield from self._extend(part, i + 1, nr, used | {r.id for r in path})

    def _bind_end(self, np: NodePat, node: Node, row: Row) -> Row | None:
        if np.var in row:
            existing = row[np.var]
            if existing is not node and not (isinstance(existing, Node) and existing.id == node.id):
                return None
            return row if self._node_ok(np, node, row) else None
        if not self._node_ok(np, node, row):
            return None
        return {**row, np.var: node}

    def _walk(self, rp: RelPat, start: str, row: Row, used: frozenset[str]) -> Iterator[tuple[str, tuple[Rel, ...]]]:
        stack: list[tuple[str, tuple[Rel, ...]]] = [(start, ())]
        while stack:
            self._charge()
            self.stats.traversals += 1
            nid, path = stack.pop()
            if len(path) >= rp.lo:
                yield nid, path
            if rp.hi is not None and len(path) >= rp.hi:
                continue
            taken = used | {r.id for r in path}
            nexts = []
            for rel, other_id in self._adjacent(rp, nid):
                self._charge()
                if rel.id in taken or not self._rel_ok(rp, rel, row):
                    continue
                nexts.append((other_id, path + (rel,)))
                if len(stack) + len(nexts) > _MAX_INTERMEDIATE_ROWS:
                    raise CypherBudgetExceeded("local query traversal frontier budget exceeded")
            stack.extend(reversed(nexts))

    # -- UNWIND / CALL / FOREACH ---------------------------------------------

    def _unwind(self, c: Any, rows: list[Row]) -> list[Row]:
        out: list[Row] = []
        for row in rows:
            lst = self.ev(c[1], row)
            if lst is None:
                continue
            if not isinstance(lst, list):
                lst = [lst]
            for item in lst:
                out.append({**row, c[2]: item})
        return out

    def _call(self, c: Any, rows: list[Row]) -> list[Row]:
        imports, branches, union_all = c[1], c[2], c[3]
        out: list[Row] = []
        for row in rows:
            start = {k: row[k] for k in imports if k in row} if imports is not None else {}
            sub_rows: list[Row] = [dict(start)]
            first_branch_returns = any(cl[0] == "return" for cl in branches[0])
            if not first_branch_returns:
                # Unit subquery: side effects only, the outer row passes through.
                for branch in branches:
                    self._run_clauses_rows(branch, [dict(start)])
                out.append(row)
                continue
            cols, res = self.run_branches(branches, union_all, sub_rows)
            for rec in res:
                out.append({**row, **dict(zip(cols, rec))})
        return out

    def run_branches(self, branches: list[list[Any]], union_all: bool,
                     rows: list[Row]) -> tuple[list[str], list[list[Any]]]:
        cols: list[str] = []
        acc: list[list[Any]] = []
        for b in branches:
            c, r = self._run_clauses(b, [dict(x) for x in rows])
            cols = cols or c
            acc.extend(r)
        if len(branches) > 1 and not union_all:
            seen: set[Any] = set()
            acc = [r for r in acc if not (_key(r) in seen or seen.add(_key(r)))]
        return cols, acc

    def _run_clauses_rows(self, clauses: list[Any], rows: list[Row]) -> list[Row]:
        for c in clauses:
            rows = self._clause(c, rows)
        return rows

    def _foreach(self, c: Any, rows: list[Row]) -> list[Row]:
        var, lst_expr, body = c[1], c[2], c[3]
        for row in rows:
            for item in self.ev(lst_expr, row) or []:
                self._run_clauses_rows(body, [{**row, var: item}])
        return rows

    # -- write clauses --------------------------------------------------------

    def _eval_props(self, props: list[tuple[str, Any]], row: Row) -> dict[str, Any]:
        return {k: self.ev(e, row) for k, e in props}

    def _create_node(self, np: NodePat, row: Row) -> Node:
        return self.g.create_node(np.labels, self._eval_props(np.props, row))

    def _create_part(self, part: Part, row: Row) -> Row:
        row = dict(row)
        nodes: list[Node] = []
        for np in part.nodes:
            existing = row.get(np.var)
            if isinstance(existing, Node):
                nodes.append(existing)
            else:
                node = self._create_node(np, row)
                row[np.var] = node
                nodes.append(node)
        for i, rp in enumerate(part.rels):
            if len(rp.types) != 1:
                raise CypherError("exactly one relationship type must be specified for CREATE/MERGE")
            src, dst = (nodes[i + 1], nodes[i]) if rp.direction == "in" else (nodes[i], nodes[i + 1])
            row[rp.var] = self.g.create_rel(rp.types[0], src, dst, self._eval_props(rp.props, row))
        return row

    def _create(self, c: Any, rows: list[Row]) -> list[Row]:
        out = []
        for row in rows:
            for part in c[1]:
                row = self._create_part(part, row)
            out.append(row)
        return out

    def _merge(self, c: Any, rows: list[Row]) -> list[Row]:
        part, on_create, on_match = c[1], c[2], c[3]
        out: list[Row] = []
        for row in rows:
            for np in part.nodes:
                if np.var not in row:
                    for k, e in np.props:
                        if self.ev(e, row) is None:
                            raise CypherError(
                                f"Cannot merge the following node because of null property value for '{k}'")
            matches = [m for m, _ in self._match_part(part, row, frozenset())]
            if matches:
                for m in matches:
                    self._apply_sets(on_match, m)
                out.extend(matches)
            else:
                created = self._create_part(part, row)
                self._apply_sets(on_create, created)
                out.append(created)
        return out

    def _apply_sets(self, items: list[Any], row: Row) -> None:
        for item in items:
            kind, var = item[0], item[1]
            target = row.get(var)
            if target is None:
                continue
            if kind == "prop":
                self._set_prop(target, item[2], self.ev(item[3], row))
            elif kind in ("merge_map", "replace_map"):
                value = self.ev(item[2], row)
                if isinstance(value, (Node, Rel)):
                    value = dict(value.props)
                if value is None:
                    continue
                if kind == "replace_map":
                    for k in list(target.props):
                        if k not in value:
                            self._set_prop(target, k, None)
                for k, v in value.items():
                    self._set_prop(target, k, v)
            elif kind == "labels" and isinstance(target, Node):
                for lb in item[2]:
                    self.g.add_label(target, lb)

    def _set_prop(self, target: Any, key: str, value: Any) -> None:
        if isinstance(target, Node):
            self.g.set_node_prop(target, key, value)
        else:
            self.g.set_rel_prop(target, key, value)

    def _delete(self, c: Any, rows: list[Row]) -> list[Row]:
        exprs, detach = c[1], c[2]
        rels: dict[str, Rel] = {}
        nodes: dict[str, Node] = {}
        for row in rows:
            for e in exprs:
                v = self.ev(e, row)
                if isinstance(v, Rel):
                    rels[v.id] = v
                elif isinstance(v, Node):
                    nodes[v.id] = v
        for rel in rels.values():
            self.g.delete_rel(rel)
        for node in nodes.values():
            if detach:
                self.g.detach_delete_node(node)
            else:
                self.g.delete_node(node)
        return rows


def _pattern_vars(parts: list[Part]) -> list[str]:
    names: list[str] = []
    for p in parts:
        names += [n.var for n in p.nodes]
        names += [r.var for r in p.rels]
    return names


# --- Public entry -------------------------------------------------------------

_DDL_RE = re.compile(r"^\s*(CREATE\s+(CONSTRAINT|INDEX|RANGE\s+INDEX|TEXT\s+INDEX)|DROP\s+(CONSTRAINT|INDEX)|SHOW\s+)",
                     re.I)

_PARSE_CACHE: dict[str, tuple[list[list[Any]], bool]] = {}


def execute(graph: Graph, cypher: str, params: dict[str, Any],
            stats: QueryStats | None = None) -> tuple[list[str], list[list[Any]]]:
    """Run one statement against ``graph`` and return ``(columns, rows)``."""
    if _DDL_RE.match(cypher):
        return [], []
    parsed = _PARSE_CACHE.get(cypher)
    if parsed is None:
        parsed = Parser(cypher).parse()
        if len(_PARSE_CACHE) > 512:
            _PARSE_CACHE.clear()
        _PARSE_CACHE[cypher] = parsed
    branches, union_all = parsed
    return Executor(graph, params, stats).run(branches, union_all)
