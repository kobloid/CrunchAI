"""
planner.py

Purpose:
    The "brain" of CrunchAI. Owns the Gemini API call, the prompt text, and
    turning a student's raw situation (or a progress update) into a
    validated plan. Intentionally knows nothing about FastAPI or SQLite —
    it takes plain data in and returns validated Pydantic models out, so it
    can be tested and reused on its own.

Interacts with:
    - models.py    -> validates Gemini's raw JSON against PlanOutput
    - main.py      -> routes call generate_plan() / replan(), then hand the
                      result to db.py to persist
    - db.py        -> NOT imported here on purpose; main.py is the glue
                      between planner output and storage

Run directly (python -m app.planner) to sanity-check a single Gemini call
against a hardcoded situation before wiring it into FastAPI.
"""

import os
import json
from dotenv import load_dotenv
from google import genai

from app.models import PlanOutput

load_dotenv()
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

MODEL_NAME = "gemini-3.1-flash-lite"

PROMPT_TEMPLATE = """You are CrunchAI, an academic recovery assistant for a
student who is behind and has limited time.

Student's situation: {situation}
Time available: {minutes} minutes

Return ONLY valid JSON (no markdown, no commentary) matching this shape:
{{
  "urgency": "low" | "moderate" | "high" | "critical",
  "summary": "one or two sentence strategic summary",
  "tasks": [
    {{"title": "...", "duration_minutes": int, "priority": int}}
  ]
}}

The tasks must add up to no more than {minutes} minutes total.
"""


REPLAN_PROMPT_TEMPLATE = """You are CrunchAI, an academic recovery assistant.
The student was already working from a plan. Here is what just happened and
what's still left.

Last task attempted: {last_task_title}
Outcome: {last_status} (actual time spent: {actual_minutes} minutes)

Remaining tasks the student has not done yet:
{remaining_tasks_list}

Time remaining now: {minutes_left} minutes

Given this, produce a REVISED plan for the remaining time. You may reorder,
merge, shorten, drop, or replace the remaining tasks — whatever is most
realistic given how the last task actually went. Do not just repeat the
remaining tasks unchanged unless that's genuinely still the best plan.

Return ONLY valid JSON (no markdown, no commentary) matching this shape:
{{
  "urgency": "low" | "moderate" | "high" | "critical",
  "summary": "one or two sentence strategic summary of the revised plan",
  "tasks": [
    {{"title": "...", "duration_minutes": int, "priority": int}}
  ]
}}

The tasks must add up to no more than {minutes_left} minutes total.
"""


def _strip_code_fences(text: str) -> str:
    """Gemini sometimes wraps JSON in ```json ... ``` even when told not to."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
    return text.strip()


def _call_gemini(prompt: str) -> dict:
    """Send a prompt to Gemini and parse the response as JSON."""
    response = client.models.generate_content(model=MODEL_NAME, contents=prompt)
    cleaned = _strip_code_fences(response.text)
    return json.loads(cleaned)


def generate_plan(situation: str, available_minutes: int) -> PlanOutput:
    """Turn a fresh situation description into a validated plan."""
    prompt = PROMPT_TEMPLATE.format(situation=situation, minutes=available_minutes)
    raw = _call_gemini(prompt)
    return PlanOutput.model_validate(raw)


def replan(remaining_tasks: list[dict], last_update: dict, minutes_left: int) -> PlanOutput:
    """
    Take the tasks that weren't finished plus how the last task actually
    went, and produce a revised plan for the remaining time.

    remaining_tasks: list of dicts with at least 'title' and 'duration_minutes'
    last_update: dict with 'title', 'status', 'actual_minutes' for the task
                 that was just marked done/partial/skipped
    """
    remaining_list_str = "\n".join(
        f"- {t['title']} (~{t['duration_minutes']} min)" for t in remaining_tasks
    ) or "(none — this was the last task)"

    prompt = REPLAN_PROMPT_TEMPLATE.format(
        last_task_title=last_update.get("title", "unknown task"),
        last_status=last_update.get("status", "unknown"),
        actual_minutes=last_update.get("actual_minutes", "unknown"),
        remaining_tasks_list=remaining_list_str,
        minutes_left=minutes_left,
    )
    raw = _call_gemini(prompt)
    return PlanOutput.model_validate(raw)


if __name__ == "__main__":
    # Quick manual smoke test — no FastAPI, no DB, just the model call.
    plan = generate_plan(
        situation="I have a biology exam tomorrow at 9am and haven't studied chapters 4-7.",
        available_minutes=180,
    )
    print(plan.model_dump_json(indent=2))