import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
export declare class UserMessageComponent extends Container {
    private contentBox;
    constructor(text: string, markdownTheme?: MarkdownTheme, isRecognizedSlashCommand?: (name: string) => boolean);
    render(width: number): string[];
}
//# sourceMappingURL=user-message.d.ts.map