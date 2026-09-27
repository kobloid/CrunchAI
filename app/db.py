"""
db.py

Purpose:
    Owns all SQLite access for CrunchAI: the schema definition and every
    insert/select/update against the tasks, sessions, plans, and topics
    tables. Nothing outside this file should write raw SQL.

Interacts with:
    - main.py      -> routes call these functions instead of touching
                      sqlite3 directly
    - models.py    -> rows returned here get shaped into PlanOut / TaskOut /
                      Topic before going back to the client
    - planner.py   -> does NOT import this directly; main.py is the glue
                      between planner output (including answer_question())
                      and db reads/writes
"""

import sqlite3
from contextlib import contextmanager

DB_PATH = "crunchai.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    available_minutes INTEGER,
    urgency TEXT,
    summary TEXT,
    FOREIGN KEY (used_id) References users (id)
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    duration_minutes INTEGER,
    priority INTEGER,
    deadline TEXT,
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

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    notes TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id)
);
"""


@contextmanager
def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
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

def create_task(plan_id: int, title: str, subject: str, difficulty: int, duration_minutes: int, priority: int, deadline: str | None = None) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO tasks (plan_id, title, subject, difficulty, duration_minutes, priority, deadline)
               VALUES (?, ?, ?, ?, ?)""",
            (plan_id, title, duration_minutes, priority, deadline),
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


# ---- Topics (subject + optional AI context notes) ----

def create_topic(name: str, notes: str | None) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO topics (name, notes) VALUES (?, ?)",
            (name, notes),
        )
        return cur.lastrowid


def get_all_topics():
    with get_connection() as conn:
        rows = conn.execute("SELECT * FROM topics ORDER BY name ASC").fetchall()
        return [dict(r) for r in rows]


def get_topic(topic_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        return dict(row) if row else None


def update_topic_notes(topic_id: int, notes: str | None):
    with get_connection() as conn:
        conn.execute("UPDATE topics SET notes = ? WHERE id = ?", (notes, topic_id))

# ---- Users ----

def create_user(username: str, password_hash: str, email: str | None = None) -> int:
    """Insert a new user, return its id. Caller must hash the password first."""
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            (username, email, password_hash),
        )
        return cur.lastrowid


def get_user(user_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def get_user_by_username(username: str):
    """Used at login time to fetch the stored password_hash for verification."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
        return dict(row) if row else None


# ---- Prompts (what the student asked CrunchAI during a /ask turn, and the answer) ----

def create_prompt(task_id: int, topic_id: int | None, question: str, answer: str) -> int:
    """Persist one /ask turn. Called from main.py right after planner.answer_question()."""
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO prompts (task_id, topic_id, question, answer)
               VALUES (?, ?, ?, ?)""",
            (task_id, topic_id, question, answer),
        )
        return cur.lastrowid


def get_prompts_for_task(task_id: int):
    """Full Q&A history for a task, oldest first — used to rehydrate the chat on load."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM prompts WHERE task_id = ? ORDER BY id ASC",
            (task_id,),
        ).fetchall()
        return [dict(r) for r in rows]