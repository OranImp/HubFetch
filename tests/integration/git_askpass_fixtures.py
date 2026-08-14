"""Fixtures and helpers for the real-system Git AskPass integration tests.

A local HTTP server serves a bare repository over dumb HTTP behind Basic
authentication. These helpers build the bare repository, the auth server, the
real Windows Credential Manager entry, the ASCII ``GIT_ASKPASS`` launcher, and
the git child environment -- always without embedding a machine path or the
token. The tests in :mod:`tests.integration.test_git_askpass` drive the actual
AskPass entry point through this scaffolding and scan every byte it produced
for the sentinel.
"""

from __future__ import annotations

import base64
import http.server
import os
import shutil
import stat
import subprocess
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Final, override

from keyring.backends.Windows import WinVaultKeyring

from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.git.auth_policy import (
    GitAuthPolicy,
    apply_git_auth_environment,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Generator, Mapping

    from hubfetch.credentials.models import CredentialAlias

_USERNAME: Final = "hf_user"

LAUNCHER_SOURCE: Final = (
    "@echo off\r\n"
    'echo %* >> "%ASKPASS_LOG%"\r\n'
    '"%PYTHON%" -m hubfetch.askpass.main %*\r\n'
)
"""ASCII-only launcher that forwards Git's prompt to the real entry point.

The Python executable and import path travel through environment variables so
the file itself never embeds a machine path, and the file is pure ASCII to
avoid cmd.exe codepage mangling of non-ASCII paths. The prompt is echoed to
the ``%ASKPASS_LOG%`` file (never to stderr) so tests can observe which
prompt classes Git actually produced.
"""


class GitToolMissingError(RuntimeError):
    """Indicate that the system Git executable is unavailable."""

    def __init__(self) -> None:
        super().__init__("system Git executable was not found")


def system_git() -> str:
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


def remove_force(root: Path) -> None:
    """Remove a Windows Git tree, clearing read-only attributes on failure."""
    shutil.rmtree(root, onexc=_clear_readonly_and_retry)


def bare_repository(*, parent: Path) -> Path:
    """Create a local bare repository with several objects and refs info."""
    git = system_git()
    work = parent / "work"
    work.mkdir()
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
    bare = parent / "repository.git"
    _run_git(git, ["clone", "--bare", str(work), str(bare)])
    _run_git(git, ["--git-dir", str(bare), "update-server-info"])
    return bare


class BareAuthServer(http.server.ThreadingHTTPServer):
    """Carry the bare-repo root, expected auth, and observed headers."""

    bare_dir: Path = Path()
    expected_auth: str = ""

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[http.server.BaseHTTPRequestHandler],
    ) -> None:
        """Create one per-test server with an empty observed-header list."""
        super().__init__(server_address, handler_class)
        self.observed_auth: list[str] = []


class BareAuthHandler(http.server.BaseHTTPRequestHandler):
    """Serve a bare repository only to the exact expected Basic credentials."""

    @property
    def _server_state(self) -> BareAuthServer:
        server = self.server
        if not isinstance(server, BareAuthServer):
            message = "unexpected server type"
            raise TypeError(message)
        return server

    @override
    def log_message(self, format: str, *args: object) -> None:
        """Keep fixture access deterministic and quiet."""

    def do_GET(self) -> None:
        """Challenge with Basic auth until the exact credentials arrive."""
        server = self._server_state
        received = self.headers.get("Authorization", "")
        if received:
            server.observed_auth.append(received)
        if received != f"Basic {server.expected_auth}":
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="hubfetch-test"')
            self.end_headers()
            return
        rel = self.path.split("?")[0].lstrip("/")
        _, _, rel = rel.partition("/")
        target = (server.bare_dir / rel).resolve()
        if (
            not str(target).startswith(str(server.bare_dir.resolve()))
            or not target.is_file()
        ):
            self.send_response(404)
            self.end_headers()
            return
        payload = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        _ = self.wfile.write(payload)


class AuthServerLifecycle:
    """Own one ephemeral Basic-auth git server and its observed headers."""

    __slots__: Final = ("_server", "_thread", "observed_auth")
    _server: BareAuthServer
    _thread: threading.Thread
    observed_auth: list[str]

    def __init__(self, *, bare: Path, expected_auth: str) -> None:
        self._server = BareAuthServer(("127.0.0.1", 0), BareAuthHandler)
        self._server.bare_dir = bare
        self._server.expected_auth = expected_auth
        self._server.observed_auth = []
        self.observed_auth = self._server.observed_auth
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        """Return the clone URL for this server."""
        return f"http://127.0.0.1:{self._server.server_port}/repository.git"

    def close(self) -> None:
        """Stop the server thread within a bound."""
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(2.0)


@contextmanager
def auth_git_server(
    *, bare: Path, secret: str
) -> Generator[AuthServerLifecycle, None, None]:
    """Create one Basic-auth git server with guaranteed shutdown."""
    expected = base64.b64encode(f"{_USERNAME}:{secret}".encode()).decode("ascii")
    server = AuthServerLifecycle(bare=bare, expected_auth=expected)
    try:
        yield server
    finally:
        server.close()


@contextmanager
def real_credential(secret: str) -> Generator[CredentialAlias, None, None]:
    """Create one real Windows Credential Manager entry and delete it after."""
    store = WindowsCredentialManagerStore(backend=WinVaultKeyring())
    alias = store.create(token=secret)
    try:
        yield alias
    finally:
        store.delete(alias)


def launcher(*, root: Path) -> Path:
    """Write the ASCII launcher used as ``GIT_ASKPASS``."""
    launcher = root / "askpass_launcher.cmd"
    _ = launcher.write_text(LAUNCHER_SOURCE, encoding="ascii")
    return launcher


def git_environment(
    parent: Mapping[str, str],
    *,
    launcher: Path,
    log: Path,
    alias: CredentialAlias | None,
    isolate_helpers: bool = False,
) -> dict[str, str]:
    """Build the git child environment with the real helper and locator."""
    environment = dict(parent)
    environment["PYTHON"] = sys.executable
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[2] / "src")
    environment["ASKPASS_LOG"] = str(log)
    if isolate_helpers:
        environment = isolate_credential_helpers(environment)
    policy = (
        GitAuthPolicy.app_token(alias) if alias is not None else GitAuthPolicy.system()
    )
    return apply_git_auth_environment(environment, policy, askpass_executable=launcher)


def isolate_credential_helpers(environment: dict[str, str]) -> dict[str, str]:
    """Neutralize machine/system credential helpers for one git child.

    The machine's system Git config installs Git Credential Manager as the
    global ``credential.helper``; a challenge would spawn it and hang on its
    interactive prompt. Default-policy tests must prove Git fails closed
    without any HubFetch wiring, so the fixture isolates the child from
    system/global Git config while leaving every HubFetch variable untouched.
    """
    result = {
        name: value
        for name, value in environment.items()
        if not name.casefold().startswith("git_config")
    }
    result["GIT_CONFIG_NOSYSTEM"] = "1"
    result["GIT_CONFIG_GLOBAL"] = os.devnull
    return result


def recursive_bytes(root: Path) -> bytes:
    """Return every byte under ``root`` for sentinel scanning."""
    chunks = bytearray()
    for path in root.rglob("*"):
        if path.is_file():
            chunks.extend(path.read_bytes())
    return bytes(chunks)
