// Load only the chart types and components used by the Explorer.
import { init, use } from "echarts/core";
import { BarChart, BoxplotChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([BarChart, BoxplotChart, LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

export { init };
