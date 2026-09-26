/*
  app.js

  Purpose:
      Owns all frontend state and every call to the FastAPI backend for
      the app page (app.html) specifically — the landing page (index.html)
      has its own tiny inline script and doesn't load this file. Handles
      panel switching within the app (Situation -> Recovery Plan -> Crunch
      Mode -> Check-in -> Progress), the crunch-mode timer, and rendering
      whatever comes back from the API into the DOM.

  Interacts with:
      - app.html     -> reads/writes elements by id, matches every id
                        referenced below
      - style.css    -> toggles .active classes and body[data-theme];
                        doesn't set styles directly
      - Backend API  -> POST /situation, GET /plan, PATCH /tasks/{id}
                        (same-origin, so plain relative fetch() calls work)

  STATE NOTES:
      All state here (currentPlan, session stats, activity log) lives only
      in memory for this page load. Nothing is persisted client-side;
      reloading the page loses your place. GET /plan on the backend WILL
      still return the last plan if you want to rebuild "resume on reload"
      later — this file just doesn't do that yet.
*/

const state = {
    currentPlan: null,      // last PlanOut from the backend: {id, urgency, summary, tasks}
    activeTaskIndex: 0,     // index into currentPlan.tasks for whichever task is "up next"
    timer: {
        totalSeconds: 0,
        remainingSeconds: 0,
        intervalId: null,
        running: false,
        elapsedSeconds: 0,
    },
    session: {
        focusedMinutes: 0,
        topicsCovered: 0,
        replans: 0,
        activity: [], // {title, detail, minutes}
    },
};

// ---------------- Panel switching within the app ----------------

function showPanel(name) {
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.getElementById(`panel-${name}`).classList.add("active");

    document.querySelectorAll(".nav-item").forEach((btn) => btn.classList.remove("active"));
    const navBtn = document.querySelector(`.nav-item[data-nav="${name}"]`);
    if (navBtn) navBtn.classList.add("active");
}

function unlockNav(...names) {
    names.forEach((n) => {
        const btn = document.querySelector(`.nav-item[data-nav="${n}"]`);
        if (btn) btn.disabled = false;
    });
}

document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
        if (!btn.disabled) showPanel(btn.dataset.nav);
    });
});

// ---------------- Theme toggle (Warm / Cool) ----------------
// Note: app.html doesn't currently render a theme-toggle button in its own
// header — this only matters if you add one here too. Kept for parity with
// the landing page's inline toggle script.

function setTheme(theme) {
    document.body.dataset.theme = theme;
    document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.themeBtn === theme);
    });
}
document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeBtn));
});

// ---------------- Situation panel ----------------

const situationText = document.getElementById("situation-text");
situationText.addEventListener("input", () => {
    document.getElementById("char-count").textContent = situationText.value.length;
});

document.getElementById("energy-segmented").addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    document.querySelectorAll("#energy-segmented button").forEach((b) => b.classList.remove("active"));
    e.target.classList.add("active");
    // Energy level is UI-only for now — see header note. Not sent to the backend.
});

document.getElementById("btn-analyze").addEventListener("click", async () => {
    const description = situationText.value.trim();
    const constraints = document.getElementById("constraints-text").value.trim();
    const minutes = parseInt(document.getElementById("time-available").value, 10);

    if (!description) {
        alert("Tell us what's going on first.");
        return;
    }

    const fullDescription = constraints
        ? `${description}\n\nConstraints to work around: ${constraints}`
        : description;

    const btn = document.getElementById("btn-analyze");
    btn.disabled = true;
    btn.textContent = "Analyzing...";

    try {
        const res = await fetch("/situation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: fullDescription, available_minutes: minutes }),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const plan = await res.json();

        state.currentPlan = plan;
        state.activeTaskIndex = 0;
        renderPlanPanel();
        unlockNav("plan", "crunch", "progress");
        showPanel("plan");
    } catch (err) {
        alert(`Couldn't generate a plan: ${err.message}\n\nCheck that the backend is running and GEMINI_API_KEY is set.`);
    } finally {
        btn.disabled = false;
        btn.textContent = "✦ Analyze my situation";
    }
});

// ---------------- Recovery Plan panel ----------------

function renderPlanPanel() {
    const plan = state.currentPlan;
    const tasks = plan.tasks.filter((t) => t.status !== "replaced");
    if (tasks.length === 0) return;

    const totalMinutes = tasks.reduce((sum, t) => sum + t.duration_minutes, 0);
    document.getElementById("plan-summary-text").textContent = plan.summary;
    document.getElementById("plan-available-time").textContent = `${totalMinutes}m planned`;

    const first = tasks[0];
    document.getElementById("hero-task-title").textContent = first.title;
    document.getElementById("hero-task-time").textContent = `${first.duration_minutes} min`;
    document.getElementById("hero-task-badge").textContent = plan.urgency.toUpperCase();

    const rest = tasks.slice(1);
    const listEl = document.getElementById("after-that-list");
    listEl.innerHTML = "";
    rest.forEach((t, i) => {
        listEl.innerHTML += `
      <div class="task-row">
        <div class="task-num">${i + 2}</div>
        <div class="task-body">
          <strong>${escapeHtml(t.title)}</strong>
          <div class="muted small">${escapeHtml(t.subject ?? "")} · priority ${t.priority}</div>
        </div>
        <div class="task-time">${t.duration_minutes} min</div>
      </div>`;
    });
}

document.getElementById("btn-enter-crunch").addEventListener("click", () => {
    startCrunchModeForCurrentTask();
    showPanel("crunch");
});

// ---------------- Crunch Mode: topics, timer, chat ----------------

const chatState = {
    history: [], // [{role: "user"|"assistant", content: "..."}]
    selectedTopicId: null,
};

function getActiveTasks() {
    return state.currentPlan.tasks.filter((t) => t.status !== "replaced");
}

async function loadTopicsIntoDropdown() {
    const select = document.getElementById("topic-select");
    try {
        const res = await fetch("/topics");
        const topics = await res.json();
        select.innerHTML = '<option value="">No topic selected</option>';
        topics.forEach((t) => {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error("Couldn't load topics:", err);
    }
}

document.getElementById("topic-select").addEventListener("change", (e) => {
    chatState.selectedTopicId = e.target.value ? parseInt(e.target.value, 10) : null;
});

document.getElementById("btn-new-topic-toggle").addEventListener("click", () => {
    const form = document.getElementById("new-topic-form");
    form.style.display = form.style.display === "none" ? "block" : "none";
});

document.getElementById("btn-save-topic").addEventListener("click", async () => {
    const name = document.getElementById("new-topic-name").value.trim();
    const notes = document.getElementById("new-topic-notes").value.trim();
    if (!name) {
        alert("Give the topic a name first.");
        return;
    }

    const btn = document.getElementById("btn-save-topic");
    btn.disabled = true;
    try {
        const res = await fetch("/topics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, notes: notes || null }),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const topic = await res.json();

        await loadTopicsIntoDropdown();
        document.getElementById("topic-select").value = topic.id;
        chatState.selectedTopicId = topic.id;

        document.getElementById("new-topic-name").value = "";
        document.getElementById("new-topic-notes").value = "";
        document.getElementById("new-topic-form").style.display = "none";
    } catch (err) {
        alert(`Couldn't save topic: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
});

function startCrunchModeForCurrentTask() {
    const tasks = getActiveTasks();
    const task = tasks[0]; // always work the current top task
    if (!task) return;

    document.getElementById("crunch-badge").textContent = state.currentPlan.urgency.toUpperCase();
    document.getElementById("crunch-task-index").textContent = `CURRENT TASK · 1 OF ${tasks.length}`;
    document.getElementById("crunch-task-title").textContent = task.title;
    document.getElementById("crunch-block-time").textContent = `${task.duration_minutes} min`;

    // Reset chat for the new task.
    chatState.history = [];
    const chatWindow = document.getElementById("chat-window");
    chatWindow.innerHTML = `
    <div class="chat-message chat-assistant">
      <strong>CrunchAI</strong>
      <p>Ask me anything about "${escapeHtml(task.title)}" — explain a concept, quiz yourself, or check your reasoning. I'll use the topic notes on the right if you've added any.</p>
    </div>`;

    loadTopicsIntoDropdown();
    resetTimer(task.duration_minutes * 60);
}

function resetTimer(totalSeconds) {
    clearInterval(state.timer.intervalId);
    state.timer.totalSeconds = totalSeconds;
    state.timer.remainingSeconds = totalSeconds;
    state.timer.elapsedSeconds = 0;
    state.timer.running = false;
    updateTimerDisplay();
    document.getElementById("timer-status").textContent = "Ready to start";
    document.getElementById("btn-pause").textContent = "▶ Start";
}

function updateTimerDisplay() {
    const m = Math.floor(state.timer.remainingSeconds / 60).toString().padStart(2, "0");
    const s = Math.floor(state.timer.remainingSeconds % 60).toString().padStart(2, "0");
    document.getElementById("timer-display").textContent = `${m}:${s}`;
    const pct = state.timer.totalSeconds
        ? 100 - (state.timer.remainingSeconds / state.timer.totalSeconds) * 100
        : 0;
    document.getElementById("timer-progress-fill").style.width = `${pct}%`;
}

function toggleTimer() {
    if (state.timer.running) {
        clearInterval(state.timer.intervalId);
        state.timer.running = false;
        document.getElementById("btn-pause").textContent = "▶ Resume";
        document.getElementById("timer-status").textContent = "Paused";
        return;
    }
    state.timer.running = true;
    document.getElementById("btn-pause").textContent = "⏸ Pause";
    document.getElementById("timer-status").textContent = "You're in motion";
    state.timer.intervalId = setInterval(() => {
        if (state.timer.remainingSeconds > 0) {
            state.timer.remainingSeconds -= 1;
            state.timer.elapsedSeconds += 1;
        } else {
            clearInterval(state.timer.intervalId);
            state.timer.running = false;
            document.getElementById("timer-status").textContent = "Time's up — wrap it up or mark it done";
        }
        updateTimerDisplay();
    }, 1000);
}

document.getElementById("btn-pause").addEventListener("click", toggleTimer);
document.getElementById("btn-reset-timer").addEventListener("click", () => {
    resetTimer(state.timer.totalSeconds);
});
document.getElementById("btn-complete-task").addEventListener("click", () => {
    clearInterval(state.timer.intervalId);
    state.timer.running = false;
    showPanel("checkin");
});

// ---- Chat (the actual AI study helper) ----

function appendChatMessage(role, content) {
    const chatWindow = document.getElementById("chat-window");
    const div = document.createElement("div");
    div.className = `chat-message ${role === "user" ? "chat-user" : "chat-assistant"}`;
    div.innerHTML = `<strong>${role === "user" ? "You" : "CrunchAI"}</strong><p>${escapeHtml(content)}</p>`;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function sendChatMessage() {
    const input = document.getElementById("chat-input");
    const question = input.value.trim();
    if (!question) return;

    const tasks = getActiveTasks();
    const task = tasks[0];
    if (!task) return;

    appendChatMessage("user", question);
    chatState.history.push({ role: "user", content: question });
    input.value = "";

    const chatWindow = document.getElementById("chat-window");
    const loadingEl = document.createElement("div");
    loadingEl.className = "chat-message chat-loading";
    loadingEl.textContent = "CrunchAI is thinking...";
    chatWindow.appendChild(loadingEl);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    const sendBtn = document.getElementById("btn-send-chat");
    sendBtn.disabled = true;

    try {
        const res = await fetch("/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task_id: task.id,
                topic_id: chatState.selectedTopicId,
                question,
                // Send history *before* this question — the backend appends the
                // question itself when building the prompt.
                history: chatState.history.slice(0, -1),
            }),
        });
        loadingEl.remove();
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();

        appendChatMessage("assistant", data.answer);
        chatState.history.push({ role: "assistant", content: data.answer });
    } catch (err) {
        loadingEl.remove();
        appendChatMessage("assistant", `(Something went wrong: ${err.message})`);
    } finally {
        sendBtn.disabled = false;
    }
}

document.getElementById("btn-send-chat").addEventListener("click", sendChatMessage);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
});

// ---------------- Check-in panel ----------------

let selectedStatus = "partial";
document.getElementById("checkin-options").addEventListener("click", (e) => {
    const btn = e.target.closest(".checkin-option");
    if (!btn) return;
    document.querySelectorAll(".checkin-option").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedStatus = btn.dataset.status;
});

document.getElementById("btn-skip-details").addEventListener("click", submitCheckin);
document.getElementById("btn-update-plan").addEventListener("click", submitCheckin);

async function submitCheckin() {
    const tasks = getActiveTasks();
    const task = tasks[0];
    if (!task) return;

    const actualMinutes = Math.max(1, Math.round(state.timer.elapsedSeconds / 60));

    const btn = document.getElementById("btn-update-plan");
    btn.disabled = true;
    btn.textContent = "Updating...";

    try {
        const res = await fetch(`/tasks/${task.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: selectedStatus, actual_minutes: actualMinutes }),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const result = await res.json();

        // Track session stats client-side (not persisted — see header note).
        state.session.focusedMinutes += actualMinutes;
        if (selectedStatus === "completed" || selectedStatus === "partial") state.session.topicsCovered += 1;
        if (result.replanned) state.session.replans += 1;
        state.session.activity.unshift({
            title: task.title,
            detail: selectedStatus === "completed" ? "Completed" : selectedStatus === "partial" ? "Partially completed" : "Not completed",
            minutes: actualMinutes,
        });

        if (result.replanned) {
            state.currentPlan = result.plan;
        } else if (result.plan_complete) {
            // Mark the just-finished task as done locally so getActiveTasks() moves on.
            task.status = selectedStatus;
        } else {
            task.status = selectedStatus;
        }

        renderProgressPanel(result);
        showPanel("progress");
    } catch (err) {
        alert(`Couldn't update the plan: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = "✦ Update my plan";
    }
}

// ---------------- Progress panel ----------------

function renderProgressPanel(lastResult) {
    const tasks = getActiveTasks().filter((t) => t.status === "pending" || t.status === undefined || t.status === "in_progress");
    const bannerEl = document.getElementById("progress-banner");
    const revisedHero = document.getElementById("revised-hero");
    const emptyState = document.getElementById("progress-empty");

    if (lastResult.replanned) {
        bannerEl.textContent = "Plan updated from your session. We kept what you learned and moved the unfinished piece.";
    } else if (lastResult.plan_complete) {
        bannerEl.textContent = "Nice work — you've worked through everything in this plan.";
    } else {
        bannerEl.textContent = "Progress saved.";
    }

    const remaining = tasks.filter((t) => t.status !== "completed" && t.status !== "skipped");

    if (remaining.length === 0) {
        revisedHero.style.display = "none";
        emptyState.style.display = "block";
    } else {
        emptyState.style.display = "none";
        revisedHero.style.display = "block";
        const next = remaining[0];
        document.getElementById("revised-title").textContent = next.title;
        document.getElementById("revised-time").textContent = `${next.duration_minutes} min`;
        document.getElementById("revised-badge").textContent = state.currentPlan.urgency.toUpperCase();
    }

    const queueList = document.getElementById("progress-queue-list");
    queueList.innerHTML = "";
    remaining.slice(1).forEach((t) => {
        queueList.innerHTML += `
      <div class="task-row">
        <span class="dot"></span>
        <div class="task-body"><strong>${escapeHtml(t.title)}</strong><div class="muted small">${escapeHtml(t.subject ?? "")}</div></div>
        <div class="task-time">${t.duration_minutes} min</div>
      </div>`;
    });

    // Stats
    const totalPlannedMinutes = state.currentPlan.tasks.reduce((s, t) => s + t.duration_minutes, 0) || 1;
    const pct = Math.min(100, Math.round((state.session.focusedMinutes / totalPlannedMinutes) * 100));
    document.getElementById("progress-percent").textContent = `${pct}%`;
    document.getElementById("progress-bar-fill").style.width = `${pct}%`;
    document.getElementById("stat-minutes").textContent = `${state.session.focusedMinutes}m`;
    document.getElementById("stat-topics").textContent = state.session.topicsCovered;
    document.getElementById("stat-replans").textContent = state.session.replans;

    const activityList = document.getElementById("activity-list");
    activityList.innerHTML = "";
    state.session.activity.forEach((a) => {
        activityList.innerHTML += `
      <div class="activity-item">
        <div><strong>${escapeHtml(a.title)}</strong><div class="muted small">${escapeHtml(a.detail)}</div></div>
        <div class="muted small">${a.minutes} min</div>
      </div>`;
    });
}

document.getElementById("btn-start-next-block").addEventListener("click", () => {
    startCrunchModeForCurrentTask();
    showPanel("crunch");
});

// ---------------- Helpers ----------------

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
}