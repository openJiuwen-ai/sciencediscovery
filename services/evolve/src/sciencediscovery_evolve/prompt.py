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

"""The one prompt this engine sends: mutate a parent program into a child.

**This is not upstream's prompt.** `examples/era` wraps its calls in a preamble
tuned for one Kaggle task; the objective here comes from the user's scorecard,
so the prompt has to state that objective instead. Written fresh, and labelled
as such rather than inheriting a fidelity claim it cannot support.

Everything in it earns its place by preventing a specific failure:

* **The gate's rules are stated up front.** The AST gate refuses ``open``, a
  forbidden import or a stray top-level statement, and a refusal is recorded as
  a failed candidate — so a model that was never told the rules produces a run
  full of failures that look like it cannot code.
* **The entrypoint's exact signature is given.** The runner calls
  ``train_and_predict(train_path, test_path)`` and expects one prediction per
  test row. A model that invents ``fit``/``predict`` classes fails at load with
  a message about a missing function.
* **The scorecard is spelled out, direction included.** "Improve the program" is
  not an objective; a candidate cannot be aimed at a metric it was not told
  about, and a *minimised* metric described without its direction gets
  optimised the wrong way.
* **A constraint is presented as a wall, not a cost.** Constraints refuse a
  merge outright, so a model told "prefer fast" will trade accuracy for speed it
  did not need to buy and be refused anyway.
* **The reply format is one fenced block whose docstring opens with the change.**
  ``extract_program`` takes the longest fenced block and reads the first
  docstring line as the change summary; that summary is what the user reads in
  the search graph, and without it every node is labelled with nothing.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from .vendor.era.program import available_imports

_TEMPLATE = """你在改进一个 Python 程序，让它在下面这套评分标准上得分更高。

## 目标

{statement}

## 评分标准

{criteria}
{constraints}
## 当前程序

它在留出分片上的表现：{parent_score}。本次搜索至今最好的成绩：{best_score}。

```python
{parent_code}
```

{history}
## 硬性要求

1. 必须定义 `train_and_predict(train_path, test_path)`：读这两个 CSV，返回一个
   长度等于测试集行数的一维预测序列（list 或 numpy 数组均可）。
2. 只能 import：{imports}。
3. 不能读写除这两个入参之外的任何文件，不能联网，不能 `open`/`eval`/`exec`/
   `__import__`，不能起子进程。模块顶层只允许 import、函数/类定义和字面量赋值。
4. 输出**一个** ```python 代码块，里面是完整可运行的程序（不是补丁、不是片段）。
5. 程序的模块 docstring 第一行用一句中文说明这次改了什么——它会作为这个节点的
   标签展示给用户。

先想清楚当前程序在这套标准下最薄弱的一环，再针对它做一处实质改动。
"""


def mutation_prompt(
    *,
    statement: str,
    scorecard: Mapping[str, Any],
    parent_code: str,
    parent_score: Optional[float],
    best_score: Optional[float],
    frozen: Sequence[str] = (),
    recent: Sequence[str] = (),
    rubric: str = "",
    script_contract: str = "",
    feedback: str = "",
) -> str:
    """Build the prompt for one expansion.

    ``rubric`` switches this from rewriting a program to rewriting *text*: when
    a scorecard is graded by a model there is nothing to execute, so none of the
    program contract applies and the rubric is what the candidate is aimed at.
    """
    if frozen:
        # The first of the two freezing layers: stop the model *proposing* a
        # change to the thing that marks it. The second — restoring every frozen
        # path before the suite runs — is in `test_gate_domain`, and it is the
        # one that cannot be skipped, because a candidate is executed.
        return _TEST_TEMPLATE.format(
            statement=statement.strip() or "让测试全部通过。",
            parent_code=parent_code.strip(),
            parent_score=_score(parent_score),
            best_score=_score(best_score),
            feedback=_feedback(feedback),
            history=_history(recent),
            frozen="、".join(frozen),
            imports="、".join(available_imports()),
        )
    if script_contract:
        # A scripted search's contract is whatever its evaluator calls, and the
        # evaluator is the only place that knows. Falling through to the
        # measured-mode template told every candidate to define
        # `train_and_predict(train_path, test_path)` — watched a Gaussian-
        # integral run do exactly that: candidates bolted on CSV readers and
        # LightGBM regressors "以匹配评分要求", the integral function never
        # changed, and all nine scores came out identical to ten decimal
        # places. The search finished "succeeded" having learned nothing.
        return _SCRIPT_TEMPLATE.format(
            statement=statement.strip() or "让评测脚本给出的分数更高。",
            contract=script_contract.strip(),
            parent_code=parent_code.strip(),
            parent_score=_score(parent_score),
            best_score=_score(best_score),
            feedback=_feedback(feedback),
            history=_history(recent),
            imports="、".join(available_imports()),
        )
    if rubric:
        return _TEXT_TEMPLATE.format(
            statement=statement.strip() or "按下面的评分细则把它改得更好。",
            rubric=rubric.strip(),
            parent_text=parent_code.strip(),
            parent_score=_score(parent_score),
            best_score=_score(best_score),
            history=_history(recent),
        )
    return _TEMPLATE.format(
        statement=statement.strip() or "在下面的评分标准上取得可报告的提升。",
        criteria=_criteria(scorecard),
        constraints=_constraints(scorecard),
        parent_score=_score(parent_score),
        best_score=_score(best_score),
        parent_code=parent_code.strip(),
        history=_history(recent),
        imports="、".join(available_imports()),
    )


_TEST_TEMPLATE = """你在改写一份实现，让它通过更多测试。

## 目标

{statement}

## 当前实现

通过率：{parent_score}。至今最好的：{best_score}。
{feedback}
```python
{parent_code}
```

{history}## 硬性要求

1. **不要改这些路径**：{frozen}。它们是判分依据，改了也不算——每次运行前都会被
   还原成原样。把力气花在实现上。
2. 只能 import：{imports}。
3. 输出**一个** ```python 代码块，里面是完整可运行的实现。
4. 模块 docstring 第一行用一句中文说明这次改了什么。
"""

_SCRIPT_TEMPLATE = """你在改写一个程序，它由一份**固定的评测脚本**打分。

## 目标

{statement}

## 评测脚本对候选的要求

{contract}

评测脚本会 `import candidate` 并按上面的接口调用。**接口对不上就是零分**——
不要添加评测脚本没有要求的函数（比如 train_and_predict），那不是这次的契约。

## 当前程序

它的得分：{parent_score}。至今最好的：{best_score}。
{feedback}
```python
{parent_code}
```

{history}## 硬性要求

1. 按评测脚本要求的接口写，函数名、参数一个都不能差。
2. 只能 import：{imports}。
3. 输出**一个** ```python 代码块，里面是完整可运行的程序。
4. 模块 docstring 第一行用一句中文说明这次改了什么。
"""

_TEXT_TEMPLATE = """你在改写一段内容，让它按下面的评分细则得分更高。

## 目标

{statement}

## 评分细则

{rubric}

## 当前版本

它的得分：{parent_score}。至今最好的：{best_score}。

```
{parent_text}
```

{history}## 输出格式

先用一行中文说明这次改了什么，然后给出**完整的**新版本，放在一个 ``` 代码块里
（不是补丁、不是片段、不要解释）。那一行说明会作为这个节点的标签展示给用户。
"""


def _feedback(text: str) -> str:
    """The evaluator's own diagnosis of the parent, as a prompt section.

    This existed all along — the failing test names, the "3/6 样例超出求值预算"
    — stored on the node and shown in the UI, and never put in front of the one
    reader who could act on it. A real ODE run showed the cost: six candidates
    scored exactly 0, each a reasonable adaptive method that burst the eval
    budget, and the reflector, told only "得分 0", kept trying new variants of
    the same overspend because nothing said *why* the last one died.
    """
    if not text.strip():
        return ""
    return f"\n评测对它的诊断：{text.strip()[:500]}\n"


def _criteria(scorecard: Mapping[str, Any]) -> str:
    lines = []
    for criterion in scorecard.get("criteria") or []:
        measure = criterion.get("measure") or {}
        metric = (measure.get("metric") or {}).get("name", "")
        direction = "越大越好" if criterion.get("direction") == "maximize" else "越小越好"
        weight = criterion.get("weight")
        weight_text = f"，权重 {weight}" if isinstance(weight, (int, float)) else ""
        lines.append(f"- **{criterion.get('name', criterion.get('id'))}**（{metric}，{direction}{weight_text}）")
    return "\n".join(lines) or "- （未指定判据）"


def _constraints(scorecard: Mapping[str, Any]) -> str:
    constraints = scorecard.get("constraints") or []
    if not constraints:
        return ""
    lines = []
    for constraint in constraints:
        value = constraint.get("value")
        if isinstance(value, Mapping):
            threshold = f"基线的 {value.get('relativeToBaseline')} 倍"
        else:
            threshold = str(value)
        lines.append(
            f"- **{constraint.get('name', constraint.get('id'))}**："
            f"{constraint.get('criterionId')} 必须 {constraint.get('op')} {threshold}"
        )
    # Named as a wall rather than a cost: a violated constraint refuses the
    # merge outright, so trading score for headroom below it buys nothing.
    return "\n## 否决项（越界直接判不通过，不是扣分）\n\n" + "\n".join(lines) + "\n"


def _history(recent: Sequence[str]) -> str:
    if not recent:
        return ""
    # What was already tried, so the search does not spend three expansions
    # rediscovering the same idea.
    lines = "\n".join(f"- {item}" for item in recent if item)
    return f"## 这次搜索里已经试过的改动\n\n{lines}\n\n" if lines else ""


def _score(value: Optional[float]) -> str:
    return "尚未测量" if value is None else f"{value:.4f}"
