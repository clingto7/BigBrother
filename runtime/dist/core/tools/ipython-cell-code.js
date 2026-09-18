const BASH_CELL_MAGIC_PATTERN = /^(?:[ \t]*\r?\n)*[ \t]*%%bash\b[^\r\n]*(?:\r?\n|$)/;
export function parseIpythonBashCell(code) {
    const match = BASH_CELL_MAGIC_PATTERN.exec(code);
    if (!match) {
        return undefined;
    }
    return { body: code.slice(match[0].length) };
}
//# sourceMappingURL=ipython-cell-code.js.map