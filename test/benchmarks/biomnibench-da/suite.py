#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Serial public-50 driver: finish all tasks, then allow three classified retries.

Requires a prepared checkout and explicit CI_ALLOW_REAL=1. Credentials are read
from the environment; no SSH hosts, credentials or operator paths are embedded.
"""
import argparse
import csv
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time

REPOSITORY = Path(__file__).resolve().parents[3]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def check_resources(path, min_bytes, min_inodes):
    usage = shutil.disk_usage(path)
    v = os.statvfs(path)
    if usage.free < min_bytes or v.f_favail < min_inodes:
        raise RuntimeError('Insufficient storage/inode headroom; preserve other host workloads')


def process_table():
    rows = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            fields = (p / 'stat').read_text().rsplit(')', 1)[1].split()
            rows[int(p.name)] = (int(fields[1]), fields[19])
        except (OSError, ValueError):
            pass
    return rows


def stop_owned(proc):
    rows = process_table()
    owned = {proc.pid}
    while True:
        extra = {pid for pid, (ppid, _) in rows.items() if ppid in owned} - owned
        if not extra:
            break
        owned.update(extra)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        current = process_table()
        for pid in owned:
            # Start time prevents a recycled PID from receiving a signal.
            if pid in current and pid in rows and current[pid][1] == rows[pid][1]:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
        if sig == signal.SIGTERM:
            time.sleep(5)
    proc.wait()


def execute(command, log, env, runtime, results, timeout, idle=1200):
    start = time.monotonic()
    progress_at = start
    last_stamp = None
    with log.open('w') as stream:
        proc = subprocess.Popen(command, cwd=REPOSITORY, env=env,
                                stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while proc.poll() is None:
                time.sleep(2)
                events = runtime.glob('**/run-events/**/*.jsonl')
                stamps = []
                for p in events:
                    try:
                        stamps.append((p.stat().st_mtime_ns, p.stat().st_size))
                    except FileNotFoundError:
                        pass
                stamp = max(stamps, default=None)
                if stamp != last_stamp:
                    last_stamp, progress_at = stamp, time.monotonic()
                scoring = any(results.glob('**/research-evidence.json'))
                now = time.monotonic()
                if now - start > timeout or (not scoring and now - progress_at > idle):
                    stream.write('\nTIMEOUT: isolated case exceeded deadline or analysis idle limit\n')
                    stream.flush()
                    stop_owned(proc)
                    return 124
            return proc.returncode
        finally:
            if proc.poll() is None:
                stop_owned(proc)


def reclaim(runtime, owned_root):
    runtime, owned_root = runtime.resolve(), owned_root.resolve()
    if runtime == owned_root or not runtime.is_relative_to(owned_root):
        raise ValueError('Cleanup must stay inside the suite-owned runtime directory')
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) == os.getpid():
            continue
        try:
            cwd = (p / 'cwd').resolve()
            marker = ('SCIENCE_DISCOVERY_DATA_DIR=' + str(runtime)).encode()
            if cwd.is_relative_to(runtime) or marker in (p / 'environ').read_bytes():
                raise RuntimeError('Runtime still in use; retained environments for diagnosis')
        except (PermissionError, FileNotFoundError, ProcessLookupError):
            pass
    for data in [runtime / 'data', *runtime.glob('*/data')]:
        for relative in ('envs', 'scientific-envs/provisioner', 'scientific-envs/revisions'):
            target = data / relative
            if target.exists():
                if not target.resolve().is_relative_to(runtime):
                    raise ValueError('Refuse cleanup through an escaping symlink')
                shutil.rmtree(target)


MAX_RETRIES = 3


def schedule(entries, latest):
    first = [e for e in entries if e['case'] not in latest]
    retry = [e for e in entries if e['case'] in latest and latest[e['case']]['exit'] != 0
             and not latest[e['case']].get('completed')
             and latest[e['case']].get('retry_count', 1 if latest[e['case']].get('phase') == 'retry' else 0) < MAX_RETRIES]
    return first, retry


def recoverable_evidence(root, case):
    spec = importlib.util.spec_from_file_location('biomni_rescore', Path(__file__).with_name('rescore.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    candidates = []
    for path in root.glob('**/benchmark-metrics.json'):
        try:
            if json.loads(path.read_text()).get('case_id') == case and module.completed_evidence(path.parent):
                candidates.append(path.parent)
        except (OSError, ValueError):
            continue
    return max(candidates, key=lambda p: p.stat().st_mtime_ns) if candidates else None


def run_deferred(entries, latest, history, attempt_case, persist):
    """A case failure never aborts the remaining cases; retries share one counter."""
    first, _ = schedule(entries, latest)
    for wave in range(MAX_RETRIES + 1):
        pending = first if wave == 0 else schedule(entries, latest)[1]
        for entry in pending:
            previous = latest.get(entry['case'], {})
            retry = previous.get('retry_count', 1 if previous.get('phase') == 'retry' else 0) + 1 if previous else 0
            row = dict(case=entry['case'], phase='first-pass' if retry == 0 else f'retry-{retry}',
                       retry_count=retry, started=time.time(), exit=1, completed=False)
            try:
                row.update(attempt_case(entry, row, previous))
            except Exception as error:
                # This is a per-case boundary. Operator interruption/SystemExit
                # still propagate; malformed metadata cannot abort later tasks.
                row.update(reason=f'{type(error).__name__}: {error}', failure_stage='infrastructure')
            row['finished'] = time.time()
            history.append(row)
            latest[entry['case']] = row
            persist(row)
        if wave and not schedule(entries, latest)[1]:
            break
    return latest


def run_case(args, env, selection, entry, row, previous):
    case, phase = entry['case'], row['phase']
    attempt = args.results / 'cases' / case / phase
    runtime = args.runtime / case / phase
    # New, monotonically numbered directories retain every earlier attempt.
    if attempt.exists():
        raise RuntimeError(f'Interrupted evidence retained at {attempt}; reconcile before resume')
    attempt.mkdir(parents=True)
    runtime.mkdir(parents=True)
    row['attempt_dir'] = str(attempt)
    case_env = dict(env, CI_RESULTS_DIR=str(attempt), CI_RUNTIME_DIR=str(runtime),
        JIUWENSWARM_HOME=str(runtime / 'swarm'), BIOMNI_DATA_ROOT=str(args.data_root),
        BIOMNI_PYTHON=args.python, BIOMNI_JUDGE_MAX_RETRIES='0')
    evidence = recoverable_evidence(args.results / 'cases' / case, case) if previous else None
    row['mode'] = 'evaluation-only' if evidence else 'end-to-end'
    try:
        check_resources(args.results, 5 * 1024**3, 10000)
        if evidence:
            prior = [arg for directory in sorted((args.results / 'cases' / case).glob('retry-*/evaluation-only'))
                     for arg in ('--prior-evaluation', str(directory))]
            code = execute([args.python, str(Path(__file__).with_name('rescore.py')),
                '--evidence', str(evidence), '--rubric', str(args.data_root / case / 'tests/rubric.txt'),
                '--output', str(attempt / 'evaluation-only'), *prior], attempt / 'rescore.log', case_env,
                runtime, evidence, 4000, 4000)
        else:
            check_resources(args.runtime, args.min_free_gib * 1024**3, args.min_free_inodes)
            prep = execute([args.python, str(Path(__file__).with_name('prepare.py')), 'download',
                '--root', str(args.data_root), '--case', case], attempt / 'download.log',
                case_env, runtime, attempt, 1800, args.idle_seconds)
            row['preparation_exit'] = prep
            code = 125
            if prep == 0:
                code = execute(['node', 'test/support/tagged/shared.mjs', 'run', *selection,
                    '--shard', entry['shard']], attempt / 'driver.log', case_env, runtime, attempt,
                    15000, args.idle_seconds)
        metric_files = list(attempt.glob('**/benchmark-metrics.json'))
        doc = json.loads(metric_files[0].read_text()) if len(metric_files) == 1 else {}
        evaluation = doc.get('evaluation', {})
        completed = (doc.get('integration_status') == 'passed' and evaluation.get('status') == 'scored'
            and isinstance(evaluation.get('score'), (int, float)) and not isinstance(evaluation['score'], bool)
            and 0 <= evaluation['score'] <= 100 and not doc.get('cleanup_error')
            and (bool(evidence) or code == 0 or doc.get('error') == 'UNREPORTED_JUDGE_TOKENS'))
        if doc:
            row['metrics_path'] = str(metric_files[0])
        accounting = doc.get('judge_usage', {}).get('complete', True)
        row.update(exit=0 if completed and accounting else code or 1,
            completed=bool(completed), resource_accounting_complete=doc.get('judge_usage', {}).get('complete', False),
            failure_stage='accounting' if completed and not accounting else None if completed else 'evaluation' if evidence or recoverable_evidence(attempt, case) else 'research',
            reason='UNREPORTED_JUDGE_TOKENS' if completed and not accounting else None if completed else doc.get('error', f'{row["mode"]} exit={code}'))
        return row
    finally:
        try:
            reclaim(runtime, args.runtime)
        except (OSError, RuntimeError, ValueError) as error:
            row['cleanup_reason'] = type(error).__name__


def attempt_costs(history):
    """Known spend across attempts, separate from final-result regression metrics."""
    generation = judge = unknown_generation = unknown_judge = 0
    seen_usage = set()
    for row in history:
        if row.get('metrics_path') and row.get('mode') == 'end-to-end':
            doc = json.loads(Path(row['metrics_path']).read_text())
            value = doc.get('measurements', {}).get('generation_tokens')
            if isinstance(value, int) and value >= 0:
                generation += value
            elif row.get('preparation_exit') == 0:
                unknown_generation += 1
        elif row.get('mode') == 'end-to-end' and row.get('preparation_exit') == 0:
            unknown_generation += 1
        directory = row.get('attempt_dir')
        usage_files = list(Path(directory).glob('**/quality-scorecard.attempts/attempts.json')) if directory else []
        if row.get('mode') == 'evaluation-only' and not usage_files:
            unknown_judge += 1
        for path in usage_files:
            if path.resolve() in seen_usage:
                continue
            seen_usage.add(path.resolve())
            try:
                for attempt in json.loads(path.read_text()):
                    value = (attempt.get('usage') or {}).get('total_tokens')
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                        judge += value
                    else:
                        unknown_judge += 1
            except (OSError, ValueError, TypeError):
                unknown_judge += 1
    return {'known_generation_tokens': generation, 'known_judge_tokens': judge,
        'known_total_tokens': generation + judge, 'unknown_generation_attempts': unknown_generation,
        'unknown_judge_attempts': unknown_judge,
        'sum_attempt_wall_seconds': sum(r['finished'] - r['started'] for r in history),
        'scope': 'all-attempts-known-lower-bound-not-final-result-gate'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--backend', choices=['jiuwenswarm', 'legacy'], default='jiuwenswarm')
    parser.add_argument('--idle-seconds', type=int, default=1200)
    parser.add_argument('--min-free-gib', type=int, default=64)
    parser.add_argument('--min-free-inodes', type=int, default=150000)
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.environ.get('CI_ALLOW_REAL') != '1':
        parser.error('Linux and explicit CI_ALLOW_REAL=1 are required')
    args.results, args.runtime, args.data_root = [p.resolve() for p in (args.results, args.runtime, args.data_root)]
    if args.runtime == args.results or args.runtime in args.results.parents or args.results in args.runtime.parents:
        parser.error('Results and runtime must be separate, non-nested directories')
    for p in (args.results, args.runtime):
        p.mkdir(parents=True, exist_ok=True)
    # A lock prevents competing drivers from using or cleaning this suite.
    import fcntl
    lock = (args.results / 'suite.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    env = dict(os.environ, CI_E2E_PREPARED='1')
    if env.get('BIOMNI_JUDGE_MODEL'):
        env.setdefault('E2E_JUDGE_MODEL', env['BIOMNI_JUDGE_MODEL'])
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPOSITORY, text=True).strip()
    plan_dir = args.results / 'plan'
    machine = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if not machine:
        parser.error('Unsupported architecture')
    # Explicit dimensions choose one architecture, never duplicate the 50 cases.
    selection = ['--profile', 'release', '--slice', 'e2e-real',
                 '--target-arch', machine, '--backend', args.backend]
    if not (plan_dir / 'plan.json').exists():
        subprocess.run(['node', 'test/support/tagged/shared.mjs', 'list', *selection,
                        '--output', str(plan_dir)], cwd=REPOSITORY, env=env, check=True)
    plan = json.loads((plan_dir / 'plan.json').read_text())
    if plan['revision'] != revision:
        raise RuntimeError('Resume requires the same immutable candidate revision')
    manifest = json.loads((Path(__file__).parent / 'manifest.json').read_text())
    entries = []
    research = [e for e in plan['entries'] if 'tier:l3' not in e['tags']]
    for e in research:
        if e['source'] != 'test/biomnibench-da-swarm.spec.ts':
            continue
        import re, urllib.parse
        case = re.search(r'BiomniBench-(da-\d+-\d+)\b', urllib.parse.unquote(e['id'])).group(1)
        entries.append({'case': case, 'key': e['key'], 'shard': 'research-' + str(research.index(e) + 1)})
    if sorted(e['case'] for e in entries) != sorted(t['id'] for t in manifest['tasks']):
        raise RuntimeError('Exactly the pinned public 50 are required')
    status = args.results / 'status.jsonl'
    latest = {}
    if status.exists():
        for line in status.read_text().splitlines():
            row = json.loads(line)
            latest[row['case']] = row
    history = [json.loads(line) for line in status.read_text().splitlines()] if status.exists() else []
    def persist(row):
        with status.open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        write_json(args.results / 'summary.json', {
            'revision': revision, 'expected': 50,
            'completed': sum(bool(r.get('completed', r['exit'] == 0)) for r in latest.values()),
            'first_pass_completed': sum(bool(r.get('completed', r['exit'] == 0)) for r in history if r['phase'] == 'first-pass'),
            'recovered': sum(bool(r.get('completed')) and r.get('retry_count', 0) > 0 for r in latest.values()),
            'cases': [latest.get(e['case'], {'case': e['case'], 'status': 'not-started'}) for e in entries],
            'attempts': history})
        print(f"DONE {row['phase']} {row['case']} mode={row.get('mode')} exit={row['exit']}", flush=True)
    run_deferred(entries, latest, history,
        lambda entry, row, previous: run_case(args, env, selection, entry, row, previous), persist)
    unresolved = [r for r in latest.values() if r['exit'] != 0]
    write_json(args.results / 'tracking-required.json', {
        'revision': revision, 'cases': unresolved,
        'action': 'Investigate and file/link a deduplicated issue for each unresolved task; no automatic issue publication.'})
    # Select exactly one final metric document per case. Attempt evidence is never overwritten.
    documents = []
    for entry in entries:
        path = latest.get(entry['case'], {}).get('metrics_path')
        if path:
            documents.append(json.loads(Path(path).read_text()))
    write_json(args.results / 'selected-metrics.json', documents)
    write_json(args.results / 'attempt-costs.json', attempt_costs(history))
    gate = subprocess.run(['node', '.ci/biomni-suite-report.mjs', str(plan_dir / 'plan.json'),
        str(args.results / 'selected-metrics.json'), str(args.results)], cwd=REPOSITORY, env=env)
    return 0 if len(latest) == 50 and all(r['exit'] == 0 for r in latest.values()) and gate.returncode == 0 else 1



if __name__ == '__main__':
    sys.exit(main())
