"""
main.py

Purpose:
    The FastAPI app itself. This is the glue layer: routes accept requests
    validated by models.py, call planner.py to think, and call db.py to
    persist/read state. Contains no Gemini logic and no raw SQL of its own.
    Also owns /topics (subject + optional AI context notes), /ask (the
    Crunch Mode study-helper chat), /quiz + /quiz/grade (the end-of-block
    recall check), and accounts (/signup, /login, /logout, /me, /me/progress).

    Accounts are optional ("guest first"): anyone can make a plan. Guest
    plans/topics have user_id NULL; signing up or logging in can claim the
    guest's current plan and topics. A logged-in browser holds an HttpOnly
    session cookie; only a SHA-256 of its token is stored server-side.
    Owned plans, tasks, and topics are only visible to their owner.

    The frontend (app/static/) is mounted at the bottom of this file, after
    every API route, so it never shadows the API.

Interacts with:
    - models.py    -> request bodies and response_models on every route
    - planner.py   -> generate_plan() / replan() / answer_question() /
                      generate_quiz() / grade_quiz()
    - db.py        -> all reads/writes, including auth_sessions and claims
    - app/static/  -> index.html / app.html / account.html / progress.html
"""
import hashlib
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from google.genai import errors as genai_errors
from pydantic import ValidationError

from app import db, planner
from app.models import (
    SituationInput, TaskUpdate, TaskStatus, PlanOut, TaskOut,
    TopicCreate, TopicUpdate, Topic, AskRequest, AskResponse, PromptOut, UserCreate, UserOut, LoginRequest,
    QuizRequest, Quiz, QuizGradeRequest, QuizGrade, GuestClaim, MeOut, ProgressOut, ProgressTotals,
    PlanSummary, Block,
)

app = FastAPI(title="CrunchAI")

SESSION_COOKIE = "crunch_session"
SESSION_DAYS = 30


@app.on_event("startup")
def on_startup():
    db.init_db()


# ---- Error handling ----

@app.exception_handler(genai_errors.APIError)
def ai_unavailable(request: Request, exc: genai_errors.APIError):
    return JSONResponse(status_code=503, content={"detail": "The AI is busy right now. Try again in a few seconds."})


@app.exception_handler(json.JSONDecodeError)
@app.exception_handler(ValidationError)
def ai_bad_output(request: Request, exc: Exception):
    return JSONResponse(status_code=502, content={"detail": "The AI sent back something unexpected. Try again."})


FIELD_MESSAGES = {
    "username": "Usernames are 3 to 24 letters, numbers, dots, or underscores.",
    "password": "Passwords need at least 8 characters.",
}


@app.exception_handler(RequestValidationError)
def readable_validation_error(request: Request, exc: RequestValidationError):
    fields = [str(err["loc"][-1]) for err in exc.errors() if err.get("loc")]
    message = next((FIELD_MESSAGES[f] for f in fields if f in FIELD_MESSAGES), "Some of that input doesn't look right.")
    return JSONResponse(status_code=422, content={"detail": message})


# ---- Auth helpers ----

def _hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"{salt}${digest.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    salt, _, _ = stored_hash.partition("$")
    return secrets.compare_digest(_hash_password(password, salt), stored_hash)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _utc_stamp(moment: datetime) -> str:
    # Same format as SQLite's CURRENT_TIMESTAMP, so string comparison works.
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def current_user(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    return db.get_user_by_session(_token_hash(token), _utc_stamp(datetime.now(timezone.utc)))


def _start_session(response: Response, user_id: int):
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    db.create_auth_session(_token_hash(token), user_id, _utc_stamp(expires))
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", path="/"
    )


def _claim_guest_work(claim: GuestClaim, user_id: int):
    if claim.claim_plan_id:
        db.claim_plan(claim.claim_plan_id, user_id)
    db.claim_topics(claim.claim_topic_ids, user_id)


def _user_out(user: dict) -> UserOut:
    return UserOut(id=user["id"], username=user["username"], email=user.get("email"))


# ---- Ownership checks (guest data, user_id NULL, is reachable by id) ----

def _can_access(owner_id: int | None, user: dict | None) -> bool:
    return owner_id is None or (user is not None and user["id"] == owner_id)


def _plan_for(plan_id: int, user: dict | None) -> dict:
    plan = db.get_plan(plan_id)
    if not plan or not _can_access(plan.get("user_id"), user):
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


def _task_for(task_id: int, user: dict | None) -> dict:
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    _plan_for(task["plan_id"], user)
    return task


def _topic_for(topic_id: int | None, user: dict | None) -> dict | None:
    if not topic_id:
        return None
    topic = db.get_topic(topic_id)
    if not topic or not _can_access(topic.get("user_id"), user):
        raise HTTPException(status_code=404, detail="Topic not found")
    return topic


# ---- Plans ----

@app.post("/situation", response_model=PlanOut)
def submit_situation(situation: SituationInput, user: dict | None = Depends(current_user)):
    """Generate a brand-new plan from the student's described situation."""
    plan = planner.generate_plan(situation.description, situation.available_minutes, situation.client_now)

    plan_id = db.create_plan(
        available_minutes=situation.available_minutes,
        urgency=plan.urgency.value,
        summary=plan.summary,
        user_id=user["id"] if user else None,
    )
    for task in plan.tasks:
        db.create_task(plan_id, task.title, task.duration_minutes, task.priority, task.deadline)

    return _load_plan_out(plan_id)


@app.get("/plan", response_model=PlanOut)
def get_current_plan(user: dict | None = Depends(current_user)):
    """The logged-in user's most recent plan. Guests resume by id via /plans/{id}."""
    if not user:
        raise HTTPException(status_code=404, detail="Log in to see your latest plan.")
    plan_row = db.get_latest_plan(user["id"])
    if not plan_row:
        raise HTTPException(status_code=404, detail="No plan yet. POST /situation first.")
    return _load_plan_out(plan_row["id"])


@app.get("/plans/{plan_id}", response_model=PlanOut)
def get_plan(plan_id: int, user: dict | None = Depends(current_user)):
    _plan_for(plan_id, user)
    return _load_plan_out(plan_id)


@app.patch("/tasks/{task_id}")
def update_task(task_id: int, update: TaskUpdate, user: dict | None = Depends(current_user)):
    """
    Mark a task's status, log the session, and (if the plan isn't finished)
    trigger a replan for whatever's left.
    """
    task_row = _task_for(task_id, user)

    db.update_task_status(task_id, update.status.value)
    if update.actual_minutes is not None:
        db.create_session(
            task_id, update.actual_minutes, update.status.value,
            commitment=update.commitment, away_minutes=update.away_minutes,
            quiz_correct=update.quiz_correct, quiz_total=update.quiz_total,
        )

    # If the task is still just "pending" or "in_progress" there's nothing to replan.
    if update.status in (TaskStatus.PENDING, TaskStatus.IN_PROGRESS):
        return {"ok": True, "replanned": False}

    plan_id = task_row["plan_id"]
    remaining = db.get_pending_tasks_for_plan(plan_id, exclude_task_id=task_id)

    if not remaining:
        return {"ok": True, "replanned": False, "plan_complete": True}

    minutes_left = sum(t["duration_minutes"] for t in remaining)
    revised = planner.replan(
        remaining_tasks=remaining,
        last_update={
            "title": task_row["title"],
            "status": update.status.value,
            "actual_minutes": update.actual_minutes,
            "commitment": update.commitment,
            "away_minutes": update.away_minutes,
            "quiz_correct": update.quiz_correct,
            "quiz_total": update.quiz_total,
        },
        minutes_left=minutes_left,
        client_now=update.client_now,
    )

    db.mark_tasks_replaced([t["id"] for t in remaining])
    db.update_plan_meta(plan_id, revised.urgency.value, revised.summary)
    for task in revised.tasks:
        db.create_task(plan_id, task.title, task.duration_minutes, task.priority, task.deadline)

    return {"ok": True, "replanned": True, "plan": _load_plan_out(plan_id)}


def _load_plan_out(plan_id: int) -> PlanOut:
    plan_row = db.get_plan(plan_id)
    all_tasks = db.get_tasks_for_plan(plan_id)
    # Only show what's currently actionable/visible: hide replaced tasks,
    # since they've been superseded by whatever came out of the last replan.
    visible_tasks = [t for t in all_tasks if t["status"] != "replaced"]
    return PlanOut(
        id=plan_row["id"],
        urgency=plan_row["urgency"],
        summary=plan_row["summary"],
        tasks=[TaskOut(**t) for t in visible_tasks],
    )


# ---- Topics ----

@app.get("/topics", response_model=list[Topic])
def list_topics(ids: str | None = None, user: dict | None = Depends(current_user)):
    """A user's topics, or for guests the guest topics their browser remembers (?ids=1,2)."""
    if user:
        return [Topic(**t) for t in db.get_all_topics(user["id"])]
    topic_ids = [int(i) for i in (ids or "").split(",") if i.strip().isdigit()]
    return [Topic(**t) for t in db.get_guest_topics(topic_ids)]


@app.post("/topics", response_model=Topic)
def create_topic(topic: TopicCreate, user: dict | None = Depends(current_user)):
    topic_id = db.create_topic(topic.name, topic.notes, user["id"] if user else None)
    return Topic(id=topic_id, name=topic.name, notes=topic.notes)


@app.patch("/topics/{topic_id}", response_model=Topic)
def update_topic(topic_id: int, update: TopicUpdate, user: dict | None = Depends(current_user)):
    existing = _topic_for(topic_id, user)
    db.update_topic_notes(topic_id, update.notes)
    return Topic(id=topic_id, name=existing["name"], notes=update.notes)


# ---- AI study helper (Crunch Mode chat) ----

@app.post("/ask", response_model=AskResponse)
def ask_study_helper(request: AskRequest, user: dict | None = Depends(current_user)):
    task = _task_for(request.task_id, user)
    topic = _topic_for(request.topic_id, user)
    history = [{"role": m.role, "content": m.content} for m in request.history]
    answer = planner.answer_question(task, topic, request.question, history, request.client_now)

    # Persist this turn so it survives a refresh and can be replayed via
    # GET /tasks/{task_id}/prompts, instead of living only in the
    # client-held `history` the frontend re-sends each time.
    db.create_prompt(request.task_id, request.topic_id, request.question, answer)

    return AskResponse(answer=answer)


@app.get("/tasks/{task_id}/prompts", response_model=list[PromptOut])
def get_task_prompts(task_id: int, user: dict | None = Depends(current_user)):
    """Full Q&A history for a task, so the frontend can rehydrate a chat on load."""
    _task_for(task_id, user)
    return [PromptOut(**p) for p in db.get_prompts_for_task(task_id)]


# ---- Prove-it quiz (recall check at the end of a focus block) ----

@app.post("/quiz", response_model=Quiz)
def create_quiz(request: QuizRequest, user: dict | None = Depends(current_user)):
    task = _task_for(request.task_id, user)
    topic = _topic_for(request.topic_id, user)
    return planner.generate_quiz(task, topic, request.commitment)


@app.post("/quiz/grade", response_model=QuizGrade)
def grade_quiz(request: QuizGradeRequest, user: dict | None = Depends(current_user)):
    task = _task_for(request.task_id, user)
    topic = _topic_for(request.topic_id, user)
    return planner.grade_quiz(task, topic, request.questions, request.answers)


# ---- Accounts ----

@app.post("/signup", response_model=UserOut, status_code=201)
def signup(payload: UserCreate, response: Response):
    if db.get_user_by_username(payload.username):
        raise HTTPException(status_code=409, detail="That username is taken. Try another one.")
    try:
        user_id = db.create_user(payload.username, _hash_password(payload.password), payload.email or None)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="That username or email is already registered.")
    _claim_guest_work(payload, user_id)
    _start_session(response, user_id)
    return UserOut(id=user_id, username=payload.username, email=payload.email or None)


@app.post("/login", response_model=UserOut)
def login(payload: LoginRequest, response: Response):
    user = db.get_user_by_username(payload.username.strip())
    if not user or not _verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    _claim_guest_work(payload, user["id"])
    _start_session(response, user["id"])
    return _user_out(user)


@app.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.delete_auth_session(_token_hash(token))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/me", response_model=MeOut)
def me(user: dict | None = Depends(current_user)):
    return MeOut(user=_user_out(user) if user else None)


@app.get("/me/progress", response_model=ProgressOut)
def my_progress(user: dict | None = Depends(current_user)):
    if not user:
        raise HTTPException(status_code=401, detail="Log in to see your progress.")
    blocks = db.get_sessions_for_user(user["id"])
    plans = db.get_plans_for_user(user["id"])
    totals = ProgressTotals(
        blocks=len(blocks),
        focused_minutes=sum(b["actual_minutes"] or 0 for b in blocks),
        completed=sum(1 for b in blocks if b["outcome"] == "completed"),
        partial=sum(1 for b in blocks if b["outcome"] == "partial"),
        skipped=sum(1 for b in blocks if b["outcome"] == "skipped"),
        recall_correct=sum(b["quiz_correct"] or 0 for b in blocks if b["quiz_total"]),
        recall_total=sum(b["quiz_total"] or 0 for b in blocks),
    )
    return ProgressOut(
        user=_user_out(user),
        totals=totals,
        plans=[PlanSummary(**p) for p in plans],
        blocks=[Block(**b) for b in blocks],
    )


# Serve the frontend last, so it doesn't shadow the API routes above.
# html=True makes "/" resolve to index.html.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
