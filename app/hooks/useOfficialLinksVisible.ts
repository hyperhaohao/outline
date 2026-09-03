import {
  canShowOfficialLinks,
  type OfficialLinksOptions,
} from "~/utils/officialLinks";
import useStores from "./useStores";

/**
 * 为响应式界面复用官方入口显示规则，调用组件需使用 observer。
 *
 * @param options 公共页面的匿名显示策略。
 * @returns 当前身份是否可以看到官方入口。
 */
export function useOfficialLinksVisible(
  options?: OfficialLinksOptions
): boolean {
  const { auth } = useStores();
  return canShowOfficialLinks(auth, options);
}
