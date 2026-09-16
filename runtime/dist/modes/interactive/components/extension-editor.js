import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Container, Editor, getKeybindings, Spacer, Text, } from "@earendil-works/pi-tui";
import { getEditorTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
export class ExtensionEditorComponent extends Container {
    editor;
    onSubmitCallback;
    onCancelCallback;
    tui;
    keybindings;
    _focused = false;
    get focused() {
        return this._focused;
    }
    set focused(value) {
        this._focused = value;
        this.editor.focused = value;
    }
    constructor(tui, keybindings, title, prefill, onSubmit, onCancel, options) {
        super();
        this.tui = tui;
        this.keybindings = keybindings;
        this.onSubmitCallback = onSubmit;
        this.onCancelCallback = onCancel;
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("accent", title), 1, 0));
        this.addChild(new Spacer(1));
        this.editor = new Editor(tui, getEditorTheme(), options);
        if (prefill) {
            this.editor.setText(prefill);
        }
        this.editor.onSubmit = (text) => {
            this.onSubmitCallback(text);
        };
        this.addChild(this.editor);
        this.addChild(new Spacer(1));
        const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
        const hint = keyHint("tui.select.confirm", "submit") +
            "  " +
            keyHint("tui.input.newLine", "newline") +
            "  " +
            keyHint("tui.select.cancel", "cancel") +
            (hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
        this.addChild(new Text(hint, 1, 0));
        this.addChild(new Spacer(1));
        this.addChild(new DynamicBorder());
    }
    handleInput(keyData) {
        const kb = getKeybindings();
        if (kb.matches(keyData, "tui.select.cancel")) {
            this.onCancelCallback();
            return;
        }
        if (this.keybindings.matches(keyData, "app.editor.external")) {
            this.openExternalEditor();
            return;
        }
        this.editor.handleInput(keyData);
    }
    openExternalEditor() {
        const editorCmd = process.env.VISUAL || process.env.EDITOR;
        if (!editorCmd) {
            return;
        }
        const currentText = this.editor.getText();
        const tmpFile = path.join(os.tmpdir(), `pi-extension-editor-${Date.now()}.md`);
        try {
            fs.writeFileSync(tmpFile, currentText, "utf-8");
            this.tui.stop();
            const [editor, ...editorArgs] = editorCmd.split(" ");
            const result = spawnSync(editor, [...editorArgs, tmpFile], {
                stdio: "inherit",
                shell: process.platform === "win32",
            });
            if (result.status === 0) {
                const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
                this.editor.setText(newContent);
            }
        }
        finally {
            try {
                fs.unlinkSync(tmpFile);
            }
            catch {
                // Ignore cleanup errors
            }
            this.tui.start();
            // Force full re-render since external editor uses alternate screen
            this.tui.requestRender(true);
        }
    }
}
//# sourceMappingURL=extension-editor.js.map