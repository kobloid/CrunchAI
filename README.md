# CrunchAI

**Behind on everything? Start here.**

CrunchAI is an AI-powered academic recovery assistant for students who are reactively procrastinating. Describe your situation and how much time you have, and CrunchAI turns the overwhelm into a short, prioritized plan, then walks you through it one focus block at a time. It started as a UMBC hackathon project.

<!-- Add a screenshot or demo GIF here, e.g. ![CrunchAI](docs/screenshot.png) -->

## Features

- **Situation to plan.** Free-text description plus available minutes goes in; a prioritized list of tasks comes out, with an urgency level and a summary. The first task is always a small 5 to 10 minute starter, because starting is the hardest part.
- **Deadline-aware.** If you mention an exam or due date, tasks get a real deadline. Time-until-deadline is computed server-side rather than trusting the model's own math.
- **Adaptive replanning.** After each block (completed, partial, or skipped), the remaining tasks are replanned based on what actually happened and how much time is left.
- **Crunch Mode.** A focus timer with a required goal, an optional focus lock that tracks time spent off the tab, and a study-helper chat that can be grounded in your own topic notes. Chat history is saved per task.
- **Prove-it quiz.** A short recall check at the end of a block, generated and graded by the AI, so "done" means you actually learned something.
- **Guest first, accounts optional.** Anyone can make a plan without signing up. Signing up or logging in claims your current guest plan and topics.
- **Progress page.** Totals for focused minutes, block outcomes, and recall accuracy, plus your recent plans and blocks.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Python, FastAPI, Pydantic |
| AI | Google Gemini API (`google-genai`), with retry and a fallback model |
| Database | SQLite |
| Frontend | HTML, CSS, and vanilla JavaScript, served by FastAPI |
| Tooling | Docker / Docker Compose, pytest |

## Getting started

### Prerequisites

- Python 3.12+ (or Docker)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Configuration

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_key_here
```

The app reads this key at startup and will not start without it. `.env` is git-ignored, so your key stays out of the repo.

### Run locally

```bash
git clone https://github.com/kobloid/CrunchAI.git
cd CrunchAI

python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

uvicorn app.main:app --reload
```

Open http://localhost:8000. Interactive API docs are at http://localhost:8000/docs.

### Run with Docker

```bash
docker compose up --build
```

Then open http://localhost:8000. Compose reads your `.env`, mounts the project directory into the container, and runs Uvicorn with `--reload`, so code changes are picked up live.

The SQLite database (`crunchai.db`) is created automatically on first run, and older databases are migrated in place on startup.

## Running tests

```bash
pytest
```

The tests in `tests/test_planner.py` make **real Gemini API calls** (plan generation, quiz generation, and grading), so they need `GEMINI_API_KEY` set and will use some of your quota.

## Project structure

```
CrunchAI/
├── app/
│   ├── main.py        # FastAPI routes, auth, ownership checks (glue layer)
│   ├── planner.py     # Gemini calls, prompts, deadline math, retry/fallback
│   ├── models.py      # Pydantic request/response and AI-output schemas
│   ├── db.py          # All SQLite access: schema, migrations, queries
│   └── static/        # Frontend (landing, app, account, progress pages)
│       ├── css/
│       └── js/
├── tests/
│   └── test_planner.py
├── dockerfile
├── compose.yaml
└── requirements.txt
```

## API overview

| Method | Route | Purpose |
|---|---|---|
| POST | `/situation` | Generate a new plan from a described situation |
| GET | `/plan` | Logged-in user's latest plan |
| GET | `/plans/{id}` | A specific plan (guest plans resume by id) |
| PATCH | `/tasks/{id}` | Update a task's status, log the block, trigger a replan |
| GET / POST | `/topics` | List or create subjects with optional context notes |
| PATCH | `/topics/{id}` | Update a topic's notes |
| POST | `/ask` | Crunch Mode study-helper chat |
| GET | `/tasks/{id}/prompts` | Saved chat history for a task |
| POST | `/quiz` | Generate a recall quiz for a block |
| POST | `/quiz/grade` | Grade quiz answers and return a verdict |
| POST | `/signup`, `/login`, `/logout` | Account management |
| GET | `/me`, `/me/progress` | Current user and progress stats |

Full request and response shapes are in `app/models.py`, or browse them interactively at `/docs`.

## Design notes

- **Clear layering.** `main.py` wires things together, `planner.py` knows nothing about FastAPI or SQLite, and `db.py` is the only file that writes SQL. That keeps the AI logic testable on its own.
- **Validated AI output.** Gemini is asked for JSON, and every response is validated against a Pydantic model before it reaches the database or the client. Bad output becomes a clean error instead of a crash.
- **Resilient AI calls.** Transient Gemini errors (429, 500, 503) are retried briefly, then fall back to a lighter model. The model names live at the top of `app/planner.py`.
- **Simple, safe auth.** Passwords are hashed with PBKDF2-SHA256 and a per-user salt. Login uses an HttpOnly session cookie, and only a SHA-256 of the session token is stored server-side.
- **Guest-first data model.** Plans and topics have a nullable `user_id`, so guest work can be attached to an account later.

## Roadmap

<!-- Fill in what you plan to build next. -->

## License

<!-- Choose a license (e.g. MIT) and add a LICENSE file. -->