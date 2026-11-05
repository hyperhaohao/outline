/** 审批清单固定文档版本，避免批准后目录或正文变化导致隐式扩大范围。 */
export interface ExportApprovalDocument {
  id: string;
  revision: number;
  updatedAt: string;
  title: string;
}

/** 导出、打印各自独立授权，不通过修改角色或资源ACL实现放行。 */
export type ExportApprovalAction = "export" | "print";

/** 明确列出终态，所有未识别状态按无授权处理。 */
export type ExportApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "revoked"
  | "expired"
  | "invalidated"
  | "consumed";
