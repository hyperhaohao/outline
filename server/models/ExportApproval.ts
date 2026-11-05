import type { InferAttributes, InferCreationAttributes } from "sequelize";
import { Column, DataType, Default, Table } from "sequelize-typescript";
import type {
  ExportApprovalAction,
  ExportApprovalDocument,
  ExportApprovalStatus,
} from "@shared/types/exportApprovals";
import type { FileOperationFormat } from "@shared/types";
import IdModel from "./base/IdModel";

/** 单次导出或打印申请；授权始终绑定申请人、操作和不可扩大的版本清单。 */
@Table({ tableName: "export_approvals", modelName: "export_approval" })
class ExportApproval extends IdModel<
  InferAttributes<ExportApproval>,
  Partial<InferCreationAttributes<ExportApproval>>
> {
  @Column(DataType.UUID)
  teamId: string;

  @Column(DataType.UUID)
  userId: string;

  @Column(DataType.UUID)
  resourceId: string;

  @Column(DataType.STRING)
  resourceType: "document" | "collection";

  @Column(DataType.STRING)
  action: ExportApprovalAction;

  @Column(DataType.STRING)
  format: FileOperationFormat | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  includeChildDocuments: boolean;

  @Column(DataType.TEXT)
  reason: string;

  @Column(DataType.JSONB)
  manifest: ExportApprovalDocument[];

  @Column(DataType.STRING)
  manifestDigest: string;

  @Default("pending")
  @Column(DataType.STRING)
  status: ExportApprovalStatus;

  @Column(DataType.UUID)
  responderId: string | null;

  @Column(DataType.TEXT)
  response: string | null;

  @Column(DataType.DATE)
  respondedAt: Date | null;

  @Column(DataType.DATE)
  expiresAt: Date | null;

  @Column(DataType.DATE)
  consumedAt: Date | null;

  @Column(DataType.UUID)
  fileOperationId: string | null;

  /** 打印预览短期会话只保存随机值摘要，不把它作为可转发的下载凭据。 */
  @Column(DataType.STRING)
  printSessionDigest: string | null;

  @Column(DataType.DATE)
  printSessionExpiresAt: Date | null;

  /** 一次文件下载会话允许Range重试；重新打开不产生新的下载授权。 */
  @Column(DataType.DATE)
  downloadStartedAt: Date | null;
}

export default ExportApproval;
