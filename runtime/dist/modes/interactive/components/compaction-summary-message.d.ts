import { type MarkdownTheme } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { ExpandableCustomMessageBox } from "./expandable-custom-message.js";
/** Compaction summary card: full markdown summary when expanded. */
export declare class CompactionSummaryMessageComponent extends ExpandableCustomMessageBox {
    private readonly message;
    private readonly markdownTheme;
    constructor(message: CompactionSummaryMessage, markdownTheme?: MarkdownTheme);
    protected updateDisplay(): void;
}
//# sourceMappingURL=compaction-summary-message.d.ts.map