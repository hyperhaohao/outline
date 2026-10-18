import type { ReactNode } from "react";
import { observable, runInAction } from "mobx";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { vi } from "vitest";
import { client } from "~/utils/ApiClient";
import Version from "./Version";

const auth = observable({ user: { isAdmin: false }, isFetching: false });

vi.mock("~/hooks/useStores", () => ({ default: () => ({ auth }) }));
vi.mock("./SidebarLink", () => ({
  default: ({ href, label }: { href: string; label: ReactNode }) => (
    <a href={href}>{label}</a>
  ),
}));

describe("版本查询仅对管理员执行", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    runInAction(() => {
      auth.user.isAdmin = false;
      auth.isFetching = false;
    });
    vi.mocked(client.post).mockClear();
    vi.mocked(client.post).mockResolvedValue({ data: { versionsBehind: 0 } });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test("非管理员不渲染链接，也不发送安装信息请求", async () => {
    await act(async () => {
      root.render(<Version />);
    });
    expect(container.querySelector("a")).toBeNull();
    expect(client.post).not.toHaveBeenCalled();
  });

  test("管理员正常查询，随后降权隐藏整个组件", async () => {
    runInAction(() => {
      auth.user.isAdmin = true;
    });
    await act(async () => {
      root.render(<Version />);
    });
    expect(client.post).toHaveBeenCalledWith("/installation.info");
    expect(container.querySelector("a")?.href).toBe(
      "https://github.com/outline/outline/releases"
    );
    act(() => {
      runInAction(() => {
        auth.user.isAdmin = false;
      });
    });
    expect(container.querySelector("a")).toBeNull();
  });

  test("刷新身份期间不发送查询", async () => {
    runInAction(() => {
      auth.user.isAdmin = true;
      auth.isFetching = true;
    });
    await act(async () => {
      root.render(<Version />);
    });
    expect(client.post).not.toHaveBeenCalled();
  });
});
