#!/usr/bin/env python3
"""Hermetic checks for lmfit 1.3.4 conf_interval guidance (issue #589 / #335 S4).

Content tests always run. API tests require lmfit (prefer 1.3.4) and prove
correct patterns succeed while known-wrong patterns still raise real errors —
they must not be swallowed.
"""

from __future__ import annotations

import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
REFERENCE = SKILL_ROOT / "references" / "lmfit-conf-interval.md"
SKILL_MD = SKILL_ROOT / "SKILL.md"

try:
    import lmfit
    from lmfit import Minimizer, Model, Parameters, conf_interval
except ImportError:  # pragma: no cover - environment without lmfit
    lmfit = None  # type: ignore[assignment]
    Minimizer = Model = Parameters = conf_interval = None  # type: ignore[misc, assignment]


def michaelis_menten(x, Vmax, Km):
    return Vmax * x / (Km + x)


def _has_lmfit() -> bool:
    return lmfit is not None


@unittest.skipUnless(_has_lmfit(), "lmfit is not installed")
class LmfitConfIntervalApiTests(unittest.TestCase):
    """Exercise correct vs wrong conf_interval calling conventions."""

    @classmethod
    def setUpClass(cls) -> None:
        import numpy as np

        version = getattr(lmfit, "__version__", "")
        if not str(version).startswith("1.3"):
            raise unittest.SkipTest(f"expected lmfit 1.3.x for #589, found {version!r}")

        rng = np.random.default_rng(0)
        x = np.linspace(0.5, 10.0, 24)
        y = michaelis_menten(x, 100.0, 2.5) + rng.normal(0.0, 1.5, size=x.size)
        cls.x = x
        cls.y = y

    def _fit_minimizer(self):
        def residual(params):
            values = params.valuesdict()
            return self.y - michaelis_menten(self.x, values["Vmax"], values["Km"])

        params = Parameters()
        params.add("Vmax", value=80.0, min=0)
        params.add("Km", value=3.0, min=0)
        mini = Minimizer(residual, params)
        out = mini.minimize()
        return mini, out, params

    def test_model_result_conf_interval_succeeds(self) -> None:
        model = Model(michaelis_menten)
        params = model.make_params(Vmax=80.0, Km=3.0)
        params["Vmax"].min = 0
        params["Km"].min = 0
        result = model.fit(self.y, params, x=self.x)
        self.assertTrue(result.success)
        ci = result.conf_interval()
        self.assertIn("Vmax", ci)
        self.assertIn("Km", ci)

    def test_minimizer_conf_interval_succeeds(self) -> None:
        mini, out, _params = self._fit_minimizer()
        self.assertTrue(out.success)
        ci = conf_interval(mini, out)
        self.assertIn("Vmax", ci)
        self.assertIn("Km", ci)

    def test_wrong_single_argument_still_raises_typeerror(self) -> None:
        _mini, out, _params = self._fit_minimizer()
        with self.assertRaises(TypeError) as ctx:
            conf_interval(out)  # type: ignore[arg-type]
        self.assertIn("result", str(ctx.exception))

    def test_wrong_swapped_arguments_still_raises(self) -> None:
        """Swapped args must fail with a real library error (never a CI dict).

        lmfit 1.3.4 typically raises MinimizerException (stderr / params path)
        before AttributeError on prepare_fit; either is acceptable — do not
        swallow.
        """
        mini, out, _params = self._fit_minimizer()
        with self.assertRaises(Exception) as ctx:
            conf_interval(out, mini)  # type: ignore[arg-type]
        message = str(ctx.exception)
        self.assertTrue(
            ("prepare_fit" in message)
            or ("Confidence Intervals" in message)
            or ("stderr" in message.lower())
            or type(ctx.exception).__name__ in {"AttributeError", "MinimizerException", "TypeError"},
            msg=f"unexpected swapped-arg failure: {type(ctx.exception).__name__}: {message}",
        )

    def test_unexpected_params_kwarg_still_raises_typeerror(self) -> None:
        mini, out, params = self._fit_minimizer()
        with self.assertRaises(TypeError) as ctx:
            conf_interval(mini, out, params=params)  # type: ignore[call-arg]
        self.assertIn("params", str(ctx.exception))


class LmfitConfIntervalGuidanceTests(unittest.TestCase):
    """Contract: skill points at the reference and documents correct APIs."""

    def test_reference_file_exists(self) -> None:
        self.assertTrue(REFERENCE.is_file(), f"missing guidance file: {REFERENCE}")

    def test_reference_documents_correct_and_wrong_patterns(self) -> None:
        text = REFERENCE.read_text(encoding="utf-8")
        self.assertIn("result.conf_interval()", text)
        self.assertIn("conf_interval(minimizer, result)", text)
        self.assertIn("1.3.4", text)
        self.assertIn("prepare_fit", text)
        self.assertIn("Do not use", text)
        self.assertIn("swallow", text.lower())

    def test_skill_md_points_at_reference(self) -> None:
        text = SKILL_MD.read_text(encoding="utf-8")
        self.assertIn("references/lmfit-conf-interval.md", text)
        self.assertIn("conf_interval", text)

    def test_reference_is_utf8_markdown(self) -> None:
        raw = REFERENCE.read_bytes()
        self.assertFalse(raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"))
        self.assertTrue(REFERENCE.read_text(encoding="utf-8").lstrip().startswith("#"))


if __name__ == "__main__":
    unittest.main()
