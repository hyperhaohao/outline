import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { vi } from "vitest";
import WebsocketProvider from "./WebsocketProvider";

const { handlers, socket, auth, collections } = vi.hoisted(() => {
  const handlers = new Map<string, (event: { id: string }) => Promise<void>>();
  return {
    handlers,
    socket: {
      on: vi.fn(
        (name: string, handler: (event: { id: string }) => Promise<void>) => {
          handlers.set(name, handler);
        }
      ),
      onAny: vi.fn(),
      io: { on: vi.fn() },
      disconnect: vi.fn(),
    },
    auth: {
      user: { id: "current-user" },
      fetchAuth: vi.fn(async () => undefined),
    },
    collections: { fetchAll: vi.fn(async () => undefined) },
  };
});

vi.mock("socket.io-client", () => ({ io: () => socket }));
vi.mock("~/hooks/useStores", () => ({
  default: () => ({ auth, collections, documents: { all: [] }, policies: {} }),
}));

describe("实时角色通知刷新当前认证信息", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    act(() => {
      root.render(<WebsocketProvider />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test.each(["users.promote", "users.demote"])(
    "%s 先刷新用户角色再刷新文档集",
    async (name) => {
      const handler = handlers.get(name);
      expect(handler).toBeDefined();
      await act(async () => {
        await handler?.({ id: "current-user" });
      });
      expect(auth.fetchAuth).toHaveBeenCalledOnce();
      expect(collections.fetchAll).toHaveBeenCalledOnce();
      expect(auth.fetchAuth.mock.invocationCallOrder[0]).toBeLessThan(
        collections.fetchAll.mock.invocationCallOrder[0]
      );
    }
  );

  test("其他用户的通知不会刷新当前会话", async () => {
    await act(async () => {
      await handlers.get("users.demote")?.({ id: "another-user" });
    });
    expect(auth.fetchAuth).not.toHaveBeenCalled();
    expect(collections.fetchAll).not.toHaveBeenCalled();
  });
});
