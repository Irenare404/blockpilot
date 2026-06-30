import { chatIntentsPlugin } from "./chat-intents.js";
import { coreActionsPlugin } from "./core-actions.js";
import { reportPositionPlugin } from "./report-position.js";
import type { WorkerPlugin } from "../plugin-runtime.js";

export const builtInPlugins: WorkerPlugin[] = [coreActionsPlugin, chatIntentsPlugin, reportPositionPlugin];
