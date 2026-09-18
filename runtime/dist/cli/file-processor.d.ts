import type { ImageContent } from "@earendil-works/pi-ai";
export interface ProcessedFiles {
    text: string;
    images: ImageContent[];
}
export interface ProcessFileOptions {
    autoResizeImages?: boolean;
}
export declare function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles>;
//# sourceMappingURL=file-processor.d.ts.map