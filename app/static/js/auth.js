/*
  auth.js: accounts on every page (guest first).
  Knows who is logged in (GET /me), renders the nav account slot
  ([data-account]), and remembers a guest's plan and topics in localStorage
  so they can be claimed when the guest signs up or logs in.
  Exposes window.CrunchAuth; CrunchAuth.ready resolves once /me has answered.
*/
(() => {
  const PLAN_KEY = "crunch-guest-plan";
  const TOPICS_KEY = "crunch-guest-topics";

  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: guest work just won't be claimable */
    }
  }

  async function request(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) {
      const err = new Error(data && typeof data.detail === "string" ? data.detail : `server returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const listeners = new Set();

  const Auth = (window.CrunchAuth = {
    user: null,
    ready: null,
    onChange(fn) {
      listeners.add(fn);
    },
    guestPlanId: () => read(PLAN_KEY, null),
    guestTopicIds: () => read(TOPICS_KEY, []),
    rememberGuestPlan(id) {
      if (!Auth.user) write(PLAN_KEY, id);
    },
    rememberGuestTopic(id) {
      if (!Auth.user) write(TOPICS_KEY, [...new Set([...Auth.guestTopicIds(), id])]);
    },
    async refresh() {
      try {
        const data = await request("/me");
        setUser(data.user);
      } catch {
        setUser(null);
      }
      return Auth.user;
    },
    login: (username, password) =>
      request("/login", { method: "POST", body: { username, password, ...claim() } }).then(signedIn),
    signup: (username, password) =>
      request("/signup", { method: "POST", body: { username, password, ...claim() } }).then(signedIn),
    async logout() {
      await request("/logout", { method: "POST" });
      setUser(null);
    },
    // Only same-site pages are allowed as a post-login destination (no open redirects).
    safeNext(next) {
      return /^[a-z0-9-]+\.html(\?[\w=&-]*)?$/i.test(next || "") ? next : "app.html?resume=1";
    },
  });

  function claim() {
    return { claim_plan_id: Auth.guestPlanId(), claim_topic_ids: Auth.guestTopicIds() };
  }

  function signedIn(user) {
    write(PLAN_KEY, null);
    write(TOPICS_KEY, null);
    setUser(user);
    return user;
  }

  function setUser(user) {
    Auth.user = user || null;
    renderNav();
    listeners.forEach((fn) => fn(Auth.user));
  }

  // ---------------- Nav account slot ----------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function loginHref(slot) {
    const next = slot.dataset.next || "app.html?resume=1";
    return `account.html?mode=login&next=${encodeURIComponent(next)}`;
  }

  function renderNav() {
    document.querySelectorAll("[data-account]").forEach((slot) => {
      slot.replaceChildren();
      if (!Auth.user) {
        const link = el("a", "nav-link", "Log in");
        link.href = loginHref(slot);
        slot.append(link);
        return;
      }

      const menu = el("div", "account-menu");
      const button = el("button", "account-btn");
      button.type = "button";
      button.setAttribute("aria-haspopup", "true");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", `Account menu for ${Auth.user.username}`);
      button.append(el("span", "avatar", Auth.user.username.charAt(0).toUpperCase()), el("span", "account-name", Auth.user.username));

      const pop = el("div", "account-pop");
      pop.hidden = true;
      const who = el("p", "account-pop-who", "Signed in as ");
      who.append(el("strong", null, Auth.user.username));
      const progress = el("a", "account-pop-item", "My progress");
      progress.href = "progress.html";
      const studyRoom = el("a", "account-pop-item", "Study room");
      studyRoom.href = "app.html?resume=1";
      const logout = el("button", "account-pop-item", "Log out");
      logout.type = "button";
      pop.append(who, progress, studyRoom, logout);
      menu.append(button, pop);
      slot.append(menu);

      const close = (returnFocus) => {
        pop.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (returnFocus) button.focus();
      };
      button.addEventListener("click", () => {
        const open = pop.hidden;
        pop.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
        if (open) progress.focus();
      });
      menu.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close(true);
      });
      document.addEventListener("click", (e) => {
        if (!menu.contains(e.target)) close(false);
      });
      logout.addEventListener("click", async () => {
        logout.disabled = true;
        try {
          await Auth.logout();
        } finally {
          window.location.reload();
        }
      });
    });
  }

  Auth.ready = Auth.refresh();
})();
