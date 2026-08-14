"""Public Hub-compatible wire fixture API for wire-level planning tests.

This module owns the fixture server lifecycle; the HTTP routing lives in
:mod:`tests.hub.fixture_handler` and the JSON/error payload contracts live in
:mod:`tests.hub.fixture_payloads`. Together they mimic the endpoints the
pinned ``huggingface_hub`` 1.27.0 library calls during dry-run planning, so
tests exercise the real adapter against the real library with no external
network.
"""

from __future__ import annotations

from contextlib import contextmanager
from threading import Event, Thread
from typing import TYPE_CHECKING, Final

from .fixture_handler import FixtureConfig, FixtureServer, HubFixtureHandler
from .fixture_payloads import DEFAULT_COMMIT, FixtureError, RepoType

if TYPE_CHECKING:
    from collections.abc import Generator, Sequence

__all__ = ["DEFAULT_COMMIT", "HubFixtureServer", "hub_fixture"]


class HubFixtureServer:
    """Own one ephemeral Hub-compatible fixture server thread."""

    __slots__: Final = ("_server", "_thread")

    _server: FixtureServer
    _thread: Thread

    # A fixture is a config bundle of every wire behavior the planning tests
    # need to control independently.
    def __init__(  # noqa: PLR0913
        self,
        *,
        repo_id: str = "org/repo",
        repo_type: RepoType = "model",
        files: Sequence[tuple[str, int]] = (),
        commit: str = DEFAULT_COMMIT,
        revisions: Sequence[str] = ("main",),
        error: FixtureError = "none",
        expect_token: str | None = None,
        forbid_token: bool = False,
        gated: bool = False,
        private: bool = False,
    ) -> None:
        config = FixtureConfig()
        config.repo_id = repo_id
        config.repo_type = repo_type
        config.files = tuple(files)
        config.commit = commit
        config.revisions = tuple(revisions)
        config.error = error
        config.expect_token = expect_token
        config.forbid_token = forbid_token
        config.gated = gated
        config.private = private
        self._server = FixtureServer(("127.0.0.1", 0), HubFixtureHandler)
        self._server.config = config
        started = Event()
        self._thread = Thread(target=self._serve, args=(started,), daemon=True)
        self._thread.start()
        if not started.wait(5.0):
            self._server.server_close()
            message = "hub fixture failed to start"
            raise RuntimeError(message)

    @property
    def port(self) -> int:
        """Return the operating-system-assigned ephemeral port."""
        return self._server.server_port

    @property
    def endpoint(self) -> str:
        """Return the fixture endpoint URL for the pinned adapter."""
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        """Stop the server thread within a bound."""
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(2.0)

    def _serve(self, started: Event) -> None:
        started.set()
        self._server.serve_forever(poll_interval=0.02)


@contextmanager
def hub_fixture(  # noqa: PLR0913 - mirrors the fixture server's config bundle
    *,
    repo_id: str = "org/repo",
    repo_type: RepoType = "model",
    files: Sequence[tuple[str, int]] = (),
    commit: str = DEFAULT_COMMIT,
    revisions: Sequence[str] = ("main",),
    error: FixtureError = "none",
    expect_token: str | None = None,
    forbid_token: bool = False,
    gated: bool = False,
    private: bool = False,
) -> Generator[HubFixtureServer, None, None]:
    """Create a Hub-compatible fixture with guaranteed shutdown."""
    server = HubFixtureServer(
        repo_id=repo_id,
        repo_type=repo_type,
        files=files,
        commit=commit,
        revisions=revisions,
        error=error,
        expect_token=expect_token,
        forbid_token=forbid_token,
        gated=gated,
        private=private,
    )
    try:
        yield server
    finally:
        server.close()
