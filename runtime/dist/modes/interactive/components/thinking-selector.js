import { Container, SelectList } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
const THINKING_SELECT_LIST_LAYOUT = {
    minPrimaryColumnWidth: 12,
    maxPrimaryColumnWidth: 32,
};
const LEVEL_DESCRIPTIONS = {
    off: "No reasoning",
    minimal: "Very brief reasoning",
    low: "Light reasoning",
    medium: "Moderate reasoning",
    high: "Deep reasoning",
    xhigh: "Very deep reasoning",
    max: "Maximum reasoning",
};
export class ThinkingSelectorComponent extends Container {
    selectList;
    constructor(currentLevel, availableLevels, onSelect, onCancel) {
        super();
        const thinkingLevels = availableLevels.map((level) => ({
            value: level,
            label: level,
            description: LEVEL_DESCRIPTIONS[level],
        }));
        this.addChild(new DynamicBorder());
        this.selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme(), THINKING_SELECT_LIST_LAYOUT);
        const currentIndex = thinkingLevels.findIndex((item) => item.value === currentLevel);
        if (currentIndex !== -1) {
            this.selectList.setSelectedIndex(currentIndex);
        }
        this.selectList.onSelect = (item) => {
            onSelect(item.value);
        };
        this.selectList.onCancel = () => {
            onCancel();
        };
        this.addChild(this.selectList);
        this.addChild(new DynamicBorder());
    }
    getSelectList() {
        return this.selectList;
    }
}
//# sourceMappingURL=thinking-selector.js.map