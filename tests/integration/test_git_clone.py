"""Real-system integration tests for contained Git working-copy clones.

One Windows-only test clones a local bare repository with several objects
through the real system Git and asserts the materialized working copy. A second
Windows-only test proves the descendant Git process inherits the worker's Job
Object: a helper process is assigned to a kill-on-close job and only then
releases the clone, so the spawned git child must land in the same job.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.git.cloner import GitCloner
from hubfetch.platform.windows.job_object import JobObject, open_process
from tests.fixtures.process_tree import fixture_interpreter
from tests.git.conftest import VERSION_HANDLER, FakeGitHandler, write_fake_git
from tests.helpers.git_repo import GitToolMissingError

if TYPE_CHECKING:
    from collections.abc import Callable, Generator

_POLL_INTERVAL_SECONDS: Final = 0.02

_CONTAINMENT_HELPER: Final = (
    "import os, sys, time\n"
    "from pathlib import Path\n"
    "from hubfetch.git.cloner import GitCloner\n"
    "\n"
    "def main() -> None:\n"
    "    git_command = (sys.executable, sys.argv[1])\n"
    "    behavior = sys.argv[2]\n"
    "    destination = Path(sys.argv[3])\n"
    "    ready = Path(sys.argv[4])\n"
    "    go = Path(sys.argv[5])\n"
    '    ready.write_text("ok", encoding="utf-8")\n'
    "    deadline = time.monotonic() + 20.0\n"
    "    while not go.exists():\n"
    "        if time.monotonic() > deadline:\n"
    "            sys.exit(3)\n"
    "        time.sleep(0.02)\n"
    "    cloner = GitCloner(\n"
    '        git_command=git_command, environment={"FAKE_GIT_BEHAVIOR": behavior}\n'
    "    )\n"
    '    cloner.clone("https://example.invalid/repo", destination)\n'
    '    print("CLONE_DONE", flush=True)\n'
    "\n"
    "\n"
    'if __name__ == "__main__":\n'
    "    main()\n"
)
"""Helper that waits for job assignment, then clones with a slow fake git."""


def _system_git() -> str:
    """Return the system Git executable, raising when it is unavailable."""
    executable = shutil.which("git")
    if executable is None:
        raise GitToolMissingError
    return executable


def _run_git(git: str, argv: list[str]) -> None:
    """Run one system Git fixture command, failing loudly on error."""
    _ = subprocess.run(  # noqa: S603
        [git, *argv], check=True, capture_output=True, text=True
    )


def _clear_readonly_and_retry(
    function: Callable[..., object], path: str, excinfo: object
) -> None:
    """Clear the read-only attribute Git sets on bare-repo files, then retry."""
    _ = excinfo
    Path(path).chmod(stat.S_IWRITE)
    _ = function(path)


def _remove_force(root: Path) -> None:
    """Remove a Windows Git tree, clearing read-only attributes on failure."""
    shutil.rmtree(root, onexc=_clear_readonly_and_retry)


@contextmanager
def _bare_repository_with_objects(*, parent: Path) -> Generator[Path, None, None]:
    """Create and remove a local bare repository holding several objects."""
    git = _system_git()
    root = Path(tempfile.mkdtemp(prefix="git-clone-", dir=str(parent)))
    work = root / "work"
    work.mkdir()
    try:
        _run_git(git, ["init", "--initial-branch=main", str(work)])
        _ = (work / "README.md").write_text("# fixture repository\n", encoding="utf-8")
        _ = (work / "data.bin").write_bytes(b"\x00" * 64)
        _run_git(git, ["-C", str(work), "add", "."])
        _run_git(
            git,
            [
                "-C",
                str(work),
                "-c",
                "user.name=HubFetch Test",
                "-c",
                "user.email=test@hubfetch.invalid",
                "commit",
                "-m",
                "initial",
            ],
        )
        bare = root / "repository.git"
        _run_git(git, ["clone", "--bare", str(work), str(bare)])
        yield bare
    finally:
        _remove_force(root)


def _wait_for_file(path: Path, *, timeout_seconds: float) -> None:
    """Observe a file appear within a bounded deadline."""
    deadline = time.monotonic() + timeout_seconds
    while not path.exists():
        if time.monotonic() > deadline:
            pytest.fail(f"timed out waiting for {path.name}")
        time.sleep(_POLL_INTERVAL_SECONDS)


def _wait_for_job_members(
    job: JobObject, *, minimum: int, timeout_seconds: float
) -> tuple[int, ...]:
    """Observe a job reach a minimum member count within a bounded deadline."""
    deadline = time.monotonic() + timeout_seconds
    while True:
        member_pids = job.active_process_ids()
        if len(member_pids) >= minimum:
            return member_pids
        if time.monotonic() > deadline:
            pytest.fail(f"job never reached {minimum} members: {member_pids}")
        time.sleep(_POLL_INTERVAL_SECONDS)


@pytest.mark.windows
@pytest.mark.integration
def test_real_git_clone_materializes_working_copy(tmp_path: Path) -> None:
    """Given a local bare repository, system Git produces the working copy."""
    with _bare_repository_with_objects(parent=tmp_path) as bare:
        destination = tmp_path / "clone"
        cloner = GitCloner()

        outcome = cloner.clone(str(bare), destination)

        assert (destination / "README.md").is_file()
        assert (destination / "data.bin").is_file()
        assert (destination / ".git").is_dir()
        assert outcome.destination == destination


@pytest.mark.windows
def test_clone_descendant_remains_in_inherited_job(tmp_path: Path) -> None:
    """Given a clone after job assignment, the git child joins the same job."""
    helper_path = tmp_path / "clone_helper.py"
    _ = helper_path.write_text(_CONTAINMENT_HELPER, encoding="utf-8")
    fake_script, behavior_path = write_fake_git(
        tmp_path,
        [
            VERSION_HANDLER,
            FakeGitHandler(
                match=("clone",),
                stderr=tuple((f"progress line {index}\n", 0.5) for index in range(6)),
            ),
        ],
    )
    destination = tmp_path / "dest"
    ready = tmp_path / "ready"
    go = tmp_path / "go"
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(entry for entry in sys.path if entry)
    helper = subprocess.Popen(  # noqa: S603
        [
            fixture_interpreter(),
            str(helper_path),
            str(fake_script),
            str(behavior_path),
            str(destination),
            str(ready),
            str(go),
        ],
        cwd=str(tmp_path),
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    job = JobObject()
    try:
        _wait_for_file(ready, timeout_seconds=15.0)
        with open_process(helper.pid) as process:
            job.assign(process)
        _ = go.write_text("go", encoding="utf-8")
        member_pids = _wait_for_job_members(job, minimum=2, timeout_seconds=15.0)

        assert helper.pid in member_pids
        assert any(pid != helper.pid for pid in member_pids)
    finally:
        job.close()
        try:
            _ = helper.wait(timeout=20)
        except subprocess.TimeoutExpired:
            helper.kill()
