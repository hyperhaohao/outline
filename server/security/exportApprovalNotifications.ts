import { NotificationEventType, UserRole } from "@shared/types";
import type { ExportApproval } from "@server/models";
import { Notification, User } from "@server/models";
import type { APIContext } from "@server/types";

/** 仅生成站内通知；不复用阅读授权申请，也不向钉钉或邮件发送消息。 */
export async function notifyExportApproval(
  ctx: APIContext,
  approval: ExportApproval,
  requested: boolean
): Promise<void> {
  const recipients = requested
    ? await User.findAll({
        where: {
          teamId: approval.teamId,
          role: UserRole.Admin,
          suspendedAt: null,
        },
        transaction: ctx.state.transaction,
      })
    : await User.findAll({
        where: { id: approval.userId, teamId: approval.teamId },
        transaction: ctx.state.transaction,
      });
  for (const recipient of recipients) {
    await Notification.create(
      {
        userId: recipient.id,
        actorId: ctx.state.auth.user.id,
        teamId: approval.teamId,
        event: requested
          ? NotificationEventType.ExportApprovalRequested
          : NotificationEventType.ExportApprovalUpdated,
        data: {
          approvalId: approval.id,
          approvalTitle: approval.manifest[0]?.title ?? "资料",
          approvalStatus: approval.status,
        },
      },
      { transaction: ctx.state.transaction }
    );
  }
}
