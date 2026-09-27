"""
planner.py

Purpose:
    The "brain" of CrunchAI. Owns the Gemini API call, prompt text, and:
    turning a situation into a plan (generate_plan), revising a plan after
    progress (replan), the Crunch Mode study chat (answer_question), and the
    end-of-block recall check (generate_quiz / grade_quiz). Also computes real
    time-until-deadline server-side (never trusting the model's own math for
    that) and feeds it into replan/ask prompts so the AI reasons with
    accurate urgency. Intentionally knows nothing about FastAPI or SQLite:
    it takes plain data in and returns validated Pydantic models (or plain
    text, for chat) out, so it can be tested and reused on its own.

Interacts with:
    - models.py    -> validates Gemini's raw JSON against PlanOutput,
                      Quiz, and QuizGrade; answer_question() returns plain
                      text instead, wrapped in AskResponse by main.py
    - main.py      -> routes call generate_plan() / replan() / answer_question() /
                      generate_quiz() / grade_quiz(), then hand results to
                      db.py to persist where needed
    - db.py        -> NOT imported here on purpose; main.py is the glue
                      between planner output and storage

Run directly (python -m app.planner) to sanity-check a single Gemini call
against a hardcoded situation before wiring it into FastAPI.
"""

import os
import json
import time
from datetime import datetime, timezone
from dotenv import load_dotenv
from google import genai
from google.genai import errors as genai_errors

from app.models import PlanOutput, Quiz, QuizGrade

load_dotenv()
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

MODEL_NAME = "gemini-3.8-flash"
FALLBACK_MODEL = "gemini-3.1-flash-lite"
RETRYABLE_STATUS = {429, 500, 503}

TASK_SCHEMA_HINT = """{{
      "title": "...",
      "duration_minutes": int, "priority": int,
      "deadline": "2026-09-27T10:00:00" | null
    }}"""

PROMPT_TEMPLATE = """You are CrunchAI, an academic recovery assistant for a
student who is behind and has limited time.

Current date/time: {now_iso}

Student's situation: {situation}
Time available: {minutes} minutes

Return ONLY valid JSON (no markdown, no commentary) matching this shape:
{{
  "urgency": "low" | "moderate" | "high" | "critical",
  "summary": "one or two sentence strategic summary",
  "tasks": [
    """ + TASK_SCHEMA_HINT + """
  ]
}}

For "deadline": if the student mentions a specific event this task is tied
to (an exam, a due date, a meeting), compute the actual ISO 8601 datetime
for it relative to the current date/time above (e.g. "tomorrow at 10am" ->
a real date this year). If no real deadline exists for a task, use null;
do not invent one.

The tasks must add up to no more than {minutes} minutes total.
The first task must be a small starter that takes 5 to 10 minutes and can be
started immediately, because starting is the hardest part for this student.
Do not use em dashes in any text.
"""

REPLAN_PROMPT_TEMPLATE = """You are CrunchAI, an academic recovery assistant.
The student was already working from a plan. Here is what just happened and
what's still left.

Current date/time: {now_iso}

Last task attempted: {last_task_title}
Outcome: {last_status} (actual time spent: {actual_minutes} minutes)
{block_context}
Remaining tasks the student has not done yet (with real time left until each
task's deadline, computed just now; treat this as accurate and prioritize
accordingly):
{remaining_tasks_list}

Time remaining now: {minutes_left} minutes

Given this, produce a REVISED plan for the remaining time. You may reorder,
merge, shorten, drop, or replace the remaining tasks, whatever is most
realistic given how the last task actually went and how close each deadline
actually is. Do not just repeat the remaining tasks unchanged unless that's
genuinely still the best plan.

Return ONLY valid JSON (no markdown, no commentary) matching this shape:
{{
  "urgency": "low" | "moderate" | "high" | "critical",
  "summary": "one or two sentence strategic summary of the revised plan",
  "tasks": [
    """ + TASK_SCHEMA_HINT + """
  ]
}}

Preserve each remaining task's original "deadline" value unless the revision
genuinely changes what event it's tied to. The tasks must add up to no more
than {minutes_left} minutes total.
If the last task was skipped, make the next task a small starter that takes
5 to 10 minutes, so the student can get moving again.
Do not use em dashes in any text.
"""


def _resolve_now(client_now: str | None = None) -> datetime:
    """
    The student's current time. The server runs in UTC, so "tomorrow" typed
    at 10 PM Eastern would land a day off; the browser sends its own clock
    (ISO with offset) and that wins when it parses.
    """
    if client_now:
        try:
            parsed = datetime.fromisoformat(client_now)
            if parsed.tzinfo:
                return parsed
        except ValueError:
            pass
    return datetime.now(timezone.utc).astimezone()


def _now_iso(now: datetime) -> str:
    return now.isoformat(timespec="seconds")


def _time_until(deadline_iso: str | None, now: datetime | None = None) -> str:
    """
    Compute a human-readable time-remaining string from a stored ISO
    deadline, using real time, never the model's own math. Naive deadlines
    are wall-clock times in the student's timezone, so they're compared
    against the student's wall clock.
    Returns 'no deadline set' if deadline_iso is None/unparseable, or
    'overdue' if it's already passed.
    """
    if not deadline_iso:
        return "no deadline set"
    try:
        deadline = datetime.fromisoformat(deadline_iso)
    except ValueError:
        return "no deadline set"

    now = now or _resolve_now()
    if deadline.tzinfo is None:
        now = now.replace(tzinfo=None)
    delta = deadline - now
    total_seconds = delta.total_seconds()

    if total_seconds <= 0:
        return "overdue"

    hours = total_seconds / 3600
    if hours < 1:
        return f"in {int(total_seconds // 60)} minutes"
    if hours < 48:
        return f"in {hours:.1f} hours"
    return f"in {int(hours // 24)} days"


def _block_context(last_update: dict) -> str:
    """Optional evidence about how the last focus block really went."""
    lines = []
    if last_update.get("commitment"):
        lines.append(f"Their goal for that block was: {last_update['commitment']}")
    if last_update.get("quiz_total"):
        lines.append(
            f"Recall check afterwards: {last_update.get('quiz_correct', 0)} of "
            f"{last_update['quiz_total']} questions answered correctly."
        )
    if last_update.get("away_minutes"):
        lines.append(f"They spent {last_update['away_minutes']} minutes off the page during the block.")
    return "\n".join(lines) + ("\n" if lines else "")


def _topic_context(topic: dict | None) -> str:
    if topic and topic.get("notes"):
        return f"\nContext notes for {topic['name']}:\n{topic['notes']}\n"
    if topic:
        return f"\nTopic: {topic['name']} (no additional notes provided)\n"
    return ""


def _strip_code_fences(text: str) -> str:
    """Gemini sometimes wraps JSON in ```json ... ``` even when told not to."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
    return text.strip()


def _generate(prompt: str) -> str:
    """
    Get text from Gemini. The primary model returns 503 "high demand" at
    busy times, so retry briefly, then fall back to a lighter model.
    """
    last_error = None
    for model in (MODEL_NAME, FALLBACK_MODEL):
        for attempt in range(2):
            try:
                return client.models.generate_content(model=model, contents=prompt).text
            except genai_errors.APIError as err:
                if err.code not in RETRYABLE_STATUS:
                    raise
                last_error = err
                time.sleep(1 + attempt)
    raise last_error


def _call_gemini(prompt: str) -> dict:
    """Send a prompt to Gemini and parse the response as JSON."""
    return json.loads(_strip_code_fences(_generate(prompt)))


def generate_plan(situation: str, available_minutes: int, client_now: str | None = None) -> PlanOutput:
    """Turn a fresh situation description into a validated plan."""
    prompt = PROMPT_TEMPLATE.format(
        now_iso=_now_iso(_resolve_now(client_now)), situation=situation, minutes=available_minutes
    )
    raw = _call_gemini(prompt)
    return PlanOutput.model_validate(raw)


def replan(remaining_tasks: list[dict], last_update: dict, minutes_left: int, client_now: str | None = None) -> PlanOutput:
    """
    Take the tasks that weren't finished plus how the last task actually
    went, and produce a revised plan for the remaining time.

    remaining_tasks: list of dicts with at least 'title', 'duration_minutes',
                      and optionally 'deadline' (ISO string or None)
    last_update: dict with 'title', 'status', 'actual_minutes' for the task
                 that was just marked done/partial/skipped, plus optional
                 'commitment', 'away_minutes', 'quiz_correct', 'quiz_total'
    """
    now = _resolve_now(client_now)
    lines = []
    for t in remaining_tasks:
        deadline = t.get("deadline")
        time_left = _time_until(deadline, now)
        deadline_note = f", deadline: {deadline} ({time_left})" if deadline else ", no deadline"
        lines.append(f"- {t['title']} (~{t['duration_minutes']} min){deadline_note}")
    remaining_list_str = "\n".join(lines) or "(none, this was the last task)"

    prompt = REPLAN_PROMPT_TEMPLATE.format(
        now_iso=_now_iso(now),
        last_task_title=last_update.get("title", "unknown task"),
        last_status=last_update.get("status", "unknown"),
        actual_minutes=last_update.get("actual_minutes", "unknown"),
        block_context=_block_context(last_update),
        remaining_tasks_list=remaining_list_str,
        minutes_left=minutes_left,
    )
    raw = _call_gemini(prompt)
    return PlanOutput.model_validate(raw)


ASK_SYSTEM_PROMPT = """You are CrunchAI's study helper, active during a focused study session.
Your job is to help the student understand and work through their material right now:
explain concepts, quiz them, check their reasoning, and answer questions directly.
Keep answers focused and study-session appropriate: clear, not overly long, and oriented
toward helping them actually learn this before their deadline, not a generic essay.
Do not use em dashes.

Current task: {task_title}
Deadline: {task_deadline} (time left: {time_left})
{topic_context}
"""


def answer_question(
    task: dict, topic: dict | None, question: str, history: list[dict], client_now: str | None = None
) -> str:
    """
    Answer a student's question during Crunch Mode, grounded in the current
    task (including real, server-computed time-until-deadline) and
    optionally a topic's saved notes — the NotebookLM-style "answer using
    this context" pattern, minus file uploads for now.

    task: a task row/dict with at least 'title' and 'subject'; 'deadline'
          (ISO string or None) is used to compute real urgency
    topic: a topic row/dict with 'name' and 'notes', or None if no topic
           was selected
    question: the student's latest message
    history: prior turns in this chat, as [{"role": "user"/"assistant", "content": ...}, ...]
    """
    deadline = task.get("deadline")
    system_prompt = ASK_SYSTEM_PROMPT.format(
        task_title=task.get("title", "Unknown task"),
        task_deadline=deadline or "none stated",
        time_left=_time_until(deadline, _resolve_now(client_now)),
        topic_context=_topic_context(topic),
    )

    # Fold history + the new question into one prompt. This is plain text,
    # not the structured-JSON pattern generate_plan()/replan() use — a study
    # chat should read like a chat, not a schema.
    convo_lines = [system_prompt, "\n--- Conversation so far ---"]
    for turn in history:
        speaker = "Student" if turn.get("role") == "user" else "CrunchAI"
        convo_lines.append(f"{speaker}: {turn.get('content', '')}")
    convo_lines.append(f"Student: {question}")
    convo_lines.append("CrunchAI:")

    prompt = "\n".join(convo_lines)
    return _generate(prompt).strip()


QUIZ_PROMPT_TEMPLATE = """You are CrunchAI's study helper. The student just finished a focus
block and wants to check what they actually learned.

Task they worked on: {task_title}
{goal_line}{topic_context}
Write exactly 3 short recall questions they could answer from memory in one or
two sentences each. Test understanding of the task's material, not trivia.
Do not include answers. Do not use em dashes.

Return ONLY valid JSON (no markdown, no commentary) matching this shape:
{{"questions": ["...", "...", "..."]}}
"""


GRADE_PROMPT_TEMPLATE = """You are CrunchAI's study helper, grading a quick recall check.
Be encouraging but honest: a vague, off-topic, or empty answer is not correct.

Task the student worked on: {task_title}
{topic_context}
{qa_block}

Grade each answer as "correct", "partial", or "wrong", with one short sentence of
feedback naming what was right or what was missing. Then give an overall verdict:
"completed" if the answers show they covered the task, "partial" if they covered
some of it, "skipped" if they show little or no progress. Do not use em dashes.

Return ONLY valid JSON (no markdown, no commentary) matching this shape:
{{
  "results": [{{"grade": "correct" | "partial" | "wrong", "feedback": "..."}}],
  "verdict": "completed" | "partial" | "skipped",
  "summary": "one short sentence for the student"
}}
The results list must have exactly {count} items, in the same order as the questions.
"""


def generate_quiz(task: dict, topic: dict | None, commitment: str | None = None) -> Quiz:
    """Three recall questions about the task the student just worked on."""
    goal_line = f"Their goal for the block was: {commitment}\n" if commitment else ""
    prompt = QUIZ_PROMPT_TEMPLATE.format(
        task_title=task.get("title", "Unknown task"),
        goal_line=goal_line,
        topic_context=_topic_context(topic),
    )
    return Quiz.model_validate(_call_gemini(prompt))


def grade_quiz(task: dict, topic: dict | None, questions: list[str], answers: list[str]) -> QuizGrade:
    """Grade the student's recall answers and suggest how the block went."""
    qa_block = "\n".join(
        f"Q{i}: {q}\nA{i}: {(answers[i - 1].strip() if i <= len(answers) else '') or '(no answer)'}"
        for i, q in enumerate(questions, start=1)
    )
    prompt = GRADE_PROMPT_TEMPLATE.format(
        task_title=task.get("title", "Unknown task"),
        topic_context=_topic_context(topic),
        qa_block=qa_block,
        count=len(questions),
    )
    return QuizGrade.model_validate(_call_gemini(prompt))


if __name__ == "__main__":
    # Quick manual smoke test — no FastAPI, no DB, just the model call.
    plan = generate_plan(
        situation="I have a biology exam tomorrow at 9am and haven't studied chapters 4-7.",
        available_minutes=180,
    )
    print(plan.model_dump_json(indent=2))