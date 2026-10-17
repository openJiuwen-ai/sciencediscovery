#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Serial public-50 driver: finish the first pass before one deferred retry.

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


def schedule(entries, latest):
    first = [e for e in entries if e['case'] not in latest]
    retry = [e for e in entries if e['case'] in latest and latest[e['case']]['exit'] != 0
             and latest[e['case']].get('phase') != 'retry']
    return first, retry


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
    for phase in ('first-pass', 'retry'):
        first, retries = schedule(entries, latest)
        for e in first if phase == 'first-pass' else retries:
            case = e['case']
            check_resources(args.runtime, args.min_free_gib * 1024**3, args.min_free_inodes)
            check_resources(args.results, 5 * 1024**3, 10000)
            attempt = args.results / 'cases' / case / phase
            runtime = args.runtime / case / phase
            # Never overwrite partial evidence left by an interrupted driver.
            if attempt.exists():
                raise RuntimeError(f'Interrupted evidence retained at {attempt}; reconcile before resume')
            attempt.mkdir(parents=True)
            runtime.mkdir(parents=True)
            case_env = dict(env, CI_RESULTS_DIR=str(attempt), CI_RUNTIME_DIR=str(runtime),
                            JIUWENSWARM_HOME=str(runtime / 'swarm'), BIOMNI_DATA_ROOT=str(args.data_root),
                            BIOMNI_PYTHON=args.python, BIOMNI_JUDGE_MAX_RETRIES='0')
            print(f'START {phase} {case}', flush=True)
            started = time.time()
            if phase == 'retry':
                previous = args.results / 'cases' / case / 'first-pass'
                metrics_files = list(previous.glob('**/benchmark-metrics.json'))
                if metrics_files:
                    evidence = metrics_files[0].parent
                    metadata = json.loads(metrics_files[0].read_text())
                    if metadata.get('error') == 'UNREPORTED_JUDGE_TOKENS':
                        code = execute([args.python, str(Path(__file__).with_name('rescore.py')),
                                        '--evidence', str(evidence), '--rubric', str(args.data_root / case / 'tests/rubric.txt'),
                                        '--output', str(attempt / 'evaluation-only')], attempt / 'rescore.log',
                                       case_env, runtime, previous, 4000, 4000)
                        row = {'case': case, 'phase': phase, 'exit': 1, 'evaluation_exit': code,
                               'mode': 'evaluation-only', 'started': started, 'finished': time.time(),
                               'reason': 'Original full-run accounting retained; see evaluation-recovery.json'}
                        with status.open('a') as stream:
                            stream.write(json.dumps(row) + '\n')
                        latest[case] = row
                        print(f'DONE deferred evaluation {case} exit={code}; original E2E verdict retained', flush=True)
                        continue
            prep = execute([args.python, str(Path(__file__).parent / 'prepare.py'), 'download',
                            '--root', str(args.data_root), '--case', case], attempt / 'download.log',
                           case_env, runtime, attempt, 1800, args.idle_seconds)
            code = 125
            if prep == 0:
                # realShards orders research identities in this dedicated 50-case plan.
                code = execute(['node', 'test/support/tagged/shared.mjs', 'run', *selection,
                                '--shard', e['shard']], attempt / 'driver.log', case_env,
                               runtime, attempt, 15000, args.idle_seconds)
            row = {'case': case, 'phase': phase, 'exit': code, 'preparation_exit': prep,
                   'started': started, 'finished': time.time()}
            if code:
                log = attempt / ('download.log' if prep else 'driver.log')
                row['reason'] = next((s.strip()[:300] for s in log.read_text(errors='replace').splitlines()
                                      if any(x in s for x in ('Error:', 'BLOCKED:', 'TIMEOUT:'))), 'See private case log')
            with status.open('a') as stream:
                stream.write(json.dumps(row) + '\n')
            latest[case] = row
            print(f'DONE {phase} {case} exit={code}', flush=True)
            try:
                reclaim(runtime, args.runtime)
            except (OSError, RuntimeError, ValueError) as error:
                print(f'Cleanup deferred for {case}: {type(error).__name__}', flush=True)
        print(f'{phase.upper()}_COMPLETE', flush=True)
    write_json(args.results / 'summary.json', {'revision': revision, 'expected': 50,
               'passed': sum(r['exit'] == 0 for r in latest.values()), 'cases': list(latest.values())})
    return 0 if len(latest) == 50 and all(r['exit'] == 0 for r in latest.values()) else 1


if __name__ == '__main__':
    sys.exit(main())
