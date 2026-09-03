import i18n from "i18next";
import { vi } from "vitest";
import { runInAction } from "mobx";
import { UserRole } from "@shared/types";
import { actionToKBar, actionToMenuItem } from "~/actions";
import stores from "~/stores";
import type { ActionContext } from "~/types";
import history from "~/utils/history";
// 此处验证导航动作过滤，快捷键弹窗内容由独立界面回归覆盖。
vi.mock("~/scenes/KeyboardShortcuts", () => ({ default: () => null }));
import {
  openDocumentation,
  openAPIDocumentation,
  openFeedbackUrl,
  openBugReportUrl,
  openChangelog,
  openKeyboardShortcuts,
  logout,
} from "./navigation";

const officialActions = [
  openDocumentation,
  openAPIDocumentation,
  openFeedbackUrl,
  openBugReportUrl,
  openChangelog,
];

const context: ActionContext = {
  stores,
  t: i18n.t,
  location: history.location,
  isMenu: true,
  isCommandBar: false,
  isButton: false,
  currentUserId: undefined,
  currentTeamId: undefined,
  activeDocumentId: undefined,
  activeModels: new Set(),
  getActiveModels: () => [],
  getActiveModel: () => undefined,
  getActivePolicies: () => [],
  isModelActive: () => false,
};

describe("官方导航动作在菜单和命令搜索中使用相同规则", () => {
  afterEach(() => {
    runInAction(() => {
      stores.auth.currentUserId = null;
    });
  });

  test.each([UserRole.Admin, UserRole.Member, UserRole.Viewer, UserRole.Guest])(
    "%s 的菜单和命令搜索保持一致",
    (role) => {
      const user = stores.users.add({ id: "navigation-official-links", role });
      runInAction(() => {
        stores.auth.currentUserId = user.id;
        stores.auth.isFetching = false;
      });
      for (const item of officialActions) {
        const menu = actionToMenuItem(item, context);
        expect("visible" in menu && menu.visible).toBe(role === UserRole.Admin);
        expect(actionToKBar(item, context)).toHaveLength(
          role === UserRole.Admin ? 1 : 0
        );
      }
      expect(actionToKBar(openKeyboardShortcuts, context)).toHaveLength(1);
      expect(actionToKBar(logout, context)).toHaveLength(1);
    }
  );

  test("同一动作上下文在降权或退出后不残留官方动作", () => {
    const user = stores.users.add({
      id: "navigation-transition",
      role: UserRole.Admin,
    });
    runInAction(() => {
      stores.auth.currentUserId = user.id;
      stores.auth.isFetching = false;
    });
    expect(actionToKBar(openChangelog, context)).toHaveLength(1);
    runInAction(() => {
      user.role = UserRole.Member;
    });
    expect(actionToKBar(openChangelog, context)).toHaveLength(0);
    runInAction(() => {
      stores.auth.currentUserId = null;
    });
    expect(actionToKBar(openChangelog, context)).toHaveLength(0);
  });
});
