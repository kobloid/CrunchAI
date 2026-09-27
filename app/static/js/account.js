/*
  account.js: the Log in / Sign up page (account.html).
  ?mode=login|signup picks the tab, ?next=page.html is where to go after
  (same-site pages only, see CrunchAuth.safeNext). Validation mirrors the
  backend so people see a clear message before the round trip.
*/
(() => {
  const $ = (sel) => document.querySelector(sel);
  const Auth = window.CrunchAuth;
  const params = new URLSearchParams(window.location.search);
  const next = Auth.safeNext(params.get("next"));
  const USERNAME = /^[A-Za-z0-9_.]{3,24}$/;

  const COPY = {
    login: {
      title: "Welcome back.",
      sub: "Your plan is right where you left it.",
      submit: "Log in",
      busy: "Logging in…",
      doc: "CrunchAI · Log in",
    },
    signup: {
      title: "Save your progress.",
      sub: "Free. Keep your plans, streak, and study history on any device.",
      submit: "Create account",
      busy: "Creating your account…",
      doc: "CrunchAI · Sign up",
    },
  };

  const form = $("#auth-form");
  const username = $("#auth-username");
  const password = $("#auth-password");
  const submit = $("#auth-submit");
  let mode = params.get("mode") === "signup" ? "signup" : "login";

  function setError(message, field) {
    const box = $("#auth-error");
    box.textContent = message || "";
    box.hidden = !message;
    [username, password].forEach((input) => input.removeAttribute("aria-invalid"));
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }

  function setMode(nextMode) {
    mode = nextMode;
    const copy = COPY[mode];
    $("#auth-title").textContent = copy.title;
    $("#auth-sub").textContent = copy.sub;
    submit.querySelector(".btn-label").textContent = copy.submit;
    document.title = copy.doc;
    password.autocomplete = mode === "signup" ? "new-password" : "current-password";
    $("#username-help").hidden = mode !== "signup";
    $("#password-help").hidden = mode !== "signup";
    const hasGuestWork = Auth.guestPlanId() || Auth.guestTopicIds().length;
    $("#claim-note").hidden = !hasGuestWork;
    document.querySelectorAll("[role='tab']").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
    });
    setError("");
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    window.history.replaceState(null, "", url);
  }

  document.querySelectorAll("[role='tab']").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const other = tab.dataset.mode === "login" ? "signup" : "login";
      setMode(other);
      $(`#tab-${other}`).focus();
    });
  });

  $("#password-toggle").addEventListener("click", (e) => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(show));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = username.value.trim();
    const pass = password.value;

    if (!name) return setError("Enter your username.", username);
    if (mode === "signup" && !USERNAME.test(name)) {
      return setError("Usernames are 3 to 24 letters, numbers, dots, or underscores.", username);
    }
    if (!pass) return setError("Enter your password.", password);
    if (mode === "signup" && pass.length < 8) return setError("Passwords need at least 8 characters.", password);

    const label = submit.querySelector(".btn-label");
    label.textContent = COPY[mode].busy;
    submit.disabled = true;
    setError("");
    try {
      await (mode === "signup" ? Auth.signup(name, pass) : Auth.login(name, pass));
      window.location.assign(next);
    } catch (err) {
      const field = err.status === 409 || err.status === 422 ? username : err.status === 401 ? password : null;
      setError(err.message, field);
      label.textContent = COPY[mode].submit;
      submit.disabled = false;
    }
  });

  $("#btn-signout").addEventListener("click", async () => {
    await Auth.logout();
    window.location.reload();
  });

  setMode(mode);
  Auth.ready.then((user) => {
    if (!user) {
      username.focus();
      return;
    }
    $("#auth-card").hidden = true;
    $("#signed-in").hidden = false;
    $("#signed-in-name").textContent = user.username;
    document.title = "CrunchAI · Your account";
  });
})();
