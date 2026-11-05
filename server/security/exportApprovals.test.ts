import { FileOperationFormat, UserRole } from "@shared/types";
import { ExportApproval, FileOperation, Notification } from "@server/models";
import {
  buildAdmin,
  buildApiKey,
  buildCollection,
  buildDocument,
  buildPersonalCollection,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

/** 每项审批使用独立合成账号、集合和版本，验证真实HTTP边界而非复制实现。 */
async function fixture(role = UserRole.Viewer) {
  const team = await buildTeam();
  const user = await buildUser({ teamId: team.id, role });
  const admin = await buildAdmin({ teamId: team.id });
  const collection = await buildCollection({
    userId: admin.id,
    teamId: team.id,
  });
  const document = await buildDocument({
    userId: admin.id,
    teamId: team.id,
    collectionId: collection.id,
  });
  return { team, user, admin, collection, document };
}

/** 通过申请接口取得审批编号，格式和用途均由请求显式确定。 */
async function request(
  user: Awaited<ReturnType<typeof buildUser>>,
  documentId: string,
  action = "export"
) {
  return server.post("/api/exportApprovals.create", user, {
    body: {
      resourceId: documentId,
      resourceType: "document",
      action,
      reason: "合成验证用途",
      ...(action === "export"
        ? { format: FileOperationFormat.MarkdownZip }
        : {}),
    },
  });
}

describe("导出与打印的单次审批", () => {
  for (const role of [UserRole.Viewer, UserRole.Member]) {
    it(`${role}默认禁止直接导出，原始阅读权可以提交申请`, async () => {
      const { user, document } = await fixture(role);
      expect(
        (
          await server.post("/api/documents.export", user, {
            body: { id: document.id },
          })
        ).status
      ).toBe(403);
      const response = await request(user, document.id);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.status).toBe("pending");
      expect(body.data.documentCount).toBe(1);
      expect(
        await Notification.count({
          where: { teamId: user.teamId, event: "export_approvals.requested" },
        })
      ).toBe(1);
    });
  }
  it("并发重复待审只生成一项申请", async () => {
    const { user, document } = await fixture();
    const responses = await Promise.all([
      request(user, document.id),
      request(user, document.id),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(
      responses.map((response) => response.json())
    );
    expect(bodies[0].data.id).toBe(bodies[1].data.id);
    expect(await ExportApproval.count({ where: { userId: user.id } })).toBe(1);
  });
  it("普通成员或集合管理身份不能批准，Admin驳回需说明原因", async () => {
    const { user, admin, document } = await fixture(UserRole.Member);
    const { data } = await (await request(user, document.id)).json();
    expect(
      (
        await server.post("/api/exportApprovals.approve", user, {
          body: { id: data.id },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await server.post("/api/exportApprovals.reject", admin, {
          body: { id: data.id },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await server.post("/api/exportApprovals.reject", admin, {
          body: { id: data.id, response: "用途不符合要求" },
        })
      ).status
    ).toBe(200);
  });
  it("批准与领取绑定账号，同一批准并发领取只有一个导出任务", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id)).json();
    const approved = await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    expect(approved.status).toBe(200);
    const another = await buildUser({ teamId: user.teamId });
    expect(
      (
        await server.post("/api/exportApprovals.execute", another, {
          body: { id: data.id },
        })
      ).status
    ).toBe(403);
    const responses = await Promise.all(
      [1, 2].map(() =>
        server.post("/api/exportApprovals.execute", user, {
          body: { id: data.id },
        })
      )
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(
      responses.map((response) => response.json())
    );
    expect(bodies[0].data.fileOperationId).toBe(bodies[1].data.fileOperationId);
    expect(await FileOperation.count({ where: { userId: user.id } })).toBe(1);
  });
  it("批准后正文或集合清单变化，不会导出未经审核的新版本", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id)).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    await document.update({ title: "批准后改动" });
    expect(
      (
        await server.post("/api/exportApprovals.execute", user, {
          body: { id: data.id },
        })
      ).status
    ).toBe(403);
    expect(await FileOperation.count({ where: { userId: user.id } })).toBe(0);
  });
  it("过期或撤销的批准不能执行，不能通过格式或子文档参数扩大范围", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id)).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    expect(
      (
        await server.post("/api/documents.export", user, {
          headers: { accept: "text/html" },
          body: { id: document.id, approvalId: data.id },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await server.post("/api/documents.export", user, {
          body: {
            id: document.id,
            approvalId: data.id,
            includeChildDocuments: true,
          },
        })
      ).status
    ).toBe(403);
    await ExportApproval.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { id: data.id } }
    );
    const expired = await server.post("/api/exportApprovals.list", user, {
      body: { status: "expired", mine: true },
    });
    expect(
      (await expired.json()).data.map((row: { id: string }) => row.id)
    ).toContain(data.id);
    expect(
      (
        await server.post("/api/exportApprovals.execute", user, {
          body: { id: data.id },
        })
      ).status
    ).toBe(403);
    await server.post("/api/exportApprovals.revoke", admin, {
      body: { id: data.id },
    });
    expect((await ExportApproval.findByPk(data.id))?.status).toBe("revoked");
  });
  it("打印单独批准，领取一次；不提供文件导出授权", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id, "print")).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    const executed = await server.post("/api/exportApprovals.execute", user, {
      body: { id: data.id },
    });
    expect(executed.status).toBe(200);
    const body = await executed.json();
    expect(body.data.printSession).toHaveLength(43);
    expect(
      (
        await server.post("/api/exportApprovals.execute", user, {
          body: { id: data.id },
        })
      ).status
    ).toBe(403);
    const context = await server.post("/api/securityAudit.context", user, {
      body: {
        documentId: document.id,
        approvalId: data.id,
        printSession: body.data.printSession,
      },
    });
    expect((await context.json()).data.canPrint).toBe(true);
    expect(
      (
        await server.post("/api/documents.export", user, {
          body: { id: document.id, approvalId: data.id },
        })
      ).status
    ).toBe(403);
  });
  it("个人监管读取不能申请导出他人的资料，也不会授予原本没有的阅读权", async () => {
    const { user, admin, team } = await fixture();
    const personal = await buildPersonalCollection(user);
    const document = await buildDocument({
      userId: user.id,
      teamId: team.id,
      collectionId: personal.id,
    });
    expect((await request(admin, document.id)).status).toBe(403);
    const another = await buildUser({ teamId: team.id });
    expect((await request(another, document.id)).status).toBe(403);
  });
  it("Viewer可由原生集合接口领取批准，旧导出开关不能跳过审批", async () => {
    const { user, admin, collection } = await fixture();
    const body = {
      resourceId: collection.id,
      resourceType: "collection",
      action: "export",
      format: FileOperationFormat.MarkdownZip,
      reason: "集合验证",
    };
    expect(
      (
        await server.post("/api/collections.export", user, {
          body: { id: collection.id },
        })
      ).status
    ).toBe(403);
    const { data } = await (
      await server.post("/api/exportApprovals.create", user, { body })
    ).json();
    expect(
      (
        await server.post("/api/exportApprovals.approve", admin, {
          body: { id: data.id },
        })
      ).status
    ).toBe(200);
    const response = await server.post("/api/collections.export", user, {
      body: { id: collection.id, approvalId: data.id },
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect((await ExportApproval.findByPk(data.id))?.fileOperationId).toBe(
      result.data.fileOperation.id
    );
  });
  it("Admin自己提交的批准仍绑定单个任务，重复领取不能生成第二项", async () => {
    const { admin, document } = await fixture();
    const { data } = await (await request(admin, document.id)).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    const first = await (
      await server.post("/api/exportApprovals.execute", admin, {
        body: { id: data.id },
      })
    ).json();
    const second = await (
      await server.post("/api/exportApprovals.execute", admin, {
        body: { id: data.id },
      })
    ).json();
    expect(first.data.fileOperationId).toBeTruthy();
    expect(second.data.fileOperationId).toBe(first.data.fileOperationId);
    expect((await ExportApproval.findByPk(data.id))?.status).toBe("consumed");
  });
  it("资料版本变化、撤销或停用后，已领取的原任务也不能再次领取", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id)).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    expect(
      (
        await server.post("/api/exportApprovals.execute", user, {
          body: { id: data.id },
        })
      ).status
    ).toBe(200);
    await document.update({ title: "领取后发生变更" });
    expect(
      (
        await server.post("/api/exportApprovals.execute", user, {
          body: { id: data.id },
        })
      ).status
    ).toBe(403);
  });
  it("打印结束即失效，原会话不能重开预览", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id, "print")).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    const execution = await (
      await server.post("/api/exportApprovals.execute", user, {
        body: { id: data.id },
      })
    ).json();
    expect(
      (
        await server.post("/api/exportApprovals.finishPrint", user, {
          body: { id: data.id, printSession: execution.data.printSession },
        })
      ).status
    ).toBe(200);
    const response = await server.post("/api/securityAudit.context", user, {
      body: {
        documentId: document.id,
        approvalId: data.id,
        printSession: execution.data.printSession,
      },
    });
    expect((await response.json()).data.canPrint).toBe(false);
  });
  it("只有审批接口scope的程序Key不能通过批准ID绕过导出scope", async () => {
    const { user, admin, document } = await fixture();
    const { data } = await (await request(user, document.id)).json();
    await server.post("/api/exportApprovals.approve", admin, {
      body: { id: data.id },
    });
    const key = await buildApiKey({
      userId: user.id,
      scope: ["exportApprovals:write"],
    });
    const response = await server.post("/api/exportApprovals.execute", {
      headers: { authorization: `Bearer ${key.value}` },
      body: { id: data.id },
    });
    expect(response.status).toBe(403);
    expect(await FileOperation.count({ where: { userId: user.id } })).toBe(0);
  });
});
