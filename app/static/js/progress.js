/*
  progress.js: the My progress page (progress.html).
  Reads GET /me/progress and renders the stat tiles, a 7-day focus chart
  (one series, hover/focus tooltip, hidden table view), plans with a
  Continue link, and recent blocks. The streak is computed here, in the
  student's own timezone, from each block's UTC completed_at.
*/
(() => {
  const $ = (sel) => document.querySelector(sel);
  const Auth = window.CrunchAuth;
  const OUTCOME = { completed: "Done", partial: "Partly done", skipped: "Didn't happen" };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = typeof window.gsap !== "undefined" && !reduceMotion;

  const pad = (n) => String(n).padStart(2, "0");
  // SQLite CURRENT_TIMESTAMP is UTC without a zone: "YYYY-MM-DD HH:MM:SS".
  const parseUtc = (s) => (s ? new Date(`${s.replace(" ", "T")}Z`) : null);
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatMinutes(total) {
    if (total < 60) return `${total}m`;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function formatWhen(date) {
    if (!date) return "";
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (dayKey(date) === dayKey(today)) return `Today, ${time}`;
    if (dayKey(date) === dayKey(yesterday)) return `Yesterday, ${time}`;
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // ---------------- Tiles ----------------
  function computeStreak(blocks) {
    const days = new Set(
      blocks
        .filter((b) => b.outcome === "completed" || b.outcome === "partial")
        .map((b) => dayKey(parseUtc(b.completed_at)))
    );
    const cursor = new Date();
    const doneToday = days.has(dayKey(cursor));
    if (!doneToday) cursor.setDate(cursor.getDate() - 1);
    let count = 0;
    while (days.has(dayKey(cursor))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { count, doneToday };
  }

  function renderTiles(data) {
    const { totals, blocks } = data;
    const streak = computeStreak(blocks);
    $("#tile-streak").textContent = `${streak.count} ${streak.count === 1 ? "day" : "days"}`;
    $("#tile-streak-note").textContent =
      streak.count === 0
        ? "Finish one block today to start it"
        : streak.doneToday
          ? "Days in a row with a finished block"
          : "Finish a block today to keep it going";

    $("#tile-focus").textContent = formatMinutes(totals.focused_minutes);

    const finished = totals.completed + totals.partial;
    $("#tile-blocks").textContent = String(finished);
    $("#tile-blocks-note").textContent = totals.blocks
      ? `${totals.completed} done, ${totals.partial} partly, ${totals.skipped} missed`
      : "Done or partly done";

    if (totals.recall_total) {
      $("#tile-recall").textContent = `${Math.round((totals.recall_correct / totals.recall_total) * 100)}%`;
      $("#tile-recall-note").textContent = `${totals.recall_correct} of ${totals.recall_total} questions right`;
    }
  }

  // ---------------- 7-day chart ----------------
  function weekSeries(blocks) {
    const series = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      series.push({ key: dayKey(d), date: d, minutes: 0 });
    }
    const byKey = Object.fromEntries(series.map((s) => [s.key, s]));
    blocks.forEach((b) => {
      const slot = byKey[dayKey(parseUtc(b.completed_at))];
      if (slot) slot.minutes += b.actual_minutes || 0;
    });
    return series;
  }

  function renderChart(blocks) {
    const series = weekSeries(blocks);
    const chart = $("#week-chart");
    const tip = $("#chart-tip");
    const max = Math.max(...series.map((s) => s.minutes));
    // Scale to at least an hour so a 1-minute day doesn't draw a full-height bar.
    const scale = Math.max(max, 60);
    const total = series.reduce((sum, s) => sum + s.minutes, 0);
    $("#chart-total").textContent = total ? `${formatMinutes(total)} this week` : "Nothing logged this week yet";

    const peakIndex = max > 0 ? series.findIndex((s) => s.minutes === max) : -1;
    chart.replaceChildren();
    const tbody = $("#week-table tbody");
    tbody.replaceChildren();

    series.forEach((s, i) => {
      const isToday = i === series.length - 1;
      const dayShort = s.date.toLocaleDateString([], { weekday: "short" });
      const dayLong = isToday ? "Today" : s.date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
      const valueText = s.minutes ? formatMinutes(s.minutes) : "0m";

      const col = el("div", "bar-col");
      const hit = el("button", "bar-hit");
      hit.type = "button";
      hit.setAttribute("aria-label", `${dayLong}: ${s.minutes} minutes`);
      const bar = el("span", "bar");
      bar.style.height = s.minutes ? `${Math.max((s.minutes / scale) * 100, 3)}%` : "0%";
      hit.append(bar);
      if ((isToday || i === peakIndex) && s.minutes) {
        const label = el("span", "bar-value", valueText);
        label.style.bottom = bar.style.height;
        hit.append(label);
      }
      const day = el("span", `bar-day${isToday ? " is-today" : ""}`, isToday ? "Today" : dayShort);
      col.append(hit, day);
      chart.append(col);

      const show = () => {
        tip.replaceChildren(el("strong", null, valueText), el("span", null, dayLong));
        tip.hidden = false;
        const chartBox = chart.getBoundingClientRect();
        const hitBox = hit.getBoundingClientRect();
        tip.style.left = `${hitBox.left - chartBox.left + hitBox.width / 2}px`;
      };
      const hide = () => {
        tip.hidden = true;
      };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("blur", hide);

      const row = el("tr");
      row.append(el("td", null, dayLong), el("td", null, String(s.minutes)));
      tbody.append(row);
    });

    if (animate) {
      gsap.from(chart.querySelectorAll(".bar"), {
        scaleY: 0,
        transformOrigin: "50% 100%",
        duration: 1.1,
        stagger: 0.06,
        ease: "expo.out",
        delay: 0.2,
      });
    }
  }

  // ---------------- Lists ----------------
  function renderPlans(plans) {
    const list = $("#plan-list");
    list.replaceChildren();
    if (!plans.length) {
      const empty = el("li", "list-empty");
      empty.append(el("p", null, "No plans yet. Your streak starts with one 5-minute task."));
      const cta = el("a", "btn btn-primary btn-sm", "Get my plan");
      cta.href = "app.html";
      empty.append(cta);
      list.append(empty);
      return;
    }
    plans.forEach((plan) => {
      const li = el("li", "plan-item surface");
      const top = el("div", "plan-item-top");
      top.append(el("span", "muted small", formatWhen(parseUtc(plan.created_at))));
      if (plan.urgency) {
        const pill = el("span", "pill");
        pill.dataset.urgency = plan.urgency;
        pill.append(el("span", "dot"), el("span", null, `${plan.urgency.charAt(0).toUpperCase()}${plan.urgency.slice(1)} urgency`));
        top.append(pill);
      }
      const total = plan.open_tasks + plan.addressed_tasks;
      const meta = el("p", "plan-item-meta muted small", `${plan.addressed_tasks} of ${total} tasks addressed`);
      li.append(top, el("p", "plan-item-summary", plan.summary || "Untitled plan"), meta);

      const foot = el("div", "plan-item-foot");
      if (plan.open_tasks > 0) {
        foot.append(el("span", "plan-next small", plan.next_task ? `Next: ${plan.next_task}` : ""));
        const go = el("a", "btn btn-ghost btn-sm", "Continue");
        go.href = `app.html?plan=${plan.id}`;
        go.setAttribute("aria-label", `Continue plan from ${formatWhen(parseUtc(plan.created_at))}`);
        foot.append(go);
      } else {
        foot.append(el("span", "badge", "Finished"));
      }
      li.append(foot);
      list.append(li);
    });
  }

  function renderBlocks(blocks) {
    const list = $("#block-list");
    list.replaceChildren();
    if (!blocks.length) {
      list.append(el("li", "list-empty", "Finished blocks show up here, with your goal and recall score."));
      return;
    }
    blocks.slice(0, 12).forEach((b) => {
      const li = el("li", "block-item");
      const text = el("div");
      text.append(el("strong", null, b.task_title));
      const details = [OUTCOME[b.outcome] || b.outcome];
      if (b.quiz_total) details.push(`${b.quiz_correct}/${b.quiz_total} on recall`);
      if (b.away_minutes) details.push(`${b.away_minutes}m away`);
      text.append(el("span", "muted small", details.join(" · ")));
      if (b.commitment) text.append(el("span", "block-goal small", `Goal: ${b.commitment}`));
      const side = el("div", "block-side");
      side.append(el("span", "small", `${b.actual_minutes || 0} min`), el("span", "muted small", formatWhen(parseUtc(b.completed_at))));
      li.append(text, side);
      list.append(li);
    });
  }

  // ---------------- Boot ----------------
  async function load() {
    const status = $("#progress-status");
    const user = await Auth.ready;
    if (!user) {
      status.hidden = true;
      $("#guest-gate").hidden = false;
      return;
    }
    try {
      const res = await fetch("/me/progress", { credentials: "same-origin" });
      if (res.status === 401) {
        status.hidden = true;
        $("#guest-gate").hidden = false;
        return;
      }
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const data = await res.json();
      $("#hello").textContent = `Hey ${data.user.username}`;
      renderTiles(data);
      renderChart(data.blocks);
      renderPlans(data.plans);
      renderBlocks(data.blocks);
      status.hidden = true;
      $("#progress-view").hidden = false;
      if (animate) {
        gsap.from("#progress-view > *", { autoAlpha: 0, y: 20, duration: 1, stagger: 0.08, ease: "expo.out", clearProps: "all" });
      }
    } catch (err) {
      status.textContent = `Couldn't load your progress (${err.message}). Refresh to try again.`;
    }
  }

  load();
})();
