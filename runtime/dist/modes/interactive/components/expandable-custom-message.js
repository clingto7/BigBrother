import { Box } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
/**
 * Shared skeleton for boxed custom-message cards (compaction, skill,
 * refinement) with a collapsed/expanded state driven by the shared
 * tool-output expansion toggle.
 */
export class ExpandableCustomMessageBox extends Box {
    expanded = false;
    constructor() {
        super(1, 1, (t) => theme.bg("customMessageBg", t));
    }
    setExpanded(expanded) {
        if (this.expanded === expanded)
            return;
        this.expanded = expanded;
        this.updateDisplay();
    }
    invalidate() {
        super.invalidate();
        this.updateDisplay();
    }
}
/** Bold custom-message label like `[refinement]`. */
export function customMessageLabel(name) {
    return theme.fg("customMessageLabel", `\x1b[1m[${name}]\x1b[22m`);
}
//# sourceMappingURL=expandable-custom-message.js.map