"""One window research process per user, one native compute thread per process."""

import fcntl
from functools import wraps
import os
from pathlib import Path
import tempfile
import gc
import ctypes
import sys
import subprocess
import signal
import time

from threadpoolctl import threadpool_limits


def bounded_command(command, *, max_bytes=2 * 1024**3, checkpoint_restart=False):
    """External monitor remains responsive while native training holds the GIL."""
    environment = {
        **os.environ,
        "QUANT_BOUNDED_PROCESS": "1",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "VECLIB_MAXIMUM_THREADS": "1",
        "QUANT_CHECKPOINT_RESTART": (
            "1"
            if checkpoint_restart
            or (len(command) > 1 and Path(command[1]).name == "main.py")
            else "0"
        ),
    }
    child = subprocess.Popen(command, env=environment, start_new_session=True)
    try:
        while child.poll() is None:
            listing = subprocess.check_output(
                ["ps", "-axo", "pid=,ppid=,rss="], text=True
            )
            processes = [
                tuple(map(int, line.split()))
                for line in listing.splitlines()
                if line.strip()
            ]
            members = {child.pid}
            while True:
                descendants = members | {
                    pid for pid, parent, _ in processes if parent in members
                }
                if descendants == members:
                    break
                members = descendants
            rss = sum(memory for pid, _, memory in processes if pid in members) * 1024
            if rss > max_bytes:
                print(
                    "Research stopped: process-tree RSS exceeded 2 GiB; checkpoints preserved",
                    file=sys.stderr,
                    flush=True,
                )
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                return 75
            time.sleep(0.5)
        return child.returncode
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)


def check_resource_budget(max_bytes=2 * 1024**3):
    current = (
        int(
            subprocess.check_output(
                ["ps", "-o", "rss=", "-p", str(os.getpid())], text=True
            ).strip()
        )
        * 1024
    )
    if current > max_bytes:
        raise MemoryError(
            "Issuance research exceeded 2 GiB; retain checkpoints, do not shrink samples"
        )


def release_training_memory():
    """Return unused native allocations without discarding any live samples."""
    gc.collect()
    library = ctypes.CDLL(None)
    if sys.platform == "darwin":
        function = library.malloc_zone_pressure_relief
        function.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        function.restype = ctypes.c_size_t
        function(None, 0)
    elif hasattr(library, "malloc_trim"):
        library.malloc_trim(0)


_completed_fits = 0


def checkpoint_training_process():
    """Replace this serial CLI process after durable fits to reclaim native arenas."""
    global _completed_fits
    _completed_fits += 1
    if _completed_fits >= 4 and os.environ.get("QUANT_CHECKPOINT_RESTART") == "1":
        print(
            "[coupon] Reclaiming native memory; resuming verified monthly checkpoints",
            flush=True,
        )
        os.execve(sys.executable, [sys.executable, *sys.argv], dict(os.environ))


def bounded_window_research(function):
    @wraps(function)
    def run(*args, **kwargs):
        path = (
            Path(tempfile.gettempdir())
            / f"eastmoney-window-research-{os.getuid()}.lock"
        )
        # Advisory OS lock is released even when the process is terminated.
        with path.open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError(
                    "Another window backtest is running; run horizons sequentially"
                ) from error
            try:
                if os.getpriority(os.PRIO_PROCESS, 0) < 10:
                    os.nice(10 - os.getpriority(os.PRIO_PROCESS, 0))
                check_resource_budget()
                with threadpool_limits(limits=1):
                    return function(*args, **kwargs)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    return run
