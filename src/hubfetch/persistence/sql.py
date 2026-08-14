"""Shared SQL statements for the transactional task store.

Every statement is a plain literal executed with bound parameters only;
nothing is ever interpolated into these strings at runtime.
"""

from __future__ import annotations

from typing import Final

SELECT_TASK_SQL: Final = "SELECT task_id, spec, state, attempt_id, position, created_at, updated_at FROM tasks"  # noqa: E501
SELECT_TASK_WHERE_SQL: Final = SELECT_TASK_SQL + " WHERE task_id = ?"
SELECT_TASK_ORDER_SQL: Final = SELECT_TASK_SQL + " ORDER BY position, task_id"
INSERT_TASK_SQL: Final = "INSERT INTO tasks (task_id, spec, state, attempt_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"  # noqa: E501
INSERT_TRANSITION_SQL: Final = "INSERT INTO task_transitions (task_id, attempt_id, from_state, to_state, occurred_at, event_kind) VALUES (?, ?, ?, ?, ?, ?)"  # noqa: E501
UPDATE_TASK_STATE_SQL: Final = (
    "UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ? AND state = ?"
)
INSERT_EVENT_SQL: Final = "INSERT INTO task_events (event_id, task_id, attempt_id, occurred_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"  # noqa: E501
SELECT_EVENT_PAYLOADS_SQL: Final = (
    "SELECT payload FROM task_events WHERE task_id = ? ORDER BY occurred_at, event_id"
)
SELECT_TRANSITIONS_SQL: Final = "SELECT task_id, attempt_id, from_state, to_state, occurred_at, event_kind FROM task_transitions WHERE task_id = ? ORDER BY transition_id"  # noqa: E501
SELECT_ACTIVE_TASKS_SQL: Final = "SELECT task_id, state FROM tasks WHERE state IN ('running', 'cancelling') ORDER BY position"  # noqa: E501
SELECT_ATTEMPT_SQL: Final = "SELECT attempt_id FROM tasks WHERE task_id = ?"
SELECT_MAX_POSITION_SQL: Final = "SELECT max(position) FROM tasks"
COUNT_EVENTS_SQL: Final = "SELECT count(*) FROM task_events WHERE attempt_id = ?"
