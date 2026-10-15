import type { PanelApi, RobotApi } from "./index";

declare global {
  interface Window {
    robot: RobotApi;
    panel: PanelApi;
  }
}

export {};
