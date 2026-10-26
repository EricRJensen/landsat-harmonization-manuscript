import { useEffect, useState, type RefObject } from "react";
export function focusSection(element: HTMLElement | null) {
  if (!element) return;
  const heading = element.querySelector<HTMLElement>("h2") ?? element;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  element.scrollIntoView({ behavior: "smooth", block: "start" });
}
export function useVisibleStep(refs: RefObject<HTMLElement | null>[], enabled = true) {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const headerElement = document.querySelector<HTMLElement>(".app-header");
        const headerPosition = headerElement ? getComputedStyle(headerElement).position : "static";
        const header = headerElement && ["sticky", "fixed"].includes(headerPosition) ? headerElement.getBoundingClientRect().height : 0;
        let nearest = 0, distance = Infinity;
        refs.forEach((ref, i) => {
          if (!ref.current) return;
          const bounds = ref.current.getBoundingClientRect();
          if (bounds.bottom <= header) return;
          const next = bounds.top <= header + 80 ? 0 : Math.abs(bounds.top - header - 80);
          if (next < distance) { nearest = i; distance = next; }
        });
        setCurrent(nearest);
      });
    };
    update(); window.addEventListener("scroll", update, { passive: true }); window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [enabled, ...refs]);
  return current;
}
