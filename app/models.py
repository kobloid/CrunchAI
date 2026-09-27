"""
models.py

Purpose:
    Defines every request/response shape that crosses a boundary in CrunchAI —
    what the frontend sends, what Gemini must return, and what the API sends
    back. Keeping these in one place means planner.py and main.py agree on
    exactly one definition of "what a plan looks like."

Interacts with:
    - planner.py   -> validates Gemini's raw JSON response against PlanOutput
    - main.py      -> used as request bodies / response_models on routes
    - db.py        -> rows are converted to/from these models when
                      reading/writing tasks, plans, and sessions
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class Urgency(str, Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    PARTIAL = "partial"
    SKIPPED = "skipped"        # student explicitly skipped it
    REPLACED = "replaced"      # superseded by a replan, not the student's doing


# ---- Incoming from the frontend ----

class SituationInput(BaseModel):
    description: str = Field(..., description="Student's free-text description of their situation")
    available_minutes: int = Field(..., gt=0, description="How much time the student has right now")


class TaskUpdate(BaseModel):
    status: TaskStatus
    actual_minutes: Optional[int] = None


# ---- Produced by planner.py (and validated against Gemini's output) ----

class Task(BaseModel):
    title: str
    duration_minutes: int
    priority: int
    deadline: Optional[str] = Field(
        None, description="ISO 8601 datetime for the event this task is tied to (e.g. an exam), if one was stated or inferable. Null if no real deadline exists."
    )


class PlanOutput(BaseModel):
    urgency: Urgency
    summary: str
    tasks: list[Task]


# ---- Returned by the API ----

class TaskOut(Task):
    id: int
    status: TaskStatus


class PlanOut(BaseModel):
    id: int
    urgency: Urgency
    summary: str
    tasks: list[TaskOut]


# ---- Topics (subject + optional context notes for the AI study helper) ----

class TopicCreate(BaseModel):
    name: str = Field(..., description="Subject label, e.g. 'Biology 201'")
    notes: Optional[str] = Field(None, description="Free-text context the AI should ground answers in")


class TopicUpdate(BaseModel):
    notes: Optional[str] = None


class Topic(BaseModel):
    id: int
    name: str
    notes: Optional[str] = None


# ---- AI study helper (Crunch Mode chat, NotebookLM-style Q&A) ----

class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class AskRequest(BaseModel):
    task_id: int
    topic_id: Optional[int] = None
    question: str
    history: list[ChatMessage] = Field(default_factory=list)


class AskResponse(BaseModel):
    answer: str