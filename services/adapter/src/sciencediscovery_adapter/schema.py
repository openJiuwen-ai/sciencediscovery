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

"""JSON-schema handling for tools handed to JiuwenSwarm."""

from __future__ import annotations

from typing import Any

# Keywords that make a validator reject a call. ScienceDiscovery's own agent treats
# a tool's schema as guidance for the model and lets the tool decide what it accepts
# (out-of-range values are clamped or explained by the tool), while JiuwenSwarm
# validates strictly and would refuse the call before the tool ever ran.
_VALIDATION_KEYWORDS = frozenset({
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "format",
    "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
})


def relax_schema(schema: Any) -> Any:
    """A copy of `schema` without the constraints that only make validators stricter.

    Types, `required`, `enum`, `items`, `properties` and combinators stay: they say what
    a call is made of. `additionalProperties: false` becomes permissive.
    """
    if isinstance(schema, list):
        return [relax_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    relaxed: dict[str, Any] = {}
    for key, value in schema.items():
        if key in _VALIDATION_KEYWORDS:
            continue
        if key == "additionalProperties" and value is False:
            continue
        relaxed[key] = relax_schema(value)
    return relaxed


def open_schema(schema: Any) -> Any:
    """`relax_schema`, and also without `enum`, `const` and `required`: what a tool shared by every run is given as.

    One run's enum (its skills, its Runners) is not another's; the run's own tool checks its arguments.
    """
    relaxed = relax_schema(schema)

    def strip(node: Any) -> Any:
        if isinstance(node, list):
            return [strip(item) for item in node]
        if not isinstance(node, dict):
            return node
        opened = {key: strip(value) for key, value in node.items() if key not in ("enum", "const", "required")}
        if isinstance(opened.get("anyOf"), list):
            alternatives = []
            for alternative in opened["anyOf"]:
                if alternative not in alternatives:
                    alternatives.append(alternative)
            opened["anyOf"] = alternatives
            # Literal unions (e.g. this agent's skill IDs) become repeated
            # string schemas once const is removed. Canonicalize them so a
            # child with fewer skills reuses the same MCP server generation.
            # Keep sibling constraints when flattening an equivalent union.
            if len(alternatives) == 1 and isinstance(alternatives[0], dict):
                rest = {key: value for key, value in opened.items() if key != "anyOf"}
                only = alternatives[0]
                if all(key not in only or only[key] == value for key, value in rest.items()):
                    return {**only, **rest}
        return opened

    return strip(relaxed)


_EMPTY_BY_TYPE = {"array": list, "object": dict}


def restore_dropped_empties(schema: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    """Put back required array/object arguments that JiuwenSwarm dropped for being empty.

    Measured on 0.2.6: a call made with `{"plan": []}` reaches the MCP server as `{}`
    (empty strings, 0 and false survive; empty lists and objects do not). `update_plan`
    clears a plan with exactly that empty list. A *required* array or object cannot be
    missing for any other reason than that drop, so it is restored as empty; optional
    ones are left alone, where "missing" and "empty" mean the same thing.
    """
    properties = schema.get("properties") or {}
    restored = dict(arguments)
    for name in schema.get("required") or []:
        empty = _EMPTY_BY_TYPE.get((properties.get(name) or {}).get("type"))
        if name not in restored and empty is not None:
            restored[name] = empty()
    return restored
