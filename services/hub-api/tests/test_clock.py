from __future__ import annotations

import datetime

import botocore.auth


def test_applying_the_same_offset_twice_does_not_compound():
    from app.clock import apply_clock_offset

    original = botocore.auth.get_current_datetime
    original_offset = getattr(botocore.auth, "_hub_clock_offset", None)
    fixed = datetime.datetime(2026, 1, 1, 12, 0, 0)

    class Settings:
        clock_offset_seconds = 60

    try:
        botocore.auth.get_current_datetime = lambda remove_tzinfo=True: fixed
        botocore.auth._hub_clock_original = lambda remove_tzinfo=True: fixed
        apply_clock_offset(Settings())
        apply_clock_offset(Settings())
        result = botocore.auth.get_current_datetime(True)
        assert result == fixed - datetime.timedelta(seconds=60)
    finally:
        botocore.auth.get_current_datetime = original
        if original_offset is None:
            for name in ("_hub_clock_offset", "_hub_clock_original"):
                if hasattr(botocore.auth, name):
                    delattr(botocore.auth, name)
