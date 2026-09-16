import { Box } from "@earendil-works/pi-tui";
/**
 * Shared skeleton for boxed custom-message cards (compaction, skill,
 * refinement) with a collapsed/expanded state driven by the shared
 * tool-output expansion toggle.
 */
export declare abstract class ExpandableCustomMessageBox extends Box {
    protected expanded: boolean;
    constructor();
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    protected abstract updateDisplay(): void;
}
/** Bold custom-message label like `[refinement]`. */
export declare function customMessageLabel(name: string): string;
//# sourceMappingURL=expandable-custom-message.d.ts.map