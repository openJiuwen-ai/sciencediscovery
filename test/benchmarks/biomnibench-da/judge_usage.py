# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Known Judge spend; only proven transport failures may leave usage unknown."""
import re


def count(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**53 - 1


def allows_unknown_judge_usage(usage):
    return (usage.get('complete') is False and count(usage.get('reported_attempts'))
            and usage['reported_attempts'] > 0 and count(usage.get('unknown_attempts'))
            and usage['unknown_attempts'] > 0
            and usage.get('transport_unknown_attempts') == usage['unknown_attempts']
            and usage.get('blocking_unknown_attempts') == 0)


def usage_summary(attempts):
    if not isinstance(attempts, list):
        raise ValueError('MISSING_JUDGE_ATTEMPTS')
    totals = dict(input=0, output=0, total=0, reported_attempts=0, unknown_attempts=0,
                  transport_unknown_attempts=0, blocking_unknown_attempts=0)
    # Missing history is not a known transport failure and must not disappear.
    for attempt in attempts or [{}]:
        attempt = attempt if isinstance(attempt, dict) else {}
        usage = attempt.get('usage')
        usage = usage if isinstance(usage, dict) else {}
        values = [usage.get(k) for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')]
        if not all(count(v) for v in values):
            totals['unknown_attempts'] += 1
            status = attempt.get('http_status')
            if status is None and attempt.get('error_type') == 'HTTPError':
                match = re.fullmatch(r'HTTP (\d{3})', attempt.get('error', ''))
                status = int(match[1]) if match else -1
            transport = attempt.get('status') == 'error' and (
                (count(status) and (status == 408 or 500 <= status < 600))
                or (status is None and attempt.get('failure_kind') in ('timeout', 'network')))
            totals['transport_unknown_attempts' if transport else 'blocking_unknown_attempts'] += 1
            continue
        for key, value in zip(('input', 'output', 'total'), values):
            totals[key] += value
        totals['reported_attempts'] += 1
    totals['complete'] = totals['unknown_attempts'] == 0
    return totals
