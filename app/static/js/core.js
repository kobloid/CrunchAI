/*
  core.js: shared by index.html and app.html.
  Theme toggle, GSAP plugin registration, Lenis smooth scroll (pages that opt in
  with <body data-smooth>), custom cursor, and magnetic focal buttons.
  Exposes window.Crunch = { reduceMotion, finePointer, lenis, fontsReady }.
*/
(() => {
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const hasGsap = typeof window.gsap !== "undefined";

  const Crunch = (window.Crunch = {
    reduceMotion,
    finePointer,
    lenis: null,
    fontsReady: Promise.race([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]),
  });

  // ---------------- Theme ----------------
  const THEME_KEY = "crunch-theme";

  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  }

  function syncToggles() {
    const theme = root.dataset.theme;
    const next = theme === "dark" ? "light" : "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(theme === "dark"));
      btn.setAttribute("aria-label", `Switch to ${next} mode`);
    });
  }

  function setTheme(theme, persist) {
    root.classList.add("theme-anim");
    root.dataset.theme = theme;
    syncToggles();
    window.setTimeout(() => root.classList.remove("theme-anim"), 800);
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* storage unavailable: theme still applies for this page view */
      }
    }
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
    });
  });

  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
    if (!storedTheme()) setTheme(e.matches ? "light" : "dark", false);
  });

  syncToggles();

  if (!hasGsap) return;

  // ---------------- GSAP + Lenis ----------------
  const plugins = [window.ScrollTrigger, window.SplitText].filter(Boolean);
  if (plugins.length) gsap.registerPlugin(...plugins);

  if ("smooth" in document.body.dataset && window.Lenis && window.ScrollTrigger && !reduceMotion) {
    const lenis = new Lenis({
      duration: 1.5,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 0.9,
    });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
    Crunch.lenis = lenis;
  }

  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const id = link.getAttribute("href");
      const target = id.length > 1 && document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      if (Crunch.lenis) {
        Crunch.lenis.scrollTo(target, { duration: 2.2 });
      } else {
        target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
      }
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    });
  });

  // ---------------- Custom cursor ----------------
  if (finePointer && !reduceMotion) {
    const dot = document.createElement("div");
    const ring = document.createElement("div");
    dot.className = "cursor-dot";
    ring.className = "cursor-ring";
    dot.setAttribute("aria-hidden", "true");
    ring.setAttribute("aria-hidden", "true");
    document.body.append(dot, ring);
    root.classList.add("has-cursor");

    const dotX = gsap.quickTo(dot, "x", { duration: 0.12, ease: "power3" });
    const dotY = gsap.quickTo(dot, "y", { duration: 0.12, ease: "power3" });
    const ringX = gsap.quickTo(ring, "x", { duration: 0.45, ease: "power3" });
    const ringY = gsap.quickTo(ring, "y", { duration: 0.45, ease: "power3" });
    let visible = false;

    window.addEventListener("pointermove", (e) => {
      dotX(e.clientX);
      dotY(e.clientY);
      ringX(e.clientX);
      ringY(e.clientY);
      if (!visible) {
        visible = true;
        gsap.to([dot, ring], { opacity: 1, duration: 0.5 });
      }
    });

    document.documentElement.addEventListener("pointerleave", () => {
      visible = false;
      gsap.to([dot, ring], { opacity: 0, duration: 0.5 });
    });

    window.addEventListener("pointerdown", () => ring.classList.add("is-down"));
    window.addEventListener("pointerup", () => ring.classList.remove("is-down"));

    const INTERACTIVE = "a, button, select, label, [role='radio'], [data-cursor]";
    const TEXT = "input[type='text'], textarea";

    document.addEventListener("pointerover", (e) => {
      const textField = e.target.closest(TEXT);
      const hit = !textField && e.target.closest(INTERACTIVE);
      dot.classList.toggle("is-text", Boolean(textField));
      ring.classList.toggle("is-text", Boolean(textField));
      ring.classList.toggle("is-hover", Boolean(hit));
    });
  }

  // ---------------- Magnetic focal buttons ----------------
  Crunch.magnetize = (scope = document) => {
    if (!finePointer || reduceMotion) return;
    scope.querySelectorAll("[data-magnetic]:not([data-magnetized])").forEach((el) => {
      el.dataset.magnetized = "";
      const xTo = gsap.quickTo(el, "x", { duration: 0.8, ease: "power3" });
      const yTo = gsap.quickTo(el, "y", { duration: 0.8, ease: "power3" });
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.18);
        yTo((e.clientY - r.top - r.height / 2) * 0.18);
      });
      el.addEventListener("pointerleave", () => {
        xTo(0);
        yTo(0);
      });
    });
  };

  Crunch.magnetize();
})();
