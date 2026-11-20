from __future__ import annotations


def apply_clock_offset(settings) -> None:
    """Sign with a corrected clock when a development host drifts.

    SigV4 rejects a request whose signature is more than fifteen minutes
    ahead. Production hosts run NTP; this exists so a local stack can still
    reach a real bucket. `HUB_CLOCK_OFFSET_SECONDS` is the only switch and is
    never set in production.
    """
    offset = getattr(settings, "clock_offset_seconds", 0)
    if not offset:
        return
    import datetime

    import botocore.auth as auth

    # Applying the same offset twice must not compound it: keep the original
    # behind the wrapper and no-op when this offset is already in place.
    if getattr(auth, "_hub_clock_offset", None) == offset:
        return
    original = getattr(auth, "_hub_clock_original", auth.get_current_datetime)
    auth._hub_clock_original = original

    def corrected(remove_tzinfo: bool = True):
        return original(remove_tzinfo) - datetime.timedelta(seconds=offset)

    auth.get_current_datetime = corrected
    auth._hub_clock_offset = offset
