import type RootStore from "~/stores/RootStore";
import { TeamPreference } from "@shared/types";

const guards = new Map<symbol, () => boolean>();
let originalTitle: string | undefined;

/** 打印预览标题同样隐藏；多个分屏共用一次保存与恢复，避免互相覆盖。 */
function beforePrint() {
  if (!updatePrintProtection() && originalTitle === undefined) {
    originalTitle = document.title;
    document.title = "禁止打印";
  }
}

/** 关闭打印预览后恢复网页标题。 */
function afterPrint() {
  if (originalTitle !== undefined) {
    document.title = originalTitle;
    originalTitle = undefined;
  }
}

/** 浏览器整页打印只要包含一篇受限文档，就隐藏所有页面内容。 */
export function updatePrintProtection() {
  const blocked = [...guards.values()].some((allowed) => !allowed());
  document.documentElement.toggleAttribute(
    "data-outline-print-blocked",
    blocked
  );
  return !blocked;
}

/** 每个可见文档独立注册，关闭分屏或演示后准确清理自己的状态。 */
export function registerPrintGuard(allowed: () => boolean) {
  const token = Symbol("document-print");
  guards.set(token, allowed);
  if (guards.size === 1) {
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
  }
  updatePrintProtection();
  return () => {
    guards.delete(token);
    if (!guards.size) {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      afterPrint();
    }
    updatePrintProtection();
  };
}

/** 动作执行时读取最新账号、开关与文档权限，不能依赖菜单打开时的快照。 */
export function canPrintDocument(stores: RootStore, id?: string) {
  const { user, team } = stores.auth;
  if (!id || !user || !team || !stores.policies.abilities(id).download) {
    return false;
  }
  return (
    ((!user.isViewer && !user.isGuest) ||
      team.getPreference(TeamPreference.ViewersCanExport)) &&
    updatePrintProtection()
  );
}
