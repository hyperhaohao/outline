import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ThemeProvider } from "styled-components";
import { light } from "@shared/styles/theme";
import { UserRole } from "@shared/types";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";
import securityStore from "~/stores/DocumentSecurityStore";
import DocumentSecurity from "./DocumentSecurity";

vi.mock("~/hooks/useStores", () => ({ default: () => stores }));

/** 模拟服务器权限刷新，验证水印不污染正文且分屏打印状态能够恢复。 */
describe("工作区水印与动态打印保护", () => {
  let container: HTMLDivElement;
  let root: Root;
  const blocked = () =>
    document.documentElement.hasAttribute("data-outline-print-blocked");
  const mount = (ids: string[]) =>
    root.render(
      <ThemeProvider theme={light}>
        {ids.map((id) => (
          <DocumentSecurity key={id} documentId={id} />
        ))}
      </ThemeProvider>
    );

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    container.textContent = "正文保持不变";
    document.body.append(container);
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const user = stores.users.add({
      id: "watermark-user",
      name: "测试管理员",
      email: "qa@example.test",
      role: UserRole.Admin,
    });
    const team = stores.auth.add({
      id: "watermark-team",
      preferences: { viewersCanExport: false },
    });
    stores.auth.currentUserId = user.id;
    stores.auth.currentTeamId = team.id;
    stores.policies.add({ id: "allowed-doc", abilities: { download: true } });
    stores.policies.add({ id: "blocked-doc", abilities: { download: false } });
    vi.mocked(client.post).mockReset();
    vi.mocked(client.post).mockImplementation(async (path, data) => ({
      data: {
        userId: "watermark-user",
        documentId: (data as { documentId: string }).documentId,
        name: "测试管理员",
        account: "qa@example.test",
        traceId: `${(data as { documentId: string }).documentId}-trace`,
        canPrint:
          path === "/securityAudit.context" &&
          (data as { documentId: string }).documentId === "allowed-doc",
      },
      policies: [],
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    stores.auth.currentUserId = null;
    stores.auth.currentTeamId = null;
    vi.useRealTimers();
    expect(securityStore.identities.size).toBe(0);
    expect(blocked()).toBe(false);
  });

  it("权限未知时立即保护，允许后显示管理员身份水印且不拦截点击", async () => {
    act(() => {
      mount(["allowed-doc"]);
    });
    expect(blocked()).toBe(true);
    await act(async () => {});
    expect(blocked()).toBe(false);
    const watermark = document.querySelector(".outline-identity-watermark")!;
    expect(watermark.textContent).toContain("测试管理员");
    expect(watermark.textContent).toContain("allowed-doc-trace");
    expect(window.getComputedStyle(watermark).pointerEvents).toBe("none");
    expect(container.textContent).not.toContain("qa@example.test");
  });

  it("分屏任一受限就禁止整页打印，关闭后恢复且只有一个水印层", async () => {
    await act(async () => {
      mount(["allowed-doc", "blocked-doc"]);
    });
    expect(blocked()).toBe(true);
    expect(
      document.querySelectorAll(".outline-identity-watermark")
    ).toHaveLength(1);
    expect(securityStore.traces).toContain("blocked-doc-trace");
    document.title = "受限文档标题";
    act(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(document.title).toBe("禁止打印");
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(document.title).toBe("受限文档标题");
    await act(async () => {
      mount(["allowed-doc"]);
    });
    expect(blocked()).toBe(false);
    expect(securityStore.traces).not.toContain("blocked-doc-trace");
  });

  it("完整显示钉钉标识且不写入正文", async () => {
    const unionId = "Corp-UnionID_" + "1234567890".repeat(8);
    vi.mocked(client.post).mockResolvedValue({
      data: {
        userId: "watermark-user",
        documentId: "allowed-doc",
        name: "测试管理员",
        account: "qa@example.test",
        dingTalkUnionId: unionId,
        traceId: "test-full-id",
        canPrint: true,
      },
      policies: [],
    });
    await act(async () => {
      mount(["allowed-doc"]);
    });
    const tile = document.querySelector(".outline-dingtalk-watermark");
    expect(tile?.textContent).toBe("钉钉 UnionID：" + unionId);
    expect(container.textContent).not.toContain(unionId);
  });

  it("没有钉钉绑定或响应属于旧用户时不显示猜测身份", async () => {
    await act(async () => {
      mount(["allowed-doc"]);
    });
    expect(document.querySelector(".outline-dingtalk-watermark")).toBeNull();
    vi.mocked(client.post).mockResolvedValue({
      data: {
        userId: "old-user",
        documentId: "allowed-doc",
        name: "其他用户",
        account: "other@example.test",
        dingTalkUnionId: "other-private-id",
        canPrint: true,
      },
      policies: [],
    });
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(document.querySelector(".outline-dingtalk-watermark")).toBeNull();
    expect(
      document.querySelector(".outline-identity-watermark")?.textContent
    ).not.toContain("other-private-id");
    expect(blocked()).toBe(true);
  });

  it("视口变成2K或4K后动态铺满，不停留在固定30块", async () => {
    const initialWidth = window.innerWidth;
    const initialHeight = window.innerHeight;
    await act(async () => {
      mount(["allowed-doc"]);
    });
    for (const [width, height, count] of [
      [2560, 1440, 72],
      [3840, 2160, 156],
    ]) {
      await act(async () => {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: width,
        });
        Object.defineProperty(window, "innerHeight", {
          configurable: true,
          value: height,
        });
        window.dispatchEvent(new Event("resize"));
      });
      expect(
        document.querySelector(".outline-identity-watermark")?.children
      ).toHaveLength(count);
    }
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: initialWidth,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: initialHeight,
    });
  });

  it("在线权限撤销或服务器不可达后，下一次打印重新检查并保护", async () => {
    await act(async () => {
      mount(["allowed-doc"]);
    });
    expect(blocked()).toBe(false);
    vi.mocked(client.post).mockRejectedValue(new Error("offline"));
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    act(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(blocked()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
  });
});
