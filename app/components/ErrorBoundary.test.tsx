import type { ButtonHTMLAttributes } from "react";
import { observable, runInAction } from "mobx";
import { render, unmountComponentAtNode } from "react-dom";
import { act } from "react-dom/test-utils";
import { vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

const auth = observable<{
  user: { isAdmin: boolean } | undefined;
  isFetching: boolean;
}>({ user: undefined, isFetching: false });

vi.mock("~/hooks/useStores", () => ({ default: () => ({ auth }) }));
vi.mock("~/components/PageTitle", () => ({ default: () => null }));
vi.mock("~/components/Button", () => ({
  default: ({ children, onClick }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

/** 触发真实错误边界，验证恢复操作与角色控制能同时工作。 */
function BrokenContent(): never {
  throw new Error("QA controlled rendering failure");
}

/** 仅抑制本测试主动触发的浏览器错误事件，其他异常仍正常报告。 */
function handleExpectedError(event: ErrorEvent) {
  if (event.message === "QA controlled rendering failure") {
    event.preventDefault();
  }
}

describe("错误页面的官方反馈入口", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    window.addEventListener("error", handleExpectedError);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => {
      unmountComponentAtNode(container);
    });
    container.remove();
    window.removeEventListener("error", handleExpectedError);
    vi.restoreAllMocks();
  });

  test.each([
    { label: "管理员", user: { isAdmin: true }, loading: false, visible: true },
    {
      label: "非管理员",
      user: { isAdmin: false },
      loading: false,
      visible: false,
    },
    { label: "匿名页面", user: undefined, loading: false, visible: true },
    {
      label: "身份刷新中",
      user: { isAdmin: true },
      loading: true,
      visible: false,
    },
  ])("$label 保留恢复操作并正确控制反馈按钮", ({ user, loading, visible }) => {
    runInAction(() => {
      auth.user = user;
      auth.isFetching = loading;
    });
    act(() => {
      render(
        <ErrorBoundary component="div">
          <BrokenContent />
        </ErrorBoundary>,
        container
      );
    });
    const detail = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show detail")
    );
    expect(detail).toBeDefined();
    act(() => detail?.click());
    expect(container.textContent).toContain("Reload");
    expect(container.textContent).toContain("QA controlled rendering failure");
    expect(container.textContent?.includes("Report a bug")).toBe(visible);
    if (visible && user) {
      act(() => {
        runInAction(() => {
          auth.user = { isAdmin: false };
        });
      });
      expect(container.textContent).not.toContain("Report a bug");
    }
  });
});
