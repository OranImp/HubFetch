"""Shared pytest fixtures and platform markers."""

from __future__ import annotations

import platform
from typing import Final

import pytest

HF_TEST_SECRET: Final = "hf_test_secret_123"  # noqa: S105


@pytest.fixture
def hf_test_secret() -> str:
    """Return the sentinel used by later secret-leak tests."""
    return HF_TEST_SECRET


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Skip tests marked for Windows when executed elsewhere."""
    if (
        item.get_closest_marker("windows") is not None
        and platform.system() != "Windows"
    ):
        pytest.skip("requires win32")


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Let the intentionally empty bootstrap suite complete successfully."""
    if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:
        session.exitstatus = pytest.ExitCode.OK
