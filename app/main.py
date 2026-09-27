"""
main.py

Purpose:
    The FastAPI app itself. This is the glue layer: routes accept requests
    validated by models.py, call planner.py to think, and call db.py to
    persist/read state. Contains no Gemini logic and no raw SQL of its own.
    Also owns /topics (subject + optional AI context notes) and /ask (the
    Crunch Mode study-helper chat).

    The frontend (app/static/) is mounted at the bottom of this file, after
    every API route, so it never shadows /situation, /plan, /tasks/{id},
    /topics, or /ask.

Interacts with:
    - models.py    -> request bodies and response_models on every route
    - planner.py   -> generate_plan() / replan() / answer_question()
    - db.py        -> create_plan / create_task / get_latest_plan /
                      get_pending_tasks_for_plan / update_task_status /
                      mark_tasks_replaced / update_plan_meta / create_session /
                      create_topic / get_all_topics / get_topic / update_topic_notes
    - app/static/  -> index.html (landing) / app.html (the app) / style.css / app.js
"""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from app import db, planner
from app.models import (
    SituationInput, TaskUpdate, TaskStatus, PlanOut, TaskOut,
    TopicCreate, TopicUpdate, Topic, AskRequest, AskResponse, PromptOut,
)

app = FastAPI(title="CrunchAI")


@app.on_event("startup")
def on_startup():
    db.init_db()


@app.post("/situation", response_model=PlanOut)
def submit_situation(situation: SituationInput):
    """Generate a brand-new plan from the student's described situation."""
    plan = planner.generate_plan(situation.description, situation.available_minutes)

    plan_id = db.create_plan(
        available_minutes=situation.available_minutes,
        urgency=plan.urgency.value,
        summary=plan.summary,
    )
    for task in plan.tasks:
        db.create_task(plan_id, task.title, task.duration_minutes, task.priority)

    return _load_plan_out(plan_id)


@app.get("/plan", response_model=PlanOut)
def get_current_plan():
    """Return the most recently generated plan, with its tasks."""
    plan_row = db.get_latest_plan()
    if not plan_row:
        raise HTTPException(status_code=404, detail="No plan yet. POST /situation first.")
    return _load_plan_out(plan_row["id"])


@app.patch("/tasks/{task_id}")
def update_task(task_id: int, update: TaskUpdate):
    """
    Mark a task's status, log the session, and — if the plan isn't
    finished — trigger a replan for whatever's left.
    """
    task_row = db.get_task(task_id)
    if not task_row:
        raise HTTPException(status_code=404, detail="Task not found")

    db.update_task_status(task_id, update.status.value)
    if update.actual_minutes is not None:
        db.create_session(task_id, update.actual_minutes, update.status.value)

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
        },
        minutes_left=minutes_left,
    )

    db.mark_tasks_replaced([t["id"] for t in remaining])
    db.update_plan_meta(plan_id, revised.urgency.value, revised.summary)
    for task in revised.tasks:
        db.create_task(plan_id, task.title, task.duration_minutes, task.priority)

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
def list_topics():
    return [Topic(**t) for t in db.get_all_topics()]


@app.post("/topics", response_model=Topic)
def create_topic(topic: TopicCreate):
    topic_id = db.create_topic(topic.name, topic.notes)
    return Topic(id=topic_id, name=topic.name, notes=topic.notes)


@app.patch("/topics/{topic_id}", response_model=Topic)
def update_topic(topic_id: int, update: TopicUpdate):
    existing = db.get_topic(topic_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Topic not found")
    db.update_topic_notes(topic_id, update.notes)
    return Topic(id=topic_id, name=existing["name"], notes=update.notes)


# ---- AI study helper (Crunch Mode chat) ----

@app.post("/ask", response_model=AskResponse)
def ask_study_helper(request: AskRequest):
    task = db.get_task(request.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    topic = db.get_topic(request.topic_id) if request.topic_id else None
    history = [{"role": m.role, "content": m.content} for m in request.history]
    answer = planner.answer_question(task, topic, request.question, history)

    # Persist this turn so it survives a refresh and can be replayed via
    # GET /tasks/{task_id}/prompts, instead of living only in the
    # client-held `history` the frontend re-sends each time.
    db.create_prompt(request.task_id, request.topic_id, request.question, answer)

    return AskResponse(answer=answer)


@app.get("/tasks/{task_id}/prompts", response_model=list[PromptOut])
def get_task_prompts(task_id: int):
    """Full Q&A history for a task, so the frontend can rehydrate a chat on load."""
    if not db.get_task(task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    return [PromptOut(**p) for p in db.get_prompts_for_task(task_id)]


@app.get("/tasks/{task_id}/prompts", response_model=list[PromptOut])
def get_task_prompts(task_id: int):
    """Full Q&A history for a task, so the frontend can rehydrate a chat on load."""
    if not db.get_task(task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    return [PromptOut(**p) for p in db.get_prompts_for_task(task_id)]


# Serve the frontend last, so it doesn't shadow the API routes above.
# html=True makes "/" resolve to index.html.
app.mount("/", StaticFiles(directory="app/static", html=True), name="static")