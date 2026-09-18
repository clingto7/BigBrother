import { type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/skill-blocks.js";
import { ExpandableCustomMessageBox } from "./expandable-custom-message.js";
/** Skill invocation card; the user message is rendered separately. */
export declare class SkillInvocationMessageComponent extends ExpandableCustomMessageBox {
    private readonly skillBlock;
    private readonly markdownTheme;
    constructor(skillBlock: ParsedSkillBlock, markdownTheme?: MarkdownTheme);
    protected updateDisplay(): void;
}
//# sourceMappingURL=skill-invocation-message.d.ts.map