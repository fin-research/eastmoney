export interface TreemapLabelLayout {
  visible: boolean;
  fontSize: number;
  lineHeight: number;
  width: number;
  height: number;
}

export const MIN_TREEMAP_FONT_SIZE = 8;
const HORIZONTAL_PADDING = 6;
const VERTICAL_PADDING = 4;
const LINE_HEIGHT_RATIO = 1.25;

export function formatTreemapLabel(
  name: string,
  changeText: string,
): string {
  return `${name}\n${changeText}`;
}

export function fitTreemapLabel(
  text: string,
  rect: { width: number; height: number },
  targetFontSize: number,
): TreemapLabelLayout {
  const lines = text.split("\n");
  const widestLine = Math.max(...lines.map(textUnits), 1);
  const availableWidth = Math.max(rect.width - HORIZONTAL_PADDING, 0);
  const availableHeight = Math.max(rect.height - VERTICAL_PADDING, 0);
  const fittedFontSize = Math.min(
    targetFontSize,
    availableWidth / widestLine,
    availableHeight / (lines.length * LINE_HEIGHT_RATIO),
  );
  const fontSize = Math.floor(fittedFontSize * 10) / 10;

  if (fontSize < MIN_TREEMAP_FONT_SIZE) {
    return {
      visible: false,
      fontSize: 0,
      lineHeight: 0,
      width: 0,
      height: 0,
    };
  }

  return {
    visible: true,
    fontSize,
    lineHeight: fontSize * LINE_HEIGHT_RATIO,
    width: availableWidth,
    height: availableHeight,
  };
}

function textUnits(value: string): number {
  return Array.from(value).reduce(
    (total, character) =>
      total + (/[\u0000-\u00ff]/.test(character) ? 0.72 : 1.15),
    0,
  );
}
