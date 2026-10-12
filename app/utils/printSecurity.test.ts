import { UserRole } from "@shared/types";
import stores from "~/stores";
import {
  canPrintDocument,
  registerPrintGuard,
  updatePrintProtection,
} from "./printSecurity";

describe("整页打印保护", () => {
  it("未知权限阻止打印，分屏关闭受限文档后恢复，最后卸载清理状态", () => {
    let loaded = false;
    const disposeA = registerPrintGuard(() => loaded);
    const disposeB = registerPrintGuard(() => true);
    expect(updatePrintProtection()).toBe(false);
    expect(
      document.documentElement.hasAttribute("data-outline-print-blocked")
    ).toBe(true);
    loaded = true;
    expect(updatePrintProtection()).toBe(true);
    loaded = false;
    disposeA();
    expect(updatePrintProtection()).toBe(true);
    disposeB();
    expect(
      document.documentElement.hasAttribute("data-outline-print-blocked")
    ).toBe(false);
  });

  it("账号角色、导出开关与资源能力必须同时允许；权限未加载时拒绝", () => {
    const user = stores.users.add({ id: "print-user", role: UserRole.Viewer });
    const team = stores.auth.add({
      id: "print-team",
      preferences: { viewersCanExport: false },
    });
    stores.auth.currentUserId = user.id;
    stores.auth.currentTeamId = team.id;
    stores.policies.add({ id: "print-doc", abilities: { download: true } });
    expect(canPrintDocument(stores, "print-doc")).toBe(false);
    team.updateData({ preferences: { viewersCanExport: true } });
    expect(canPrintDocument(stores, "print-doc")).toBe(true);
    stores.policies.remove("print-doc");
    expect(canPrintDocument(stores, "print-doc")).toBe(false);
    stores.auth.currentUserId = null;
    stores.auth.currentTeamId = null;
  });
});
