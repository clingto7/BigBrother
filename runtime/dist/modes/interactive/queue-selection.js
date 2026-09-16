/**
 * Tracks which queued message the user is browsing/editing with alt+up/alt+down.
 *
 * Items are addressed by (lane, index, text): the text is the authoritative
 * check when a mutation is applied, so no ids or revisions are needed. Browsing
 * order is newest-first: draft -> last followUp -> ... -> first steering.
 */
export class QueueSelection {
    items = [];
    cursor = -1; // -1 = draft
    draft = "";
    hasStashedDraft = false;
    get selected() {
        return this.cursor >= 0 ? this.items[this.cursor] : undefined;
    }
    get isBrowsing() {
        return this.cursor >= 0;
    }
    get hasDraft() {
        return this.hasStashedDraft;
    }
    replaceDraft(draft) {
        this.draft = draft;
        this.hasStashedDraft = true;
    }
    /** Move the cursor. -1 browses older, +1 newer. Returns the text to show, or undefined for a boundary noop. */
    move(queue, draft, direction) {
        if (this.cursor < 0) {
            if (direction > 0)
                return undefined;
            this.items = flatten(queue);
            if (this.items.length === 0)
                return undefined;
            if (!this.hasStashedDraft) {
                this.draft = draft;
                this.hasStashedDraft = true;
            }
            this.cursor = this.items.length - 1;
            return this.items[this.cursor]?.text;
        }
        const next = this.cursor + direction;
        if (next < 0 || next > this.items.length)
            return undefined;
        if (next === this.items.length) {
            return this.reset();
        }
        this.cursor = next;
        return this.items[next]?.text;
    }
    refreshAt(queue, lane, index, expectedText) {
        this.items = flatten(queue);
        const cursor = lane === "steering" ? index : queue.steering.length + index;
        const selected = this.items[cursor];
        if (selected?.lane !== lane || selected.index !== index || selected.text !== expectedText)
            return this.reset();
        this.cursor = cursor;
    }
    /** Called after a mutation or submit resolved the selection. Returns the stashed draft. */
    reset() {
        this.cursor = -1;
        const draft = this.draft;
        this.draft = "";
        this.hasStashedDraft = false;
        return draft;
    }
}
function flatten(queue) {
    return [
        ...queue.steering.map((text, index) => ({ lane: "steering", index, text })),
        ...queue.followUp.map((text, index) => ({ lane: "followUp", index, text })),
    ];
}
//# sourceMappingURL=queue-selection.js.map