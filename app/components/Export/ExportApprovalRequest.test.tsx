import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import { light } from "@shared/styles/theme";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";
import { ActionContextProvider } from "~/hooks/useActionContext";
import { ExportApprovalRequest } from "./ExportApprovalRequest";

vi.mock("~/hooks/useStores", () => ({ default: () => stores }));

/** 验证真实申请表的默认范围及用途输入，窗口交互另由浏览器验收。 */
describe("审批申请窗口", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(client.post).mockImplementation(async () => ({
      data: {
        manifestDigest: "a".repeat(64),
        manifest: [{ id: "synthetic-doc", title: "合成资料" }],
      },
    }));
  });
  afterEach(async () => {
    await act(async () => {
      stores.dialogs.closeAllModals();
      root.unmount();
    });
    container.remove();
  });
  it("显示单篇默认范围、用途与提交按钮", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ThemeProvider theme={light}>
            <ActionContextProvider>
              <ExportApprovalRequest
                resourceId="synthetic-doc"
                resourceType="document"
              />
            </ActionContextProvider>
          </ThemeProvider>
        </MemoryRouter>
      );
    });
    expect(document.body.textContent).toContain("用途说明");
    expect(document.body.textContent).toContain("仅当前文档");
    expect(document.querySelector('button[type="submit"]')).not.toBeNull();
  });
});
