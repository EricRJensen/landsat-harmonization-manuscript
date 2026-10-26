import { useEffect, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import type { ECharts } from "echarts/core";

/** Keep the optional chart library and canvas work off the initial loading path. */
export function ChartCanvas({ option, className, ariaLabel, describedBy }: {
  option: EChartsOption;
  className: string;
  ariaLabel: string;
  describedBy?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let active = true;
    let chart: ECharts | undefined;
    let resize: ResizeObserver | undefined;
    let resizeFrame: number | undefined;
    const load = async () => {
      try {
        const { init } = await import("../charting");
        if (!active) return;
        setError(false);
        chart = init(element);
        chart.setOption(option);
        resize = new ResizeObserver(() => {
          if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; chart?.resize(); });
        });
        resize.observe(element);
      } catch {
        if (active) setError(true);
      }
    };
    const visible = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      visible.disconnect();
      void load();
    }, { rootMargin: "200px" });
    visible.observe(element);
    return () => {
      active = false;
      visible.disconnect();
      resize?.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      chart?.dispose();
    };
  }, [option]);

  return <div ref={container} className={className} role="img" aria-label={ariaLabel} aria-describedby={describedBy}>
    {error && <p role="status">The chart could not load. Refresh the page to try again.</p>}
  </div>;
}
