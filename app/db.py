"""
db.py

Purpose:
    Owns all SQLite access for CrunchAI: the schema definition and every
    insert/select/update against the users, plans, tasks, sessions, topics,
    and prompts tables. Nothing outside this file should write raw SQL.

Interacts with:
    - main.py      -> routes call these functions instead of touching
                      sqlite3 directly, including persisting each /ask
                      turn via create_prompt() after planner.answer_question()
                      returns
    - models.py    -> rows returned here get shaped into PlanOut / TaskOut /
                      Topic / UserOut / PromptOut before going back to the
                      client
    - planner.py   -> does NOT import this directly; main.py is the glue
                      between planner output (including answer_question())
                      and db reads/writes

Notes on auth:
    This file never hashes or checks passwords; it only stores and reads a
    `password_hash` string (main.py hashes and verifies). Login sessions
    live in auth_sessions, keyed by a SHA-256 of the cookie token so a
    leaked database can't be replayed as live sessions. user_id is nullable
    on plans/topics: NULL means a guest created it, and claim_plan() /
    claim_topics() attach guest work to an account at sign-up or log-in.
"""

import sqlite3
from contextlib import contextmanager

DB_PATH = "crunchai.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    available_minutes INTEGER,
    urgency TEXT,
    summary TEXT,
    FOREIGN KEY (user_id) REFERENCES users (id)
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

-- One row per /ask turn: what the student prompted CrunchAI with, for a
-- given task (and optionally a topic), and what came back. This is the
-- persisted study-session history that request.history currently only
-- carries client-side.
CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    topic_id INTEGER,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks (id),
    FOREIGN KEY (topic_id) REFERENCES topics (id)
);

-- Logged-in browser sessions (not study sessions; those are `sessions`).
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
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


# Columns added after the first release. CREATE TABLE IF NOT EXISTS never
# alters an existing table, so older crunchai.db files need these added.
MIGRATIONS = {
    "plans": {"user_id": "INTEGER REFERENCES users (id)"},
    "topics": {"user_id": "INTEGER REFERENCES users (id)"},
    "tasks": {"deadline": "TEXT"},
    "sessions": {
        "commitment": "TEXT",
        "away_minutes": "INTEGER",
        "quiz_correct": "INTEGER",
        "quiz_total": "INTEGER",
    },
}


def init_db():
    with get_connection() as conn:
        conn.executescript(SCHEMA_SQL)
        for table, columns in MIGRATIONS.items():
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, definition in columns.items():
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


# ---- Plans ----

def create_plan(available_minutes: int, urgency: str, summary: str, user_id: int | None = None) -> int:
    """Insert a new plan row, return its id. user_id is optional until main.py has auth."""
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO plans (user_id, available_minutes, urgency, summary) VALUES (?, ?, ?, ?)",
            (user_id, available_minutes, urgency, summary),
        )
        return cur.lastrowid


def get_latest_plan(user_id: int | None = None):
    """Return the most recently created plan row, optionally scoped to a user, or None."""
    with get_connection() as conn:
        if user_id is not None:
            row = conn.execute(
                "SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1",
                (user_id,),
            ).fetchone()
        else:
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

def create_task(plan_id: int, title: str, duration_minutes: int, priority: int, deadline: str | None = None) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO tasks (plan_id, title, duration_minutes, priority, deadline)
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

def create_session(
    task_id: int,
    actual_minutes: int,
    outcome: str,
    commitment: str | None = None,
    away_minutes: int | None = None,
    quiz_correct: int | None = None,
    quiz_total: int | None = None,
):
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO sessions (task_id, completed_at, actual_minutes, outcome,
                                     commitment, away_minutes, quiz_correct, quiz_total)
               VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)""",
            (task_id, actual_minutes, outcome, commitment, away_minutes, quiz_correct, quiz_total),
        )


def get_sessions_for_user(user_id: int, limit: int = 200):
    """A user's logged focus blocks, newest first, with the task and plan they belong to."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT s.id, s.completed_at, s.actual_minutes, s.outcome, s.commitment,
                      s.away_minutes, s.quiz_correct, s.quiz_total,
                      t.title AS task_title, p.id AS plan_id
               FROM sessions s
               JOIN tasks t ON t.id = s.task_id
               JOIN plans p ON p.id = t.plan_id
               WHERE p.user_id = ?
               ORDER BY s.id DESC
               LIMIT ?""",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ---- Topics (subject + optional AI context notes) ----

def create_topic(name: str, notes: str | None, user_id: int | None = None) -> int:
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO topics (user_id, name, notes) VALUES (?, ?, ?)",
            (user_id, name, notes),
        )
        return cur.lastrowid


def get_all_topics(user_id: int | None = None):
    with get_connection() as conn:
        if user_id is not None:
            rows = conn.execute(
                "SELECT * FROM topics WHERE user_id = ? ORDER BY name ASC", (user_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM topics ORDER BY name ASC").fetchall()
        return [dict(r) for r in rows]


def get_guest_topics(topic_ids: list[int]):
    """Guest-owned topics (user_id IS NULL) among the ids a guest's browser remembers."""
    if not topic_ids:
        return []
    with get_connection() as conn:
        placeholders = ",".join("?" for _ in topic_ids)
        rows = conn.execute(
            f"SELECT * FROM topics WHERE user_id IS NULL AND id IN ({placeholders}) ORDER BY name ASC",
            topic_ids,
        ).fetchall()
        return [dict(r) for r in rows]


def get_topic(topic_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        return dict(row) if row else None


def claim_plan(plan_id: int, user_id: int):
    """Attach a guest plan to an account. Plans that already have an owner are left alone."""
    with get_connection() as conn:
        conn.execute("UPDATE plans SET user_id = ? WHERE id = ? AND user_id IS NULL", (user_id, plan_id))


def claim_topics(topic_ids: list[int], user_id: int):
    if not topic_ids:
        return
    with get_connection() as conn:
        placeholders = ",".join("?" for _ in topic_ids)
        conn.execute(
            f"UPDATE topics SET user_id = ? WHERE user_id IS NULL AND id IN ({placeholders})",
            [user_id, *topic_ids],
        )


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
    """Used at login time to fetch the stored password_hash for verification. Case-insensitive."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
        return dict(row) if row else None


# ---- Auth sessions (logged-in browsers) ----

def create_auth_session(token_hash: str, user_id: int, expires_at: str):
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user_id, expires_at),
        )


def get_user_by_session(token_hash: str, now: str):
    """The user behind a live (unexpired) session, or None."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.expires_at > ?""",
            (token_hash, now),
        ).fetchone()
        return dict(row) if row else None


def delete_auth_session(token_hash: str):
    with get_connection() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash,))


# ---- Plans for a user (progress page) ----

def get_plans_for_user(user_id: int, limit: int = 20):
    """A user's plans, newest first, with how many visible tasks are open vs addressed."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT p.id, p.created_at, p.urgency, p.summary,
                      COALESCE(SUM(CASE WHEN t.status IN ('pending', 'in_progress') THEN 1 ELSE 0 END), 0) AS open_tasks,
                      COALESCE(SUM(CASE WHEN t.status IN ('completed', 'partial', 'skipped') THEN 1 ELSE 0 END), 0) AS addressed_tasks,
                      (SELECT title FROM tasks WHERE plan_id = p.id AND status IN ('pending', 'in_progress')
                       ORDER BY priority ASC, id ASC LIMIT 1) AS next_task
               FROM plans p LEFT JOIN tasks t ON t.plan_id = p.id
               WHERE p.user_id = ?
               GROUP BY p.id
               ORDER BY p.id DESC
               LIMIT ?""",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


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