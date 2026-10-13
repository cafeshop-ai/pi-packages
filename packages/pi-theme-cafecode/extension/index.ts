/**
  * This package is organized in four layers:
  *   1. theme files loaded by Pi
  *   2. banner, spinner, status line, and turn footer
  *   3. compact tool and diff rendering
  *   4. thinking and prompt presentation
  *
  * The implementation uses Pi's public extension APIs, with a small compatibility
  * layer for rendering behaviors that are not yet exposed as extension hooks.
  */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installHostPatches } from "./host-patches.js";
import { registerSpinner } from "./spinner.js";
import { registerTurnFooter } from "./turn-footer.js";
import { registerBanner } from "./banner.js";
import { registerStatusLine } from "./status-line.js";
import { registerGrouping } from "./tools/grouping.js";
import { registerBuiltins } from "./tools/builtins.js";
import { registerCommands } from "./commands.js";
import { registerThinking } from "./thinking.js";
import { registerPromptPointer } from "./prompt-editor.js";

export default function registerCafeCodeTheme(pi: ExtensionAPI) {
  // Compatibility hooks for rendering details not currently exposed by Pi.
  installHostPatches();

  registerSpinner(pi);
  registerTurnFooter(pi);
  registerBanner(pi);
  registerStatusLine(pi);
  registerPromptPointer(pi);

  registerGrouping(pi);
  registerBuiltins(pi);
  registerThinking(pi);
  registerCommands(pi);
}
