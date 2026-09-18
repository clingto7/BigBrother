import { getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
import { getMenuListLayout, MenuList, MenuPanel, MenuRow } from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";
const HEARTBEAT_PANEL_MAX_WIDTH = 72;
const PREFERRED_VISIBLE_HEARTBEATS = 8;
const HEARTBEAT_LIST_RESERVED_ROWS = 7;
const HEARTBEAT_SCROLL_INDICATOR_ROWS = 1;
export class HeartbeatManagerComponent {
    options;
    selectedHeartbeatId;
    mode = { type: "list" };
    busy = false;
    error;
    _focused = false;
    constructor(options) {
        this.options = options;
    }
    get focused() {
        return this._focused;
    }
    set focused(value) {
        this._focused = value;
    }
    invalidate() { }
    get heartbeats() {
        return [...this.options.getHeartbeats()].sort((left, right) => {
            const sessionOrder = this.sessionLabel(left).localeCompare(this.sessionLabel(right));
            if (sessionOrder !== 0)
                return sessionOrder;
            if (left.job.source !== right.job.source)
                return left.job.source === "heartbeat" ? -1 : 1;
            return left.job.createdAt.localeCompare(right.job.createdAt);
        });
    }
    handleInput(data) {
        if (this.busy)
            return;
        const keybindings = getKeybindings();
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.heartbeats.open")) {
            this.options.onClose();
            return;
        }
        if (shouldTreatAsBack(data)) {
            if (this.mode.type === "list") {
                this.options.onClose();
            }
            else {
                this.mode = { type: "list" };
                this.error = undefined;
                this.options.requestRender();
            }
            return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
            this.moveSelection(-1);
            return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
            this.moveSelection(1);
            return;
        }
        if (this.mode.type === "list" && keybindings.matches(data, "app.heartbeats.openSelected")) {
            void this.confirmSelection();
            return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
            void this.confirmSelection();
        }
    }
    render(width) {
        const heartbeats = this.heartbeats;
        if (!heartbeats.some((heartbeat) => heartbeat.job.id === this.selectedHeartbeatId)) {
            this.selectedHeartbeatId = heartbeats[0]?.job.id;
        }
        if (this.mode.type !== "list") {
            const heartbeatId = this.mode.heartbeatId;
            if (!heartbeats.some((heartbeat) => heartbeat.job.id === heartbeatId))
                this.mode = { type: "list" };
        }
        const panel = this.mode.type === "list" ? this.createHeartbeatListPanel() : this.createActionPanel(this.mode);
        const safeWidth = Math.max(1, width);
        const panelWidth = Math.min(safeWidth, HEARTBEAT_PANEL_MAX_WIDTH);
        const leftPadding = Math.max(0, Math.floor((safeWidth - panelWidth) / 2));
        const rightPadding = Math.max(0, safeWidth - panelWidth - leftPadding);
        return panel.render(panelWidth).map((line) => " ".repeat(leftPadding) + line + " ".repeat(rightPadding));
    }
    createHeartbeatListPanel() {
        const active = this.heartbeats.filter((heartbeat) => heartbeat.job.status === "active").length;
        const paused = this.heartbeats.length - active;
        const countLabel = `${this.heartbeats.length} heartbeat${this.heartbeats.length === 1 ? "" : "s"}${paused ? ` · ${paused} paused` : ""}`;
        const panel = new MenuPanel({
            title: "Heartbeats",
            subtitle: `${countLabel}. Select a heartbeat to manage.`,
        });
        const list = new MenuList({ compact: this.getListLayout().compact });
        this.populateHeartbeatList(list);
        panel.addChild(list);
        if (this.error) {
            panel.addChild(new Spacer(1));
            panel.addChild(new TruncatedText(theme.fg("error", `Error: ${this.error}`)));
        }
        panel.addChild(new Spacer(1));
        panel.addChild(new TruncatedText(this.closeHint()));
        return panel;
    }
    populateHeartbeatList(list) {
        const heartbeats = this.heartbeats;
        if (heartbeats.length === 0) {
            list.addChild(new TruncatedText(theme.fg("muted", "No running or paused heartbeats"), 1, 0));
            return;
        }
        const selectedIndex = this.getSelectedIndex(heartbeats);
        const visibleItems = this.getListLayout().visibleItems;
        const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(visibleItems / 2), heartbeats.length - visibleItems));
        const endIndex = Math.min(startIndex + visibleItems, heartbeats.length);
        for (let index = startIndex; index < endIndex; index++) {
            const heartbeat = heartbeats[index];
            if (!heartbeat)
                continue;
            const source = this.sourceLabel(heartbeat);
            const label = heartbeat.job.label?.trim();
            const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
            const details = heartbeat.job.lastError
                ? `${source} · error: ${this.singleLine(heartbeat.job.lastError)}`
                : `${source} · ${this.sessionLabel(heartbeat)} · ${heartbeat.job.schedule.expression} · ${delivery}`;
            list.addChild(new MenuRow({
                primary: label || this.singleLine(heartbeat.job.prompt) || this.defaultHeartbeatName(heartbeat),
                secondary: details,
                meta: this.formatStatus(heartbeat),
                selected: index === selectedIndex,
            }));
        }
        if (startIndex > 0 || endIndex < heartbeats.length) {
            list.addChild(new TruncatedText(theme.fg("muted", `  (${selectedIndex + 1}/${heartbeats.length})`), 1, 0));
        }
    }
    createActionPanel(mode) {
        const heartbeat = this.findHeartbeat(mode.heartbeatId);
        if (!heartbeat) {
            return new MenuPanel({ title: "Heartbeats", subtitle: "This heartbeat is no longer available." });
        }
        const name = heartbeat.job.label?.trim() || this.defaultHeartbeatName(heartbeat);
        const panel = new MenuPanel({
            title: name,
            subtitle: this.singleLine(heartbeat.job.prompt),
        });
        panel.addChild(new TruncatedText(theme.fg("muted", this.formatHeartbeatDetails(heartbeat))));
        panel.addChild(new Spacer(1));
        if (this.error) {
            panel.addChild(new TruncatedText(theme.fg("error", `Error: ${this.error}`)));
            panel.addChild(new Spacer(1));
        }
        const list = new MenuList();
        for (const [index, action] of this.availableActions(heartbeat).entries()) {
            list.addChild(new MenuRow({
                primary: action.label,
                secondary: this.actionDescription(action.action),
                selected: index === mode.selectedIndex,
            }));
        }
        panel.addChild(list);
        panel.addChild(new Spacer(1));
        panel.addChild(new TruncatedText(this.detailHint()));
        return panel;
    }
    moveSelection(delta) {
        if (this.mode.type === "list") {
            const heartbeats = this.heartbeats;
            if (heartbeats.length === 0)
                return;
            const selectedIndex = this.getSelectedIndex(heartbeats);
            const nextIndex = Math.max(0, Math.min(selectedIndex + delta, heartbeats.length - 1));
            this.selectedHeartbeatId = heartbeats[nextIndex]?.job.id;
        }
        else {
            const count = this.availableActions(this.findHeartbeat(this.mode.heartbeatId)).length;
            this.mode = { ...this.mode, selectedIndex: Math.max(0, Math.min(this.mode.selectedIndex + delta, count - 1)) };
        }
        this.options.requestRender();
    }
    async confirmSelection() {
        if (this.mode.type === "list") {
            const heartbeats = this.heartbeats;
            const heartbeat = heartbeats[this.getSelectedIndex(heartbeats)];
            if (heartbeat) {
                this.mode = { type: "actions", heartbeatId: heartbeat.job.id, selectedIndex: 0 };
                this.options.requestRender();
            }
            return;
        }
        const heartbeat = this.findHeartbeat(this.mode.heartbeatId);
        if (!heartbeat) {
            this.mode = { type: "list" };
            this.options.requestRender();
            return;
        }
        const selected = this.availableActions(heartbeat)[this.mode.selectedIndex];
        if (!selected)
            return;
        await this.runAction(heartbeat, selected.action);
    }
    async runAction(heartbeat, action) {
        this.busy = true;
        this.error = undefined;
        this.options.requestRender();
        try {
            await this.options.onAction(heartbeat, action);
            this.mode = { type: "list" };
        }
        catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        finally {
            this.busy = false;
            this.options.requestRender();
        }
    }
    availableActions(heartbeat) {
        if (!heartbeat)
            return [];
        return [
            heartbeat.job.status === "paused"
                ? { label: "Resume heartbeat", action: "resume" }
                : { label: "Pause heartbeat", action: "pause" },
            { label: "Stop heartbeat", action: "stop" },
        ];
    }
    getSelectedIndex(heartbeats) {
        const index = heartbeats.findIndex((heartbeat) => heartbeat.job.id === this.selectedHeartbeatId);
        return index < 0 ? 0 : index;
    }
    findHeartbeat(id) {
        return this.heartbeats.find((heartbeat) => heartbeat.job.id === id);
    }
    sessionLabel(heartbeat) {
        return heartbeat.sessionName?.trim() || this.singleLine(heartbeat.firstMessage ?? "") || heartbeat.job.sessionId;
    }
    getListLayout() {
        return getMenuListLayout({
            getRows: this.options.getRows,
            preferredVisibleItems: PREFERRED_VISIBLE_HEARTBEATS,
            totalItems: this.heartbeats.length,
            reservedRows: HEARTBEAT_LIST_RESERVED_ROWS + (this.error ? 2 : 0),
            comfortableItemRows: 3,
            compactItemRows: 2,
            scrollIndicatorRows: HEARTBEAT_SCROLL_INDICATOR_ROWS,
        });
    }
    formatStatus(heartbeat) {
        return heartbeat.job.status === "active" ? theme.fg("success", "active") : theme.fg("warning", "paused");
    }
    formatHeartbeatDetails(heartbeat) {
        const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
        const next = heartbeat.job.nextRunAt ? this.formatTimestamp(heartbeat.job.nextRunAt) : "—";
        return `${this.sourceLabel(heartbeat)} · ${this.sessionLabel(heartbeat)} · ${heartbeat.job.status} · ${heartbeat.job.schedule.expression} · ${delivery} · next ${next} · ${heartbeat.job.runCount} runs`;
    }
    sourceLabel(heartbeat) {
        return heartbeat.job.source === "heartbeat" ? "Created by you" : "Created by agent";
    }
    defaultHeartbeatName(heartbeat) {
        return heartbeat.job.source === "heartbeat" ? "Your heartbeat" : "Agent-created heartbeat";
    }
    closeHint() {
        return keyHint("tui.select.cancel", "close", { primaryOnly: true });
    }
    detailHint() {
        return `${keyHint("app.modal.back", "back")}  ${keyHint("tui.select.cancel", "close", { primaryOnly: true })}`;
    }
    actionDescription(action) {
        switch (action) {
            case "pause":
                return "Stop deliveries until resumed";
            case "resume":
                return "Continue scheduled deliveries";
            case "stop":
                return "Permanently remove this heartbeat";
        }
    }
    singleLine(value) {
        return value.replace(/\s+/g, " ").trim();
    }
    formatTimestamp(value) {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime()))
            return value;
        return parsed.toISOString().slice(0, 16).replace("T", " ");
    }
}
//# sourceMappingURL=heartbeat-manager.js.map