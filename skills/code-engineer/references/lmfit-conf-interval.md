# lmfit 1.3.4 confidence intervals (`conf_interval`)

Pin these calling conventions when fitting with **lmfit 1.3.4** (PyPI). Wrong first calls waste turns on opaque failed `run_python` cards before the model self-repairs. Prefer a correct first call; do **not** catch and hide real fit or CI failures.

## Preferred: `Model` / `ModelResult`

After `model.fit(...)`, call the method on the result:

```python
import numpy as np
from lmfit import Model

def michaelis_menten(x, Vmax, Km):
    return Vmax * x / (Km + x)

x = np.asarray([...], dtype=float)
y = np.asarray([...], dtype=float)

model = Model(michaelis_menten)
params = model.make_params(Vmax=100.0, Km=1.0)
params["Vmax"].min = 0
params["Km"].min = 0

result = model.fit(y, params, x=x)
# Correct for lmfit 1.3.4 — no separate minimizer argument:
ci = result.conf_interval()
print(result.fit_report())
print(ci)
```

## Alternative: `Minimizer` + module-level `conf_interval`

Signature: `conf_interval(minimizer, result, p_names=None, sigmas=None, ...)`.

```python
from lmfit import Minimizer, Parameters, conf_interval

def residual(params, x, y):
    v = params.valuesdict()
    return y - michaelis_menten(x, v["Vmax"], v["Km"])

params = Parameters()
params.add("Vmax", value=100.0, min=0)
params.add("Km", value=1.0, min=0)

mini = Minimizer(residual, params, fcn_args=(x, y))
out = mini.minimize()
# Order matters: minimizer first, then MinimizerResult:
ci = conf_interval(mini, out)
```

## Do not use (common soft-fail patterns)

These raise real errors under lmfit 1.3.4 — fix the call; do not swallow them or invent CI numbers:

| Wrong call | Typical failure |
| --- | --- |
| `conf_interval(result)` or `conf_interval(out)` (one argument) | `TypeError: conf_interval() missing 1 required positional argument: 'result'` |
| `conf_interval(out, mini)` (swapped) | Real library error (often `MinimizerException` about stderr/uncertainty, or later `AttributeError` on `prepare_fit`) — not a CI dict |
| `conf_interval(mini, out, params=...)` | `TypeError: ... unexpected keyword argument 'params'` |

If stderr shows one of the above, correct the calling convention on the next attempt (use `result.conf_interval()` for `ModelResult`, or `conf_interval(minimizer, result)` with the live `Minimizer`). Keep the original exception visible in logs.
