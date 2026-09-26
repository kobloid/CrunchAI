"""
test_planner.py

Purpose:
    Sanity-checks planner.py in isolation — no FastAPI, no SQLite. Confirms
    that a real situation produces a validly-shaped plan, so prompt/schema
    regressions get caught here instead of during manual demo testing.

Interacts with:
    - app/planner.py   -> the module under test
    - app/models.py    -> asserts against PlanOutput's shape

Note: this makes a real Gemini API call, so it needs GEMINI_API_KEY set
(via .env) to run. If that's a problem in CI later, swap _call_gemini for
a mock here rather than skipping the test.
"""

from app.planner import generate_plan
from app.models import PlanOutput, Urgency


def test_generate_plan_returns_valid_shape():
    plan = generate_plan(
        situation="I have a biology exam tomorrow at 9am and haven't studied chapters 4-7.",
        available_minutes=120,
    )

    assert isinstance(plan, PlanOutput)
    assert plan.urgency in list(Urgency)
    assert len(plan.tasks) > 0
    assert all(t.duration_minutes > 0 for t in plan.tasks)


def test_generate_plan_respects_time_budget():
    available = 60
    plan = generate_plan(
        situation="I have 3 small homework assignments due tomorrow.",
        available_minutes=available,
    )

    total = sum(t.duration_minutes for t in plan.tasks)
    # Allow some slack since the model won't hit the budget exactly.
    assert total <= available * 1.25