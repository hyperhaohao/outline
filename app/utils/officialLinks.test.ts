import { autorun, observable, runInAction } from "mobx";
import { UserRole } from "@shared/types";
import User from "~/models/User";
import stores from "~/stores";
import { canShowOfficialLinks } from "./officialLinks";

describe("官方入口显示策略", () => {
  test.each([UserRole.Admin, UserRole.Member, UserRole.Viewer, UserRole.Guest])(
    "按工作区角色 %s 判断，集合权限不参与判断",
    (role) => {
      const user = new User({ id: "official-links-user", role }, stores.users);
      expect(canShowOfficialLinks({ user, isFetching: false })).toBe(
        role === UserRole.Admin
      );
    }
  );

  test("认证未就绪时不使用缓存的管理员身份", () => {
    expect(
      canShowOfficialLinks({ user: { isAdmin: true }, isFetching: true })
    ).toBe(false);
  });

  test("仅公共页面显式保留匿名入口", () => {
    const auth = { isFetching: false };
    expect(canShowOfficialLinks(auth)).toBe(false);
    expect(canShowOfficialLinks(auth, { allowAnonymous: true })).toBe(true);
    expect(
      canShowOfficialLinks({ isFetching: true }, { allowAnonymous: true })
    ).toBe(false);
  });

  test("公共页面上的已登录非管理员同样隐藏", () => {
    expect(
      canShowOfficialLinks(
        { user: { isAdmin: false }, isFetching: false },
        { allowAnonymous: true }
      )
    ).toBe(false);
  });

  test("角色变更会使订阅者立即重新计算", () => {
    const user = new User(
      { id: "official-links-transition", role: UserRole.Admin },
      stores.users
    );
    const auth = observable({ user, isFetching: false });
    const states: boolean[] = [];
    const dispose = autorun(() => states.push(canShowOfficialLinks(auth)));
    runInAction(() => {
      user.role = UserRole.Viewer;
    });
    runInAction(() => {
      user.role = UserRole.Admin;
    });
    dispose();
    expect(states).toEqual([true, false, true]);
  });
});
