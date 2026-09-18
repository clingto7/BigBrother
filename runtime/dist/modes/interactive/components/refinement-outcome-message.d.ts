import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import { ExpandableCustomMessageBox } from "./expandable-custom-message.js";
/** Durable refinement outcome card: per-edit rows with before/after diffs when expanded. */
export declare class RefinementOutcomeMessageComponent extends ExpandableCustomMessageBox {
    private readonly message;
    constructor(message: RefinementOutcomeMessage);
    protected updateDisplay(): void;
}
export declare class MalformedRefinementOutcomeMessageComponent extends ExpandableCustomMessageBox {
    constructor();
    protected updateDisplay(): void;
}
//# sourceMappingURL=refinement-outcome-message.d.ts.map