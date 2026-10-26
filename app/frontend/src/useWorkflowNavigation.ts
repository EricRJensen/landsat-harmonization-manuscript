import { useEffect, useState, type RefObject } from "react";

/** Track the section being read independently of completion or availability. */
export function useWorkflowNavigation(sections: Array<RefObject<HTMLElement | null>>) {
  const [currentSection, setCurrentSection] = useState(0);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const header = document.querySelector<HTMLElement>(".app-header");
      const headerPosition = header ? getComputedStyle(header).position : "static";
      const headerHeight = header && (headerPosition === "sticky" || headerPosition === "fixed") ? header.getBoundingClientRect().height : 0;
      let current = 0;
      sections.forEach((section, i) => {
        if (section.current && section.current.getBoundingClientRect().top <= headerHeight + 90) current = i;
      });
      setCurrentSection(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [sections]);
  const goToSection = (index: number) => {
    const section = sections[index]?.current;
    if (!section) return;
    const heading = section.querySelector<HTMLElement>("h2") ?? section;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentSection(index);
  };
  return { currentSection, goToSection };
}
