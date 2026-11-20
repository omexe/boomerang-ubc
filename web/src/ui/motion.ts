// Everything GSAP and Lenis for the landing page, from the mockup's last script. One call wires it
// all up over the page's root element and hands back a teardown, so React can start it on mount and
// undo it on unmount; it is safe to run twice in a row (StrictMode's double mount). Nothing here
// runs under prefers-reduced-motion: reduce, where the page shows its finished state through CSS.
import { gsap } from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

// The one live smooth-scroll instance while the landing page is mounted; the nav scrolls through it.
let lenis: Lenis | null = null;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Start the landing page's motion over `root` (the `.landing` element). Returns a teardown that
 * reverts every tween and ScrollTrigger, destroys the smooth scroll, and drops the ticker callback.
 */
export function mountLanding(root: HTMLElement): () => void {
  if (prefersReducedMotion()) return () => {};

  // Smooth scroll, driven by GSAP's ticker so ScrollTrigger and Lenis share one clock.
  const instance = new Lenis({ lerp: 0.11, smoothWheel: true });
  lenis = instance;
  instance.on("scroll", ScrollTrigger.update);
  const raf = (time: number) => instance.raf(time * 1000);
  gsap.ticker.add(raf);
  gsap.ticker.lagSmoothing(0);

  // Kept so unmount tears down the pinned ScrollTrigger even if the context does not reach it.
  let mm: ReturnType<typeof gsap.matchMedia> | null = null;

  const ctx = gsap.context(() => {
    const q = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel);
    const qa = <T extends Element>(sel: string): T[] => Array.from(root.querySelectorAll<T>(sel));

    // Arrival, in reading order: the headline rises line by line, the lede follows, then the cheque,
    // then the trust marks. (The rosette on the right traces itself in from the flight scene's own code.)
    gsap
      .timeline({ defaults: { ease: "expo.out" } })
      .from(qa("h1 .line > span"), { yPercent: 105, duration: 1.1, stagger: 0.09 })
      .from(q(".lede"), { y: 14, opacity: 0, duration: 0.9 }, 0.35)
      .from(q(".hero-cheque"), { y: 22, opacity: 0, duration: 1.0 }, 0.5)
      .from(qa(".trust span"), { opacity: 0, y: 6, duration: 0.7, stagger: 0.06 }, 0.75);

    // How it works: on wide screens the board is pinned and scrubbed, so the eye stays on one board
    // as the four steps play out. On narrow screens and under reduced motion the board shows its
    // finished missed story through CSS, so no timeline runs there.
    mm = gsap.matchMedia();
    mm.add("(min-width: 901px)", () => {
      const how = q<HTMLElement>(".how");
      const steps = qa<HTMLElement>(".steps li");
      const raised = q<HTMLElement>(".raised");
      if (!how || steps.length === 0 || !raised) return;

      const num = { v: 0 };
      raised.textContent = "0.00";
      const count = (v: number) => ({
        v,
        duration: 0.4,
        onUpdate: () => {
          raised.textContent = num.v.toFixed(2);
        },
      });
      const setStep = (n: number) => steps.forEach((li, i) => li.classList.toggle("on", i === n));

      gsap.set(qa(".pledges li"), { opacity: 0, x: 30 });
      gsap.set(qa(".seal"), { scale: 1.6, opacity: 0 });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: how,
          start: "top top",
          end: "+=2600",
          pin: true,
          scrub: 0.7,
          onUpdate: (st) => setStep(Math.min(3, Math.floor(st.progress * 4))),
        },
        defaults: { ease: "power2.out" },
      });
      tl.to(qa(".seal"), { scale: 1, opacity: 1, duration: 0.5, stagger: 0.25 })
        .to({}, { duration: 0.6 })
        .to(qa(".pledges .p1"), { opacity: 1, x: 0, duration: 0.4 })
        .to(num, count(2), "<")
        .to(q(".bar i"), { scaleX: 2 / 3, duration: 0.4 }, "<")
        .to(qa(".pledges .p2"), { opacity: 1, x: 0, duration: 0.4 })
        .to(num, count(3), "<")
        .to(q(".bar i"), { scaleX: 1, duration: 0.4 }, "<")
        .fromTo(q(".stamp.cleared"), { scale: 2.2, opacity: 0 }, { opacity: 1, scale: 1, duration: 0.25, ease: "expo.out" })
        .to({}, { duration: 0.7 })
        .to(q(".stamp.cleared"), { opacity: 0, duration: 0.2 })
        .to(qa(".pledges .p1, .pledges .p2"), { opacity: 0, x: -20, duration: 0.3 }, "<")
        .to(qa(".pledges .p3"), { opacity: 1, x: 0, duration: 0.4 })
        .to(num, count(1.5), "<")
        .to(q(".bar i"), { scaleX: 0.5, backgroundColor: "#b8352a", duration: 0.4 }, "<")
        .fromTo(q(".stamp.returned"), { scale: 2.2, opacity: 0 }, { opacity: 1, scale: 1, duration: 0.25, ease: "expo.out" })
        .to({}, { duration: 0.6 });

      // Back to the finished missed figure if the viewport narrows and CSS takes over the board.
      return () => {
        raised.textContent = "1.50";
      };
    });

    // The ledger and its stamps enter once, when first scrolled into view. They wait hidden from the
    // start (a from() tween renders its first frame at once), so nothing shows and then blinks out.
    // A row React adds later was never hidden, and the teardown's revert clears the rest.
    const ledger = q<HTMLElement>("#ledger");
    if (ledger) {
      gsap.from(qa(".lrow:not(.headrow)"), {
        opacity: 0,
        y: 16,
        duration: 0.8,
        ease: "expo.out",
        stagger: 0.07,
        scrollTrigger: { trigger: ledger, start: "top 72%", once: true },
      });
      gsap.from(qa(".lrow .mark-out"), {
        scale: 2,
        opacity: 0,
        rotate: -14,
        duration: 0.45,
        ease: "expo.out",
        stagger: 0.12,
        delay: 0.35,
        scrollTrigger: { trigger: ledger, start: "top 72%", once: true },
      });
    }

    const guarantee = q<HTMLElement>("#guarantee");
    if (guarantee) {
      gsap.from(qa(".facts p"), {
        opacity: 0,
        y: 14,
        duration: 0.8,
        stagger: 0.08,
        ease: "expo.out",
        scrollTrigger: { trigger: guarantee, start: "top 70%", once: true },
      });
    }
  }, root);

  // The cheque grows and shrinks as people type, which moves everything below it; a debounced refresh
  // keeps the pinned section and the scroll triggers measuring against the hero's real height.
  const hero = root.querySelector<HTMLElement>(".hero");
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const observer = new ResizeObserver(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => ScrollTrigger.refresh(), 200);
  });
  if (hero) observer.observe(hero);

  return () => {
    observer.disconnect();
    if (debounce) clearTimeout(debounce);
    gsap.ticker.remove(raf);
    mm?.revert(); // revert, not kill: only a revert takes the pinned section back out of its spacer
    ctx.revert();
    instance.destroy();
    if (lenis === instance) lenis = null;
    gsap.ticker.lagSmoothing(500, 33);
  };
}

/** Scroll to the section with this id, landing 72px above it, through the live smooth scroll when
 *  there is one and otherwise directly (not smoothly when motion is reduced). The nav calls this. */
export function scrollToSection(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (lenis) {
    lenis.scrollTo(el, { offset: -72 });
    return;
  }
  const top = el.getBoundingClientRect().top + window.scrollY - 72;
  window.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}
