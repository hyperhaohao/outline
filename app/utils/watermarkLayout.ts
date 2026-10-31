/** 水印网格的最小列宽，与实际CSS布局共用，避免高分辨率下计算漂移。 */
export const WATERMARK_COLUMN_WIDTH = 320;

/** 水印每行的布局高度，单位为CSS像素。 */
export const WATERMARK_ROW_HEIGHT = 190;

/** 根据视口生成足够的网格单元，多留一行覆盖旋转边界；打印保留至少30块。 */
export function watermarkTileCount(width: number, height: number): number {
  const columns = Math.max(1, Math.floor(width / WATERMARK_COLUMN_WIDTH));
  const rows = Math.max(1, Math.ceil(height / WATERMARK_ROW_HEIGHT));
  return Math.max(30, columns * (rows + 1));
}
