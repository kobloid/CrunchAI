/*
  app.js: the CrunchAI study room (app.html).
  Owns session state, every call to the FastAPI backend, the five scenes
  (situation, plan, crunch, check-in, progress) and their transitions, the
  focus timer (optional focus lock + tab-title countdown), the study-helper
  chat, and the Prove-it quiz.

  Backend contract (see app/main.py):
    GET   /plan        -> latest PlanOut (404 when there is none)
    POST  /situation   {description, available_minutes} -> PlanOut
    PATCH /tasks/{id}  {status, actual_minutes, commitment?, away_minutes?,
                        quiz_correct?, quiz_total?} -> {replanned, plan?} | {plan_complete}
    GET   /topics      -> Topic[]          POST /topics {name, notes} -> Topic
    POST  /ask         {task_id, topic_id, question, history} -> {answer}
    POST  /quiz        {task_id, topic_id, commitment} -> {questions}
    POST  /quiz/grade  {task_id, topic_id, questions, answers} -> {results, verdict, summary}
*/
(() => {
  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

  const hasGsap = typeof window.gsap !== "undefined";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = hasGsap && !reduceMotion;

  const SCENES = ["situation", "plan", "crunch", "checkin", "progress"];
  const SCENE_NAMES = {
    situation: "Situation",
    plan: "Your plan",
    crunch: "Crunch",
    checkin: "Check-in",
    progress: "Progress",
  };
  const OPEN = new Set(["pending", "in_progress"]);
  const ADDRESSED = new Set(["completed", "partial", "skipped"]);
  const OUTCOME_LABEL = { completed: "Done", partial: "Partly done", skipped: "Didn't happen" };
  const GRADE_LABEL = { correct: "Correct", partial: "Partly", wrong: "Not quite" };
  const RING = 2 * Math.PI * 90;
  const DEFAULT_TITLE = document.title;
  const PREF_FOCUS_LOCK = "crunch-focus-lock";
  const PREF_TAB_TITLE = "crunch-tab-title";

  function readPref(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === "1";
    } catch {
      return fallback;
    }
  }

  function writePref(key, on) {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* storage unavailable: the preference still applies for this visit */
    }
  }

  const prefs = {
    focusLock: readPref(PREF_FOCUS_LOCK, false),
    tabTitle: readPref(PREF_TAB_TITLE, true),
  };

  const state = {
    scene: "situation",
    pendingScene: null,
    transitioning: false,
    unlocked: new Set(["situation"]),
    plan: null,
    lastResult: null,
    crunchTaskId: null,
    commitment: "",
    timer: {
      totalMs: 0,
      remainingMs: 0,
      focusedMs: 0,
      awayMs: 0,
      running: false,
      done: false,
      id: null,
      last: 0,
      hidden: document.hidden,
      awaySince: 0,
    },
    chat: { history: [], topicId: null, busy: false },
    quiz: { taskId: null, questions: [], correct: null, total: null },
    session: { focused: 0, replans: 0, activity: [] },
  };

  const sceneEls = Object.fromEntries(SCENES.map((name) => [name, $(`[data-scene="${name}"]`)]));

  // ---------------- Helpers ----------------
  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = `server returned ${res.status}`;
      try {
        const data = await res.json();
        if (typeof data.detail === "string") detail = data.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    return res.json();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function formatMinutes(total) {
    if (total < 60) return `${total}m`;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  }

  function setError(selector, message) {
    const node = $(selector);
    node.textContent = message;
    node.hidden = !message;
  }

  function setBusy(btn, busy, label) {
    const labelEl = btn.querySelector(".btn-label");
    if (busy) {
      btn.dataset.idleLabel = labelEl.textContent;
      labelEl.textContent = label;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    } else {
      if (btn.dataset.idleLabel) labelEl.textContent = btn.dataset.idleLabel;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }

  function setUrgency(pill, urgency) {
    pill.dataset.urgency = urgency;
    pill.querySelector(".pill-text").textContent = `${cap(urgency)} urgency`;
  }

  function setStarter(badge, task) {
    const isStarter = Boolean(task) && task.duration_minutes <= 10;
    badge.hidden = !isStarter;
    if (isStarter) badge.textContent = `Starter · ${task.duration_minutes} min`;
  }

  // The backend keeps finished tasks in the plan after a replan, so the
  // current task is the first one that is still open.
  const openTasks = () => (state.plan ? state.plan.tasks.filter((t) => OPEN.has(t.status)) : []);
  const currentTask = () => openTasks()[0] || null;
  const addressedCount = () =>
    state.plan ? state.plan.tasks.filter((t) => ADDRESSED.has(t.status)).length : 0;
  const focusedMinutes = () => Math.max(1, Math.round(state.timer.focusedMs / 60000));
  const awayMinutes = () => Math.round(state.timer.awayMs / 60000);

  // ---------------- Scenes ----------------
  function renderSteps() {
    $$(".step").forEach((btn) => {
      const name = btn.dataset.step;
      btn.disabled = !state.unlocked.has(name);
      if (name === state.scene) btn.setAttribute("aria-current", "step");
      else btn.removeAttribute("aria-current");
    });
  }

  function revealScene(scene) {
    const items = $$("[data-stagger]", scene).filter((node) => !node.hidden);
    gsap.fromTo(
      items,
      { autoAlpha: 0, y: 26 },
      { autoAlpha: 1, y: 0, duration: 1.1, stagger: 0.07, ease: "expo.out", clearProps: "opacity,visibility,transform" }
    );
    const rows = $$(".queue li, .activity li", scene);
    if (rows.length) {
      gsap.fromTo(
        rows,
        { autoAlpha: 0, x: -14 },
        { autoAlpha: 1, x: 0, duration: 0.9, stagger: 0.06, delay: 0.35, ease: "expo.out", clearProps: "all" }
      );
    }
  }

  function animateMeter() {
    const meter = $("#stat-meter");
    const target = Number(meter.dataset.value || 0);
    if (animate) {
      gsap.fromTo(meter, { scaleX: 0 }, { scaleX: target, duration: 1.4, delay: 0.4, ease: "expo.out" });
    } else {
      meter.style.transform = `scaleX(${target})`;
    }
  }

  async function goTo(name) {
    if (state.transitioning) {
      state.pendingScene = name;
      return;
    }
    if (name === state.scene) return;

    const from = sceneEls[state.scene];
    const to = sceneEls[name];
    state.transitioning = true;
    state.scene = name;
    state.unlocked.add(name);
    renderSteps();

    if (animate) {
      await gsap.to(from, { autoAlpha: 0, y: -14, duration: 0.45, ease: "power2.in" });
      from.hidden = true;
      gsap.set(from, { clearProps: "opacity,visibility,transform" });
      to.hidden = false;
      to.scrollTop = 0;
      revealScene(to);
    } else {
      from.hidden = true;
      to.hidden = false;
      to.scrollTop = 0;
    }

    if (name === "progress") animateMeter();
    $("#scene-announcer").textContent = `Step ${SCENES.indexOf(name) + 1} of ${SCENES.length}: ${SCENE_NAMES[name]}`;
    const heading = to.querySelector(".scene-title");
    if (heading) heading.focus({ preventScroll: true });

    state.transitioning = false;
    if (state.pendingScene) {
      const next = state.pendingScene;
      state.pendingScene = null;
      goTo(next);
    }
  }

  $$(".step").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.step;
      if ((name === "crunch" || name === "checkin") && !currentTask()) return;
      if (name === "plan") renderPlan();
      if (name === "crunch") prepareCrunch();
      if (name === "checkin") prepareCheckin();
      goTo(name);
    });
  });

  // ---------------- 1 Situation ----------------
  const situationText = $("#situation-text");
  const situationForm = $("#situation-form");

  situationText.addEventListener("input", () => {
    $("#situation-count").textContent = `${situationText.value.length} / 1000`;
    if (situationText.value.trim()) setError("#situation-error", "");
  });

  situationForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const description = situationText.value.trim();
    if (!description) {
      setError("#situation-error", "Tell us what's going on first. Even one line is enough.");
      situationText.focus();
      return;
    }

    const constraints = $("#constraints-text").value.trim();
    const energyInput = $('input[name="energy"]:checked');
    const minutes = parseInt($("#time-available").value, 10);

    // SituationInput has no dedicated fields for these, so they ride along in the description.
    let fullDescription = description;
    if (constraints) fullDescription += `\n\nConstraints to work around: ${constraints}`;
    if (energyInput) fullDescription += `\n\nCurrent energy level: ${energyInput.value}`;

    const btn = $("#btn-analyze");
    setBusy(btn, true, "Building your plan…");
    situationForm.classList.add("is-thinking");
    setError("#situation-api-error", "");

    try {
      const plan = await api("/situation", {
        method: "POST",
        body: { description: fullDescription, available_minutes: minutes },
      });
      startPlan(plan);
    } catch (err) {
      setError(
        "#situation-api-error",
        `Couldn't build a plan (${err.message}). Check that the server is running and GEMINI_API_KEY is set.`
      );
    } finally {
      setBusy(btn, false);
      situationForm.classList.remove("is-thinking");
    }
  });

  function startPlan(plan) {
    state.plan = plan;
    state.lastResult = null;
    state.crunchTaskId = null;
    state.chat.history = [];
    state.session = { focused: 0, replans: 0, activity: [] };
    state.unlocked = new Set(["situation", "plan", "crunch"]);
    resetTimer(0);
    $("#resume").hidden = true;
    renderPlan();
    goTo("plan");
  }

  async function checkResume() {
    try {
      const plan = await api("/plan");
      const next = plan.tasks.find((t) => OPEN.has(t.status));
      if (!next || state.plan) return;
      $("#resume-task").textContent = next.title;
      const card = $("#resume");
      card.hidden = false;
      if (animate) gsap.from(card, { autoAlpha: 0, y: -10, duration: 0.9, ease: "expo.out" });
      $("#btn-resume").onclick = () => startPlan(plan);
    } catch {
      /* 404: no plan yet, nothing to resume */
    }
  }

  // ---------------- 2 Plan ----------------
  function renderQueue(list, tasks, startIndex) {
    list.replaceChildren();
    if (!tasks.length) {
      list.append(el("li", "queue-empty", "Nothing else queued."));
      return;
    }
    tasks.forEach((task, i) => {
      const li = el("li");
      li.append(
        el("span", "q-num", String(startIndex + i)),
        el("span", "q-title", task.title),
        el("span", "q-time", `${task.duration_minutes} min`)
      );
      list.append(li);
    });
  }

  function renderTimeBar(bar, tasks) {
    bar.replaceChildren();
    tasks.forEach((task, i) => {
      const seg = el("span");
      seg.style.flexGrow = String(task.duration_minutes);
      seg.style.opacity = String(Math.max(0.3, 1 - i * 0.18));
      bar.append(seg);
    });
  }

  function renderPlan() {
    if (!state.plan) return;
    const open = openTasks();
    const next = open[0];

    setUrgency($("#plan-urgency"), state.plan.urgency);
    $("#plan-summary").textContent = state.plan.summary;
    $("#plan-next-title").textContent = next ? next.title : "Everything in this plan is done.";
    $("#plan-next-time").textContent = next ? `${next.duration_minutes} min` : "";
    setStarter($("#plan-starter"), next);
    $("#btn-enter-crunch").hidden = !next;
    renderQueue($("#plan-queue"), open.slice(1), 2);

    $("#glance-minutes").textContent = formatMinutes(open.reduce((sum, t) => sum + t.duration_minutes, 0));
    $("#glance-tasks").textContent = String(open.length);
    $("#glance-urgency").textContent = cap(state.plan.urgency);
    renderTimeBar($("#glance-bar"), open);
  }

  $("#btn-enter-crunch").addEventListener("click", () => {
    if (prepareCrunch()) goTo("crunch");
  });

  // ---------------- 3 Crunch: setup + goal ----------------
  const commitInput = $("#commitment");

  function lockCommitment() {
    const value = commitInput.value.trim();
    if (!value) return;
    state.commitment = value;
    $("#goal-text").textContent = value;
    $("#commit-edit").hidden = true;
    $("#goal-display").hidden = false;
  }

  function clearCommitment() {
    state.commitment = "";
    commitInput.value = "";
    $("#commit-edit").hidden = false;
    $("#goal-display").hidden = true;
  }

  commitInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (state.timer.running) lockCommitment();
    else startTimer();
  });

  function prepareCrunch() {
    const task = currentTask();
    if (!task) return false;

    const done = addressedCount();
    $("#crunch-index").textContent = `Step 3 of 5 · Crunch · Task ${done + 1} of ${done + openTasks().length}`;
    setUrgency($("#crunch-urgency"), state.plan.urgency);
    $("#crunch-title").textContent = task.title;
    $("#timer-block").textContent = `${task.duration_minutes} min block`;

    if (state.crunchTaskId !== task.id) {
      state.crunchTaskId = task.id;
      state.chat.history = [];
      resetChat(task);
      resetTimer(task.duration_minutes * 60);
      clearCommitment();
    }
    loadTopics();
    return true;
  }

  // ---------------- 3 Crunch: timer ----------------
  // Time is measured with timestamps, not tick counts, so it stays correct
  // when the browser throttles timers in a background tab.
  const toggleBtn = $("#btn-timer-toggle");
  const lockInput = $("#pref-focus-lock");
  const titleInput = $("#pref-tab-title");
  let awayNoteTimeout = null;

  function setToggle(label, running) {
    toggleBtn.querySelector(".btn-label").textContent = label;
    toggleBtn.querySelector(".icon-play").toggleAttribute("hidden", running);
    toggleBtn.querySelector(".icon-pause").toggleAttribute("hidden", !running);
  }

  function setTimerStatus(text) {
    $("#timer-status").textContent = text;
  }

  function clock() {
    const s = Math.ceil(state.timer.remainingMs / 1000);
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  function account(now) {
    const t = state.timer;
    const used = Math.min(now - t.last, t.remainingMs);
    t.last = now;
    t.remainingMs -= used;
    if (prefs.focusLock && t.hidden) t.awayMs += used;
    else t.focusedMs += used;
  }

  function updateTitle() {
    const t = state.timer;
    let title = DEFAULT_TITLE;
    if (prefs.tabTitle) {
      if (t.running) title = `${clock()} · Focus · CrunchAI`;
      else if (t.done) title = "Time's up · CrunchAI";
      else if (t.focusedMs + t.awayMs > 0) title = `Paused at ${clock()} · CrunchAI`;
    }
    if (document.title !== title) document.title = title;
  }

  function updateFocusStats() {
    const t = state.timer;
    const stats = $("#focus-stats");
    const show = prefs.focusLock && t.focusedMs + t.awayMs >= 1000;
    stats.hidden = !show;
    if (show) stats.textContent = `Focused ${formatDuration(t.focusedMs)} · Away ${formatDuration(t.awayMs)}`;
  }

  function renderTimer() {
    const t = state.timer;
    $("#timer-display").textContent = clock();
    const fraction = t.totalMs ? 1 - t.remainingMs / t.totalMs : 0;
    $("#timer-progress").style.strokeDashoffset = String(RING * (1 - fraction));
    updateTitle();
    updateFocusStats();
  }

  function stopTimer() {
    clearInterval(state.timer.id);
    state.timer.id = null;
    state.timer.running = false;
  }

  function hideAwayNote() {
    clearTimeout(awayNoteTimeout);
    $("#away-note").hidden = true;
  }

  function showAwayNote(ms) {
    if (ms < 5000) return;
    const note = $("#away-note");
    note.textContent = `You were away for ${formatDuration(ms)}. That time doesn't count toward this block.`;
    note.hidden = false;
    clearTimeout(awayNoteTimeout);
    awayNoteTimeout = setTimeout(hideAwayNote, 15000);
  }

  function finishTimer() {
    stopTimer();
    state.timer.done = true;
    setToggle("Restart", false);
    setTimerStatus("Time's up. Wrap up, then tell us how it went.");
  }

  function tick() {
    account(performance.now());
    if (state.timer.remainingMs <= 0) finishTimer();
    renderTimer();
  }

  function startTimer() {
    const t = state.timer;
    if (t.running || !t.totalMs) return;
    if (t.remainingMs <= 0) resetTimer(t.totalMs / 1000);
    lockCommitment();
    t.running = true;
    t.done = false;
    t.last = performance.now();
    t.hidden = document.hidden;
    t.id = setInterval(tick, 250);
    setToggle("Pause", true);
    setTimerStatus("You're in motion");
    renderTimer();
  }

  function pauseTimer() {
    const t = state.timer;
    if (!t.running) return;
    account(performance.now());
    stopTimer();
    setToggle("Resume", false);
    setTimerStatus("Paused");
    renderTimer();
  }

  function resetTimer(totalSeconds) {
    stopTimer();
    Object.assign(state.timer, {
      totalMs: totalSeconds * 1000,
      remainingMs: totalSeconds * 1000,
      focusedMs: 0,
      awayMs: 0,
      done: false,
    });
    hideAwayNote();
    setToggle("Start", false);
    setTimerStatus("Ready when you are");
    renderTimer();
  }

  toggleBtn.addEventListener("click", () => (state.timer.running ? pauseTimer() : startTimer()));
  $("#btn-timer-reset").addEventListener("click", () => resetTimer(state.timer.totalMs / 1000));

  document.addEventListener("visibilitychange", () => {
    const t = state.timer;
    if (t.running) {
      account(performance.now());
      if (document.hidden) t.awaySince = performance.now();
      else if (t.hidden && prefs.focusLock) showAwayNote(performance.now() - t.awaySince);
    }
    t.hidden = document.hidden;
    if (t.running && t.remainingMs <= 0) finishTimer();
    renderTimer();
  });

  lockInput.checked = prefs.focusLock;
  titleInput.checked = prefs.tabTitle;

  lockInput.addEventListener("change", () => {
    if (state.timer.running) account(performance.now());
    prefs.focusLock = lockInput.checked;
    writePref(PREF_FOCUS_LOCK, prefs.focusLock);
    updateFocusStats();
  });

  titleInput.addEventListener("change", () => {
    prefs.tabTitle = titleInput.checked;
    writePref(PREF_TAB_TITLE, prefs.tabTitle);
    updateTitle();
  });

  const fullscreenBtn = $("#btn-fullscreen");
  if (document.fullscreenEnabled) {
    fullscreenBtn.hidden = false;
    fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener("fullscreenchange", () => {
      fullscreenBtn.setAttribute("aria-label", document.fullscreenElement ? "Exit full screen" : "Enter full screen");
    });
  }

  // ---------------- 3 Crunch: topics ----------------
  const topicSelect = $("#topic-select");
  const topicForm = $("#topic-form");
  const topicToggle = $("#btn-topic-toggle");

  async function loadTopics() {
    try {
      const topics = await api("/topics");
      topicSelect.replaceChildren(new Option("No topic selected", ""));
      topics.forEach((topic) => topicSelect.append(new Option(topic.name, String(topic.id))));
      topicSelect.value = state.chat.topicId ? String(state.chat.topicId) : "";
      if (!topicSelect.value) state.chat.topicId = null;
    } catch (err) {
      console.error("Couldn't load topics:", err);
    }
  }

  topicSelect.addEventListener("change", () => {
    state.chat.topicId = topicSelect.value ? Number(topicSelect.value) : null;
  });

  function setTopicFormOpen(open) {
    topicForm.hidden = !open;
    topicToggle.setAttribute("aria-expanded", String(open));
    topicToggle.textContent = open ? "Cancel" : "Add a topic";
    if (open) {
      if (animate) gsap.from(topicForm, { autoAlpha: 0, y: -8, duration: 0.6, ease: "expo.out" });
      $("#topic-name").focus();
    }
  }

  topicToggle.addEventListener("click", () => setTopicFormOpen(topicForm.hidden));

  topicForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#topic-name").value.trim();
    const notes = $("#topic-notes").value.trim();
    if (!name) {
      setError("#topic-error", "Give the topic a name first.");
      $("#topic-name").focus();
      return;
    }

    const btn = $("#btn-topic-save");
    setBusy(btn, true, "Saving…");
    setError("#topic-error", "");
    try {
      const topic = await api("/topics", { method: "POST", body: { name, notes: notes || null } });
      state.chat.topicId = topic.id;
      await loadTopics();
      topicForm.reset();
      setTopicFormOpen(false);
      topicSelect.focus();
    } catch (err) {
      setError("#topic-error", `Couldn't save the topic (${err.message}).`);
    } finally {
      setBusy(btn, false);
    }
  });

  // ---------------- 3 Crunch: chat ----------------
  const chatLog = $("#chat-log");
  const chatInput = $("#chat-input");
  const sendBtn = $("#btn-send");

  // marked would treat "_" and "\[" inside LaTeX as markdown, so math is
  // swapped for placeholders before parsing and restored (escaped) after.
  const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/g;
  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function renderMarkdown(target, text) {
    if (window.marked && window.DOMPurify) {
      const math = [];
      const shielded = text.replace(MATH_PATTERN, (m) => `@@MATH${math.push(m) - 1}@@`);
      const html = marked.parse(shielded).replace(/@@MATH(\d+)@@/g, (_, i) => escapeHtml(math[Number(i)]));
      target.innerHTML = DOMPurify.sanitize(html);
    } else {
      target.textContent = text;
    }
    if (typeof window.renderMathInElement === "function") {
      window.renderMathInElement(target, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    }
  }

  function scrollChat() {
    chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }

  function appendMessage(role, content) {
    const wrap = el("div", `msg msg--${role}`);
    const body = el("div", "msg-body");
    if (role === "assistant") renderMarkdown(body, content);
    else body.textContent = content;
    wrap.append(el("p", "msg-label", role === "user" ? "You" : "CrunchAI"), body);
    chatLog.append(wrap);
    if (animate) gsap.from(wrap, { autoAlpha: 0, y: 14, duration: 0.8, ease: "expo.out" });
    scrollChat();
    return wrap;
  }

  function appendThinking() {
    const wrap = el("div", "msg msg--assistant msg--thinking");
    const body = el("div", "msg-body");
    body.append(el("i"), el("i"), el("i"), el("span", "sr-only", "CrunchAI is thinking"));
    wrap.append(el("p", "msg-label", "CrunchAI"), body);
    chatLog.append(wrap);
    scrollChat();
    return wrap;
  }

  function resetChat(task) {
    chatLog.replaceChildren();
    appendMessage(
      "assistant",
      `Ask me anything about **${task.title}**. I can explain a concept, quiz you, or check your reasoning. Pick or add a topic on the right and I'll use its notes.`
    );
  }

  function autogrow() {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 170)}px`;
  }

  async function sendQuestion() {
    const question = chatInput.value.trim();
    const task = currentTask();
    if (!question || !task || state.chat.busy) return;

    state.chat.busy = true;
    sendBtn.disabled = true;
    appendMessage("user", question);
    // The backend appends the question itself, so history is everything before it.
    const history = state.chat.history.slice();
    state.chat.history.push({ role: "user", content: question });
    chatInput.value = "";
    autogrow();
    const thinking = appendThinking();

    try {
      const data = await api("/ask", {
        method: "POST",
        body: { task_id: task.id, topic_id: state.chat.topicId, question, history },
      });
      thinking.remove();
      appendMessage("assistant", data.answer);
      state.chat.history.push({ role: "assistant", content: data.answer });
    } catch (err) {
      thinking.remove();
      state.chat.history.pop();
      appendMessage("assistant", `Something went wrong (${err.message}). Try asking again.`);
    } finally {
      state.chat.busy = false;
      sendBtn.disabled = false;
      chatInput.focus();
    }
  }

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendQuestion();
  });

  chatInput.addEventListener("input", autogrow);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendQuestion();
    }
  });

  $("#btn-complete").addEventListener("click", () => {
    prepareCheckin();
    goTo("checkin");
  });

  // ---------------- 4 Check-in + Prove-it quiz ----------------
  const quizList = $("#quiz-list");
  const quizBtn = $("#btn-quiz");
  const gradeBtn = $("#btn-quiz-grade");

  function resetQuiz(taskId) {
    state.quiz = { taskId, questions: [], correct: null, total: null };
    quizList.replaceChildren();
    quizList.hidden = true;
    $("#quiz-foot").hidden = true;
    $("#quiz-summary").hidden = true;
    quizBtn.hidden = false;
    gradeBtn.hidden = false;
    setError("#quiz-error", "");
  }

  function prepareCheckin() {
    pauseTimer();
    const task = currentTask();
    if (!task) return;

    let timeLine = `${focusedMinutes()} min focused on this task`;
    if (prefs.focusLock && awayMinutes() > 0) timeLine += ` · ${awayMinutes()} min away`;
    $("#checkin-time").textContent = timeLine;

    $("#checkin-goal").hidden = !state.commitment;
    $("#checkin-goal-text").textContent = state.commitment;

    if (state.quiz.taskId !== task.id) {
      resetQuiz(task.id);
      $('input[name="outcome"][value="partial"]').checked = true;
    }
    setError("#checkin-error", "");
  }

  function renderQuizQuestions() {
    quizList.replaceChildren();
    state.quiz.questions.forEach((question, i) => {
      const li = el("li", "quiz-q");
      const label = el("label", null, `${i + 1}. ${question}`);
      label.htmlFor = `quiz-answer-${i}`;
      const answer = el("textarea");
      answer.id = `quiz-answer-${i}`;
      answer.rows = 2;
      answer.placeholder = "Your answer, from memory";
      const result = el("p", "quiz-result");
      result.hidden = true;
      li.append(label, answer, result);
      quizList.append(li);
    });
  }

  quizBtn.addEventListener("click", async () => {
    const task = currentTask();
    if (!task) return;
    setBusy(quizBtn, true, "Writing questions…");
    setError("#quiz-error", "");
    try {
      const quiz = await api("/quiz", {
        method: "POST",
        body: { task_id: task.id, topic_id: state.chat.topicId, commitment: state.commitment || null },
      });
      state.quiz.questions = quiz.questions;
      renderQuizQuestions();
      quizBtn.hidden = true;
      quizList.hidden = false;
      $("#quiz-foot").hidden = false;
      if (animate) gsap.from(quizList.children, { autoAlpha: 0, y: 12, duration: 0.8, stagger: 0.08, ease: "expo.out" });
      $("#quiz-answer-0").focus();
    } catch (err) {
      setError("#quiz-error", `Couldn't make a quiz (${err.message}).`);
    } finally {
      setBusy(quizBtn, false);
    }
  });

  gradeBtn.addEventListener("click", async () => {
    const task = currentTask();
    if (!task) return;
    const fields = $$("textarea", quizList);
    const answers = fields.map((f) => f.value.trim());
    setBusy(gradeBtn, true, "Checking…");
    setError("#quiz-error", "");
    try {
      const graded = await api("/quiz/grade", {
        method: "POST",
        body: { task_id: task.id, topic_id: state.chat.topicId, questions: state.quiz.questions, answers },
      });
      const items = $$(".quiz-q", quizList);
      graded.results.forEach((result, i) => {
        const line = items[i] && items[i].querySelector(".quiz-result");
        if (!line) return;
        line.replaceChildren(el("span", `grade grade--${result.grade}`, GRADE_LABEL[result.grade]), el("span", null, result.feedback));
        line.hidden = false;
      });
      fields.forEach((f) => (f.readOnly = true));

      state.quiz.total = state.quiz.questions.length;
      state.quiz.correct = graded.results.filter((r) => r.grade === "correct").length;
      $('input[name="outcome"][value="' + graded.verdict + '"]').checked = true;

      const summary = $("#quiz-summary");
      summary.textContent = `${state.quiz.correct} of ${state.quiz.total} correct. ${graded.summary} Suggested: ${OUTCOME_LABEL[graded.verdict]}. You can still change it below.`;
      summary.hidden = false;
      gradeBtn.hidden = true;
      $("#quiz-foot").hidden = true;
    } catch (err) {
      setError("#quiz-error", `Couldn't check your answers (${err.message}).`);
    } finally {
      setBusy(gradeBtn, false);
    }
  });

  $("#btn-quiz-skip").addEventListener("click", () => {
    resetQuiz(state.quiz.taskId);
    $(".options input:checked").focus();
  });

  $("#btn-back-crunch").addEventListener("click", () => goTo("crunch"));

  $("#checkin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const task = currentTask();
    if (!task) return;

    const status = ($('input[name="outcome"]:checked') || { value: "partial" }).value;
    const minutes = focusedMinutes();
    const away = prefs.focusLock ? awayMinutes() : 0;
    const { correct, total } = state.quiz;
    const btn = $("#btn-update-plan");
    setBusy(btn, true, "Updating your plan…");
    setError("#checkin-error", "");

    try {
      const result = await api(`/tasks/${task.id}`, {
        method: "PATCH",
        body: {
          status,
          actual_minutes: minutes,
          commitment: state.commitment || null,
          away_minutes: away || null,
          quiz_correct: total ? correct : null,
          quiz_total: total || null,
        },
      });

      state.session.focused += minutes;
      if (result.replanned) state.session.replans += 1;
      const details = [OUTCOME_LABEL[status]];
      if (total) details.push(`${correct}/${total} on recall`);
      if (away) details.push(`${away}m away`);
      state.session.activity.unshift({ title: task.title, details: details.join(" · "), minutes });

      if (result.replanned && result.plan) state.plan = result.plan;
      else task.status = status;

      state.lastResult = result;
      state.crunchTaskId = null;
      resetTimer(0);

      if (!currentTask()) {
        state.unlocked.delete("crunch");
        state.unlocked.delete("checkin");
      }
      renderProgress();
      goTo("progress");
    } catch (err) {
      setError("#checkin-error", `Couldn't update the plan (${err.message}).`);
    } finally {
      setBusy(btn, false);
    }
  });

  // ---------------- 5 Progress ----------------
  function renderProgress() {
    const result = state.lastResult || {};
    const next = currentTask();
    const open = openTasks();
    const title = $("#progress-title");

    if (!next) {
      title.innerHTML = "All done. <em>Go to sleep.</em>";
      $("#progress-banner").textContent = "You worked through everything in this plan. Start a fresh one whenever the next deadline shows up.";
    } else if (result.replanned) {
      title.innerHTML = "New plan. <em>Same deadline.</em>";
      $("#progress-banner").textContent = state.plan.summary;
    } else {
      title.innerHTML = "<em>Saved.</em>";
      $("#progress-banner").textContent = "Your check-in is logged.";
    }

    $("#progress-next").hidden = !next;
    $("#progress-complete").hidden = Boolean(next);
    if (next) {
      $("#progress-next-title").textContent = next.title;
      $("#progress-next-time").textContent = `${next.duration_minutes} min`;
      setStarter($("#progress-starter"), next);
    }

    $("#progress-queue-wrap").hidden = open.length <= 1;
    renderQueue($("#progress-queue"), open.slice(1), 2);

    const addressed = addressedCount();
    const total = addressed + open.length;
    const pct = total ? Math.round((addressed / total) * 100) : 100;
    $("#stat-pct").textContent = `${pct}%`;
    $("#stat-meter").dataset.value = String(pct / 100);
    $("#stat-minutes").textContent = formatMinutes(state.session.focused);
    $("#stat-addressed").textContent = String(addressed);
    $("#stat-replans").textContent = String(state.session.replans);

    const activity = $("#activity");
    activity.replaceChildren();
    if (!state.session.activity.length) {
      activity.append(el("li", "activity-empty", "No blocks logged yet."));
    }
    state.session.activity.forEach((item) => {
      const li = el("li");
      const text = el("div");
      text.append(el("strong", null, item.title), el("span", "muted", item.details));
      li.append(text, el("span", "muted", `${item.minutes} min`));
      activity.append(li);
    });
  }

  $("#btn-next-block").addEventListener("click", () => {
    if (prepareCrunch()) goTo("crunch");
  });

  $("#btn-new-plan").addEventListener("click", () => {
    state.plan = null;
    state.lastResult = null;
    state.crunchTaskId = null;
    state.unlocked = new Set(["situation"]);
    goTo("situation");
  });

  // ---------------- Boot ----------------
  renderSteps();
  if (animate) {
    gsap.from(".app-nav", { autoAlpha: 0, duration: 1, ease: "power2.out", clearProps: "all" });
    revealScene(sceneEls.situation);
  }
  checkResume();
})();
