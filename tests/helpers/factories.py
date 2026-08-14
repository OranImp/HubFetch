"""Generic typed values for later task and event tests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

DEFAULT_TASK_NAME: Final = "task"
DEFAULT_STATE_NAME: Final = "queued"
DEFAULT_EVENT_NAME: Final = "created"


@dataclass(frozen=True, slots=True)
class TaskSpec:
    """Describe a task without imposing an application domain contract."""

    name: str
    parameters: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class TaskState:
    """Represent a named task state with a terminal marker."""

    name: str
    terminal: bool = False


@dataclass(frozen=True, slots=True)
class TaskEvent:
    """Represent an ordered event connecting a task and state value."""

    sequence: int
    name: str
    task: TaskSpec
    state: TaskState


def make_task_spec(
    name: str = DEFAULT_TASK_NAME,
    parameters: tuple[tuple[str, str], ...] = (),
) -> TaskSpec:
    """Create a reusable generic task specification."""
    return TaskSpec(name=name, parameters=parameters)


def make_task_state(
    name: str = DEFAULT_STATE_NAME, terminal: bool = False
) -> TaskState:
    """Create a reusable generic task state."""
    return TaskState(name=name, terminal=terminal)


def make_task_event(
    sequence: int = 1,
    task: TaskSpec | None = None,
    state: TaskState | None = None,
) -> TaskEvent:
    """Create a reusable generic task event."""
    return TaskEvent(
        sequence=sequence,
        name=DEFAULT_EVENT_NAME,
        task=task or make_task_spec(),
        state=state or make_task_state(),
    )
