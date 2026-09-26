"""
db.py

Purpose:
    Owns all SQLite access for CrunchAI: the schema definition and every
    insert/select/update against the tasks, sessions, and plans tables.
    Nothing outside this file should write raw SQL.

Interacts with:
    - main.py      -> routes call these functions instead of touching
                      sqlite3 directly
    - models.py    -> rows returned here get shaped into PlanOut / TaskOut
                      before going back to the client
    - planner.py   -> does NOT import this directly; main.py is the glue
                      between planner output and db writes
"""

import sqlite3
from contextlib import contextmanager

DB_PATH = "crunchai.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    available_minutes INTEGER,
    urgency TEXT,
    summary TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    duration_minutes INTEGER,
    priority INTEGER,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (plan_id) REFERENCES plans (id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    actual_minutes INTEGER,
    outcome TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks (id)
);
"""


@contextmanager
def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_connection() as conn:
        conn.executescript(SCHEMA_SQL)


# ---- Plans ----

def create_plan(available_minutes: int, urgency: str, summary: str) -> int:
    """Insert a new plan row, return its id."""
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO plans (available_minutes, urgency, summary) VALUES (?, ?, ?)",
            (available_minutes, urgency, summary),
        )
        return cur.lastrowid


def get_latest_plan():
    """Return the most recently created plan row, or None."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM plans ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def get_plan(plan_id: int):
    """Return a specific plan row by id, or None."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM plans WHERE id = ?", (plan_id,)
        ).fetchone()
        return dict(row) if row else None


# ---- Tasks ----

def create_task(plan_id: int, title: str, duration_minutes: int, priority: int) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO tasks (plan_id, title, duration_minutes, priority)
               VALUES (?, ?, ?, ?)""",
            (plan_id, title, duration_minutes, priority),
        )
        return cur.lastrowid


def get_tasks_for_plan(plan_id: int):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE plan_id = ? ORDER BY priority ASC",
            (plan_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_task(task_id: int):
    """Return a single task row (dict) or None."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        return dict(row) if row else None


def get_pending_tasks_for_plan(plan_id: int, exclude_task_id: int | None = None):
    """All still-pending tasks for a plan, optionally excluding one (the one just updated)."""
    with get_connection() as conn:
        if exclude_task_id is not None:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE plan_id = ? AND status = 'pending' AND id != ? ORDER BY priority ASC",
                (plan_id, exclude_task_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE plan_id = ? AND status = 'pending' ORDER BY priority ASC",
                (plan_id,),
            ).fetchall()
        return [dict(r) for r in rows]


def update_task_status(task_id: int, status: str):
    with get_connection() as conn:
        conn.execute(
            "UPDATE tasks SET status = ? WHERE id = ?",
            (status, task_id),
        )


def mark_tasks_replaced(task_ids: list[int]):
    """Mark a batch of tasks as superseded by a replan, rather than deleting them."""
    if not task_ids:
        return
    with get_connection() as conn:
        placeholders = ",".join("?" for _ in task_ids)
        conn.execute(
            f"UPDATE tasks SET status = 'replaced' WHERE id IN ({placeholders})",
            task_ids,
        )


def update_plan_meta(plan_id: int, urgency: str, summary: str):
    with get_connection() as conn:
        conn.execute(
            "UPDATE plans SET urgency = ?, summary = ? WHERE id = ?",
            (urgency, summary, plan_id),
        )


# ---- Sessions ----

def create_session(task_id: int, actual_minutes: int, outcome: str):
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO sessions (task_id, completed_at, actual_minutes, outcome)
               VALUES (?, CURRENT_TIMESTAMP, ?, ?)""",
            (task_id, actual_minutes, outcome),
        )