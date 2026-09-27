/*
  landing.js: scroll choreography for index.html.
  Hero intro, showcase frame expansion (pinned), the 11 PM problem
  "chaos to order" (pinned), headline line reveals, how-it-works rows.
  Every hidden start state is applied from JS, so without JS (or with reduced
  motion) the page renders in its final, readable layout.
*/
(() => {
  const root = document.documentElement;
  const releaseIntro = () => root.classList.remove("intro-pending");

  if (!window.gsap || !window.ScrollTrigger || !window.Crunch) {
    releaseIntro();
    return;
  }

  const { reduceMotion, fontsReady } = window.Crunch;

  try {
    navBehavior();
    progressLine();
    if (reduceMotion) {
      releaseIntro();
      return;
    }
    fontsReady.then(() => {
      try {
        init();
      } catch (err) {
        console.error(err);
        releaseIntro();
      }
    });
  } catch (err) {
    console.error(err);
    releaseIntro();
  }

  function init() {
    heroIntro();

    const mm = gsap.matchMedia();
    mm.add("(min-width: 900px)", () => {
      expandDesktop();
      return pileDesktop();
    });
    mm.add("(max-width: 899px)", () => {
      expandMobile();
      return pileMobile();
    });

    splitHeadings();
    reveals();
    movements();
    ScrollTrigger.refresh();
  }

  // ---------------- Nav + progress ----------------
  function navBehavior() {
    const nav = document.getElementById("nav");
    ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate(self) {
        const y = self.scroll();
        nav.classList.toggle("is-scrolled", y > 24);
        nav.classList.toggle("is-hidden", self.direction === 1 && y > window.innerHeight * 0.6);
      },
    });
    nav.addEventListener("focusin", () => nav.classList.remove("is-hidden"));
  }

  function progressLine() {
    gsap.to(".scroll-progress", {
      scaleX: 1,
      ease: "none",
      scrollTrigger: { start: 0, end: "max", scrub: 0.4 },
    });
  }

  // ---------------- Hero ----------------
  function heroIntro() {
    const lines = gsap.utils.toArray(".hero-title .line > span");
    gsap.set(".hero-title", { autoAlpha: 1 });
    gsap.set(lines, { yPercent: 110 });
    gsap.set("[data-intro]", { autoAlpha: 0, y: 18 });
    gsap.set(".showcase", { autoAlpha: 0 });
    gsap.set(".preview", { y: 60 });
    gsap.set("#nav", { autoAlpha: 0 });
    releaseIntro();

    gsap
      .timeline({ defaults: { ease: "expo.out" }, onComplete: heroScroll })
      .to(".hero-mark", { autoAlpha: 1, y: 0, duration: 1.4 }, 0.1)
      .to(".hero-label", { autoAlpha: 1, y: 0, duration: 1.4 }, 0.25)
      .to(lines, { yPercent: 0, duration: 1.6, stagger: 0.12 }, 0.35)
      .to(".hero-sub, .hero-ctas, .hero .hero-micro, .hero-example", { autoAlpha: 1, y: 0, duration: 1.4, stagger: 0.1 }, 0.75)
      .to("#nav", { autoAlpha: 1, duration: 1.2, ease: "power2.out", clearProps: "opacity,visibility" }, 0.9)
      .to(".showcase", { autoAlpha: 1, duration: 1.4, ease: "power2.out" }, 1)
      .to(".preview", { y: 0, duration: 1.8 }, 1);
  }

  function heroScroll() {
    gsap.to(".hero-inner", {
      y: -70,
      autoAlpha: 0.15,
      ease: "none",
      scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: 1 },
    });
  }

  // ---------------- Showcase: frame expansion ----------------
  function expandDesktop() {
    const frame = document.querySelector(".expand-frame");
    const inner = frame.querySelector(".expand-inner");

    gsap
      .timeline({
        scrollTrigger: { trigger: ".expand", start: "top top", end: "+=150%", scrub: 1.2, pin: true },
      })
      .fromTo(
        frame,
        { clipPath: "inset(6% 14% 6% 14% round 18px)" },
        { clipPath: "inset(0% 0% 0% 0% round 0px)", duration: 1, ease: "none" },
        0
      )
      .fromTo(inner, { scale: 1.12 }, { scale: 1, duration: 1, ease: "none" }, 0)
      .fromTo(
        frame.querySelectorAll("[data-float]"),
        { y: 100, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, stagger: 0.14, duration: 0.6, ease: "power2.out" },
        0.45
      )
      .to({}, { duration: 0.3 });
  }

  function expandMobile() {
    gsap.fromTo(
      ".expand-frame",
      { clipPath: "inset(3% 4% 3% 4% round 16px)" },
      {
        clipPath: "inset(0% 0% 0% 0% round 0px)",
        ease: "none",
        scrollTrigger: { trigger: ".expand", start: "top 85%", end: "top 15%", scrub: 1 },
      }
    );
  }

  // ---------------- The 11 PM problem ----------------
  const vw = (v) => () => (window.innerWidth * v) / 100;
  const vh = (v) => () => (window.innerHeight * v) / 100;

  function pileDesktop() {
    const kept = gsap.utils.toArray(".pile .chips .chip");
    const noise = gsap.utils.toArray(".pile .chip--noise");
    const split = SplitText.create(".pile-statement", { type: "words", wordsClass: "word" });

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: ".pile",
        start: "top top",
        end: "+=220%",
        scrub: 1.2,
        pin: true,
        invalidateOnRefresh: true,
      },
    });

    tl.fromTo(split.words, { opacity: 0.15 }, { opacity: 1, duration: 0.4, stagger: 0.05, ease: "none" }, 0)
      .fromTo(".pile-stack", { y: 60 }, { y: 0, duration: 1, ease: "none" }, 0);

    kept.forEach((chip, i) => {
      const d = chip.dataset;
      tl.fromTo(
        chip,
        { x: vw(+d.x), y: vh(+d.y), rotation: +d.r, opacity: 0.7 },
        { x: 0, y: 0, rotation: 0, opacity: 1, duration: 1, ease: "power2.inOut" },
        1 + i * 0.1
      );
    });

    noise.forEach((chip) => {
      const d = chip.dataset;
      tl.fromTo(
        chip,
        { x: vw(+d.x), y: vh(+d.y), rotation: +d.r, opacity: 0.7, scale: 1 },
        { x: vw(+d.x * 1.25), y: vh(+d.y * 1.4), opacity: 0, scale: 0.9, duration: 0.9, ease: "power2.in" },
        1
      );
    });

    tl.fromTo(".pile-caption", { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, 2.05)
      .to({}, { duration: 0.3 });

    return () => split.revert();
  }

  function pileMobile() {
    const split = SplitText.create(".pile-statement", { type: "words", wordsClass: "word" });
    gsap.fromTo(
      split.words,
      { opacity: 0.15 },
      {
        opacity: 1,
        stagger: 0.1,
        ease: "none",
        scrollTrigger: { trigger: ".pile-statement", start: "top 80%", end: "bottom 45%", scrub: 1 },
      }
    );
    gsap.from(".pile .chips .chip", {
      y: 30,
      autoAlpha: 0,
      duration: 1.2,
      stagger: 0.1,
      ease: "expo.out",
      scrollTrigger: { trigger: ".chips", start: "top 85%", once: true },
    });
    return () => split.revert();
  }

  // ---------------- Headline + block reveals ----------------
  function splitHeadings() {
    gsap.utils.toArray("[data-split]").forEach((el) => {
      SplitText.create(el, {
        type: "lines",
        mask: "lines",
        autoSplit: true,
        onSplit(self) {
          return gsap.from(self.lines, {
            yPercent: 110,
            duration: 1.4,
            stagger: 0.1,
            ease: "expo.out",
            scrollTrigger: { trigger: el, start: "top 86%", once: true },
          });
        },
      });
    });
  }

  function reveals() {
    gsap.utils.toArray("[data-reveal]").forEach((el) => {
      gsap.from(el, {
        y: 24,
        autoAlpha: 0,
        duration: 1.3,
        ease: "expo.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      });
    });
  }

  // ---------------- How it works ----------------
  function movements() {
    gsap.utils.toArray(".movement").forEach((row) => {
      gsap
        .timeline({
          defaults: { ease: "expo.out", duration: 1.3 },
          scrollTrigger: { trigger: row, start: "top 84%", once: true },
        })
        .from(row.querySelector(".movement-num"), { y: 20, autoAlpha: 0 })
        .from(row.querySelectorAll(".movement-copy > *"), { y: 24, autoAlpha: 0, stagger: 0.1 }, 0.1)
        .from(row.querySelector(".movement-visual"), { y: 36, autoAlpha: 0 }, 0.2);
    });

    const ring = document.querySelector(".mv-ring-progress");
    if (ring) {
      const length = 2 * Math.PI * 52;
      gsap.fromTo(
        ring,
        { strokeDashoffset: length },
        {
          strokeDashoffset: length * 0.3,
          ease: "none",
          scrollTrigger: { trigger: ".movement--focus", start: "top 80%", end: "bottom 35%", scrub: 1 },
        }
      );
    }

    gsap.from(".mv-grade", {
      autoAlpha: 0,
      x: 8,
      duration: 0.8,
      stagger: 0.35,
      delay: 0.6,
      ease: "power2.out",
      scrollTrigger: { trigger: ".movement--quiz", start: "top 75%", once: true },
    });
  }
})();
