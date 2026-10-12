import { render, unmountComponentAtNode } from "react-dom";
import { act } from "react-dom/test-utils";
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
  const blocked = () =>
    document.documentElement.hasAttribute("data-outline-print-blocked");
  const mount = (ids: string[]) =>
    render(
      <ThemeProvider theme={light}>
        {ids.map((id) => (
          <DocumentSecurity key={id} documentId={id} />
        ))}
      </ThemeProvider>,
      container
    );

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    container.textContent = "正文保持不变";
    document.body.append(container);
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
      unmountComponentAtNode(container);
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
