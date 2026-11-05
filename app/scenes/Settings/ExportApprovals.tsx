import { observer } from "mobx-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import type {
  ExportApprovalAction,
  ExportApprovalDocument,
  ExportApprovalStatus,
} from "@shared/types/exportApprovals";
import { errToString } from "@shared/utils/error";
import Scene from "~/components/Scene";
import Heading from "~/components/Heading";
import Button from "~/components/Button";
import useCurrentUser from "~/hooks/useCurrentUser";
import { client } from "~/utils/ApiClient";

interface ApprovalRow {
  id: string;
  userId: string;
  requesterName: string;
  action: ExportApprovalAction;
  resourceType: "document" | "collection";
  resourceId: string;
  format: string | null;
  status: ExportApprovalStatus;
  reason: string;
  response?: string;
  manifest: ExportApprovalDocument[];
  documentCount: number;
  expiresAt?: string;
  fileOperationId?: string;
}
const labels: Record<ExportApprovalStatus, string> = {
  pending: "待审核",
  approved: "已批准",
  rejected: "已驳回",
  cancelled: "已取消",
  revoked: "已撤销",
  expired: "已过期",
  invalidated: "资料变化，需重新申请",
  consumed: "已领取单次授权",
};
const formatLabels: Record<string, string> = {
  "outline-markdown": "Markdown",
  html: "HTML",
  textbundle: "TextBundle",
  okf: "Open Knowledge Format",
  json: "JSON",
};

/** 本人的申请与管理员审批共用展示组件，权限始终由服务端过滤。 */
function ExportApprovals({ review = false }: { review?: boolean }) {
  const user = useCurrentUser();
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [status, setStatus] = useState(review ? "pending" : "");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    try {
      const response = await client.post("/exportApprovals.list", {
        mine: !review,
        ...(status ? { status } : {}),
        offset,
        limit: 25,
      });
      setRows(response.data);
      setTotal(response.pagination.total);
      setError("");
    } catch (failure) {
      setError(errToString(failure));
    }
  }, [review, status, offset]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const pending = rows.filter(
      (row) =>
        row.fileOperationId && row.userId === user.id && row.action === "export"
    );
    const poll = async () => {
      for (const row of pending) {
        try {
          const response = await client.post("/fileOperations.info", {
            id: row.fileOperationId,
          });
          if (active) {
            setOperations((current) => ({
              ...current,
              [row.id]: response.data.state,
            }));
          }
        } catch {
          if (active) {
            setOperations((current) => ({
              ...current,
              [row.id]: "unavailable",
            }));
          }
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [rows, user.id]);
  const handleAction = async (row: ApprovalRow, action: string) => {
    if (action === "reject" && !comments[row.id]?.trim()) {
      setError("请填写驳回原因");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await client.post(`/exportApprovals.${action}`, {
        id: row.id,
        ...(comments[row.id]?.trim()
          ? { response: comments[row.id].trim() }
          : {}),
      });
      await refresh();
    } catch (failure) {
      setError(errToString(failure));
    } finally {
      setBusy(false);
    }
  };
  if (review && !user.isAdmin) {
    return (
      <Scene title="无权访问">
        <p>仅工作区管理员可审核申请。</p>
      </Scene>
    );
  }
  return (
    <Scene title={review ? "导出与打印审批" : "我的导出与打印申请"}>
      <Heading>{review ? "导出与打印审批" : "我的导出与打印申请"}</Heading>
      <p>
        批准仅对应本次用途、格式和版本，24小时内使用一次，不改变账号角色或资料权限。
      </p>
      <Toolbar>
        <label>
          状态
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(labels).map(([key, value]) => (
              <option value={key} key={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void refresh()}>刷新</Button>
        {user.isAdmin && (
          <Link
            to={
              review
                ? "/settings/export-approvals"
                : "/settings/export-approval-review"
            }
          >
            {review ? "我的申请" : "审批管理"}
          </Link>
        )}
      </Toolbar>
      {error && <p role="alert">{error}</p>}
      {!rows.length && <p>当前没有申请记录。</p>}
      {rows.map((row) => (
        <Card key={row.id}>
          <h3>
            {row.manifest[0]?.title ?? "资料"} ·{" "}
            {row.action === "print"
              ? "打印预览"
              : `导出 ${formatLabels[row.format ?? ""] ?? row.format ?? ""}`}
          </h3>
          <p>
            申请人：{row.requesterName}　状态：{labels[row.status]}　范围：
            {row.documentCount}篇
          </p>
          <p>用途：{row.reason}</p>
          <details>
            <summary>资料和版本清单</summary>
            <ul>
              {row.manifest.map((item) => (
                <li key={item.id}>
                  {item.title} · 版本{item.revision}
                </li>
              ))}
            </ul>
          </details>
          {row.expiresAt && (
            <p>批准有效至：{new Date(row.expiresAt).toLocaleString("zh-CN")}</p>
          )}
          {row.response && <p>审批意见：{row.response}</p>}
          <Toolbar>
            {review && row.status === "pending" && (
              <>
                <label>
                  审批意见
                  <input
                    maxLength={1000}
                    value={comments[row.id] ?? ""}
                    onChange={(event) =>
                      setComments((current) => ({
                        ...current,
                        [row.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={() => void handleAction(row, "approve")}
                >
                  批准
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void handleAction(row, "reject")}
                >
                  驳回
                </Button>
              </>
            )}
            {review && ["approved", "consumed"].includes(row.status) && (
              <Button
                disabled={busy}
                onClick={() => void handleAction(row, "revoke")}
              >
                撤销授权
              </Button>
            )}
            {row.userId === user.id &&
              ["pending", "approved"].includes(row.status) && (
                <Button
                  disabled={busy}
                  onClick={() => void handleAction(row, "cancel")}
                >
                  取消申请
                </Button>
              )}
            {!review &&
              row.userId === user.id &&
              row.status === "approved" &&
              (row.action === "print" ? (
                <Link to={`/doc/${row.resourceId}?printApproval=${row.id}`}>
                  打开原文并领取一次打印预览
                </Link>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => void handleAction(row, "execute")}
                >
                  执行已批准导出
                </Button>
              ))}
            {!review &&
              row.status === "consumed" &&
              row.fileOperationId &&
              operations[row.id] === "complete" && (
                <a
                  href={`/api/fileOperations.redirect?id=${row.fileOperationId}`}
                >
                  下载已批准文件
                </a>
              )}
            {!review &&
              row.status === "consumed" &&
              row.fileOperationId &&
              !["complete", "error", "unavailable"].includes(
                operations[row.id]
              ) && <span>文件生成中，请稍候…</span>}
            {!review &&
              row.status === "consumed" &&
              operations[row.id] === "error" && (
                <>
                  <span>任务失败，重试仍使用同一任务及审批范围。</span>
                  <Button
                    disabled={busy}
                    onClick={() => void handleAction(row, "retry")}
                  >
                    重试原任务
                  </Button>
                </>
              )}
            {operations[row.id] === "unavailable" && (
              <span>原任务已不可访问，请检查批准状态及资料权限。</span>
            )}
          </Toolbar>
        </Card>
      ))}
      <Toolbar>
        <Button
          disabled={offset === 0}
          onClick={() => setOffset((current) => Math.max(0, current - 25))}
        >
          上一页
        </Button>
        <span>
          {total ? offset + 1 : 0}—{Math.min(offset + rows.length, total)}／
          {total}
        </span>
        <Button
          disabled={offset + rows.length >= total}
          onClick={() => setOffset((current) => current + 25)}
        >
          下一页
        </Button>
      </Toolbar>
    </Scene>
  );
}

/** 专用审批入口仍由服务端再次验证Admin身份。 */
export function ExportApprovalReview() {
  return <ExportApprovals review />;
}

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0;
  label {
    display: grid;
    gap: 4px;
  }
`;
const Card = styled.section`
  border: 1px solid ${({ theme }) => theme.divider};
  border-radius: 8px;
  padding: 16px;
  margin: 16px 0;
  ul {
    max-height: 240px;
    overflow-y: auto;
  }
`;
export default observer(ExportApprovals);
