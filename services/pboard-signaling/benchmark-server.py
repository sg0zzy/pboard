"""Isolated Linux benchmark backend; stdin/stdout JSON control, no live config.

Invoked by benchmark.mjs locally or over SSH. The child receives only synthetic
public grants and an explicit environment, never production credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import resource
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def reply(value):
    print(json.dumps(value), flush=True)


def memory_available():
    return int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))


def stats(child):
    if child.poll() is not None:
        raise RuntimeError('isolated backend exited')
    if memory_available() < 256 * 1024:
        raise RuntimeError('host memory reserve reached; stopping benchmark')
    status = Path(f'/proc/{child.pid}/status').read_text().splitlines()
    fields = Path(f'/proc/{child.pid}/stat').read_text().split(') ')[1].split()
    return {'rssKiB': int(next(line.split()[1] for line in status if line.startswith('VmRSS:'))),
            'cpu': (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')}


def timeout(_signum, _frame):
    raise RuntimeError('benchmark exceeded five-minute runtime bound')


signal.signal(signal.SIGALRM, timeout)
signal.alarm(300)
child = None
try:
    request = json.loads(sys.stdin.readline(8 * 1024 * 1024))
    count, port = int(request['count']), int(request['port'])
    if not 2 <= count <= 2000 or not 1024 <= port <= 65535 or memory_available() < 512 * 1024:
        raise RuntimeError('invalid benchmark bounds or insufficient host memory')
    binary = Path(request['binary']).resolve(strict=True)
    # Refuse an occupied port instead of accidentally measuring a live service.
    with socket.socket() as check:
        check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        check.bind(('127.0.0.1', port))
    with tempfile.TemporaryDirectory(prefix='pboard-relay-benchmark-') as work:
        grants = Path(work) / 'grants.json'
        grants.write_text(json.dumps(request['grants']))
        os.chmod(grants, 0o600)
        account = pwd.getpwnam('pboard-signaling') if os.getuid() == 0 else None
        if account:
            os.chown(work, account.pw_uid, account.pw_gid)
            os.chown(grants, account.pw_uid, account.pw_gid)

        def bounded_child():
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_NOFILE, (4096,) * 2)

        env = {'PATH': '/usr/bin:/bin', 'RUST_LOG': 'warn', 'TOKIO_WORKER_THREADS': '2',
               'PBOARD_SIGNALING_BIND': f'127.0.0.1:{port}', 'PBOARD_SIGNALING_GRANTS': str(grants),
               'PBOARD_SIGNALING_MAX_CONNECTIONS': str(count), 'PBOARD_SIGNALING_MAX_PEERS_PER_ROOM': '32',
               'PBOARD_SIGNALING_HTTP_PER_SECOND': '128', 'PBOARD_SIGNALING_AUTH_PER_SECOND': '128',
               'PBOARD_SIGNALING_GLOBAL_MESSAGES_PER_SECOND': '1024'}
        identity = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []} if account else {}
        child = subprocess.Popen([str(binary)], env=env, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, preexec_fn=bounded_child, **identity)
        for attempt in range(100):
            if child.poll() is not None:
                raise RuntimeError('isolated backend failed startup')
            try:
                if urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=1).status == 200:
                    break
            except OSError:
                pass
            time.sleep(.05)
        else:
            raise RuntimeError('isolated backend startup timed out')
        reply({'ready': True, 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()})
        for line in sys.stdin:
            command = json.loads(line)
            if command == 'stop':
                break
            if command != 'stats':
                raise RuntimeError('unknown benchmark control operation')
            reply(stats(child))
        child.terminate()
        child.wait(timeout=10)
except Exception:
    # No exception messages/tracebacks containing configuration or payloads.
    reply({'error': 'isolated benchmark failed or resource bound reached'})
    sys.exit(1)
finally:
    if child and child.poll() is None:
        child.kill()
        child.wait()
