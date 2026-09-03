import type User from "~/models/User";

/** 官方入口判断所需的认证状态，不额外维护角色副本。 */
interface OfficialLinksAuth {
  user?: Pick<User, "isAdmin">;
  isFetching: boolean;
}

/** 公共页面可显式保留匿名用户原有的官方入口。 */
export interface OfficialLinksOptions {
  allowAnonymous?: boolean;
}

/**
 * 根据当前工作区角色决定是否显示系统自带的 Outline 官方入口。
 * 身份刷新期间先隐藏入口，避免缓存的管理员身份造成短暂误显示。
 *
 * @param auth 当前认证状态。
 * @param options 公共页面的匿名显示策略。
 * @returns 是否允许显示官方入口。
 */
export function canShowOfficialLinks(
  auth: OfficialLinksAuth,
  { allowAnonymous = false }: OfficialLinksOptions = {}
): boolean {
  if (auth.isFetching) {
    return false;
  }

  if (auth.user) {
    return auth.user.isAdmin;
  }

  return allowAnonymous;
}
