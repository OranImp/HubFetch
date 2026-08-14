"""Shared fake-executable fixtures for read-only dependency diagnostics tests.

Each fixture writes a real Python script that stands in for the ``git``
executable, then runs it through the production bounded runner via
``sys.executable``. Behavior is driven by a JSON payload placed in the child
environment so the fake stays fully deterministic and cross-platform.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

from hubfetch.diagnostics.credential_helpers import CredentialCheckerOptions
from hubfetch.diagnostics.git import GitCheckerOptions

if TYPE_CHECKING:
    from collections.abc import Sequence

FAKE_GIT_SOURCE: Final = (
    "import json, os, sys, time\n"
    "\n"
    "\n"
    "def main() -> None:\n"
    '    with open(os.environ["FAKE_GIT_BEHAVIOR"], encoding="utf-8") as handle:\n'
    "        behavior = json.load(handle)\n"
    "    argv = sys.argv[1:]\n"
    '    record = behavior.get("record")\n'
    "    if record:\n"
    '        with open(record, "a", encoding="utf-8") as handle:\n'
    '            handle.write("\\x1f".join(argv) + "\\n")\n'
    '    delay = behavior.get("delay", 0.0)\n'
    "    if delay:\n"
    "        time.sleep(delay)\n"
    '    for handler in behavior.get("handlers", []):\n'
    '        match = handler["match"]\n'
    "        if argv[: len(match)] == match:\n"
    '            output = handler.get("out", "")\n'
    '            error = handler.get("err", "")\n'
    "            if output:\n"
    "                sys.stdout.write(output)\n"
    "            if error:\n"
    "                sys.stderr.write(error)\n"
    '            sys.exit(handler.get("exit", 0))\n'
    '    sys.exit(behavior.get("fallback_exit", 0))\n'
    "\n"
    "\n"
    'if __name__ == "__main__":\n'
    "    main()\n"
)
"""Real executable script written into a per-test temporary directory."""

FILTER_REGEXP: Final = r"^filter\.xet\."
HELPER_ARGV: Final = ("config", "--show-origin", "--get-all", "credential.helper")
FILTER_ARGV: Final = ("config", "--show-origin", "--get-regexp", FILTER_REGEXP)


@dataclass(frozen=True, slots=True)
class FakeHandler:
    """One scripted argv-prefix response for the fake git executable."""

    match: tuple[str, ...]
    output: str = ""
    error: str = ""
    exit_code: int = 0


GIT_VERSION_HANDLER: Final = FakeHandler(
    ("--version",), output="git version 2.54.0.windows.1\n"
)
XET_VERSION_HANDLER: Final = FakeHandler(("xet", "--version"), output="git-xet 0.2.1\n")
FILTER_EMPTY_HANDLER: Final = FakeHandler(FILTER_ARGV, exit_code=1)
FILTER_CONFIGURED_HANDLER: Final = FakeHandler(
    FILTER_ARGV, output="file:/etc/gitconfig\tfilter.xet.process git-xet filter\n"
)
HELPER_MANAGER_HANDLER: Final = FakeHandler(
    HELPER_ARGV, output="file:/etc/gitconfig\tmanager\n"
)
HELPER_STORE_HANDLER: Final = FakeHandler(
    HELPER_ARGV, output="file:/home/user/.gitconfig\tstore\n"
)
HELPER_NONE_HANDLER: Final = FakeHandler(HELPER_ARGV, exit_code=1)
HELPER_FAIL_HANDLER: Final = FakeHandler(
    HELPER_ARGV, error="fatal: bad config file\n", exit_code=128
)


def write_fake_git(
    tmp_path: Path,
    handlers: Sequence[FakeHandler],
    *,
    delay: float = 0.0,
    record: Path | None = None,
) -> tuple[Path, Path]:
    """Write the fake executable and its behavior payload, returning both paths."""
    script = tmp_path / "fake_git.py"
    _ = script.write_text(FAKE_GIT_SOURCE, encoding="utf-8")
    behavior: dict[str, object] = {
        "handlers": [
            {
                "match": list(handler.match),
                "out": handler.output,
                "err": handler.error,
                "exit": handler.exit_code,
            }
            for handler in handlers
        ],
        "delay": delay,
    }
    if record is not None:
        behavior["record"] = str(record)
    behavior_path = tmp_path / "fake_git_behavior.json"
    _ = behavior_path.write_text(json.dumps(behavior), encoding="utf-8")
    return script, behavior_path


def fake_environment(behavior_path: Path) -> dict[str, str]:
    """Return a child environment that locates the fake behavior payload."""
    return {**os.environ, "FAKE_GIT_BEHAVIOR": str(behavior_path)}


def make_git_options(
    script: Path,
    behavior_path: Path,
    *,
    timeout_seconds: float = 0.5,
) -> GitCheckerOptions:
    """Build read-only probe options that run the fake git executable."""
    return GitCheckerOptions(
        git_command=(sys.executable, str(script)),
        environment=fake_environment(behavior_path),
        timeout_seconds=timeout_seconds,
    )


def make_credential_options(
    script: Path,
    behavior_path: Path,
    *,
    gcm_candidates: Sequence[str] | None = None,
    gcm_probe_command: tuple[str, ...] | None = None,
    timeout_seconds: float = 0.5,
) -> CredentialCheckerOptions:
    """Build read-only probe options for the credential helper checker."""
    return CredentialCheckerOptions(
        git_command=(sys.executable, str(script)),
        environment=fake_environment(behavior_path),
        timeout_seconds=timeout_seconds,
        gcm_candidates=tuple(gcm_candidates) if gcm_candidates is not None else None,
        gcm_probe_command=gcm_probe_command,
    )


def read_recorded_argv(record: Path) -> tuple[tuple[str, ...], ...]:
    """Read argv lines recorded by the fake executable in invocation order."""
    entries: list[tuple[str, ...]] = []
    for line in record.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        entries.append(tuple(line.split("\x1f")))
    return tuple(entries)
