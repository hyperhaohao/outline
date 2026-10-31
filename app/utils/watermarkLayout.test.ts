import {
  WATERMARK_COLUMN_WIDTH,
  WATERMARK_ROW_HEIGHT,
  watermarkTileCount,
} from "./watermarkLayout";

describe("水印视口覆盖", () => {
  it.each([
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
    [1440, 2560],
    [320, 900],
  ])("覆盖%s×%s视口及旋转余量", (width, height) => {
    const columns = Math.max(1, Math.floor(width / WATERMARK_COLUMN_WIDTH));
    const count = watermarkTileCount(width, height);
    expect(Math.floor(count / columns) * WATERMARK_ROW_HEIGHT).toBeGreaterThan(
      height
    );
    expect(count).toBeGreaterThanOrEqual(30);
  });
  it("2K和4K不再固定为30块", () => {
    expect(watermarkTileCount(2560, 1440)).toBe(72);
    expect(watermarkTileCount(3840, 2160)).toBe(156);
  });
});
