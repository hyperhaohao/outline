import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import styled from "styled-components";
import { ShieldIcon } from "outline-icons";
import { client } from "~/utils/ApiClient";
import useCurrentUser from "~/hooks/useCurrentUser";
import useStores from "~/hooks/useStores";
import Scene from "~/components/Scene";
import Heading from "~/components/Heading";
import Button from "~/components/Button";
import Text from "~/components/Text";

interface AuditRow {
  id: string;
  time: string;
  userId: string;
  role: string;
  channel: string;
  operation: string;
  result: string;
  riskType?: string;
  reason?: string;
  targetIds?: string[];
  traceId: string;
  credentialId?: string;
  clientId?: string;
  ip?: string;
  returnedBytes: number;
  documentCount: number;
  clientReported: boolean;
}
interface Filters {
  after: string;
  before: string;
  userId: string;
  channel: string;
  operation: string;
  result: string;
  riskType: string;
}
const emptyFilters: Filters = {
  after: "",
  before: "",
  userId: "",
  channel: "",
  operation: "",
  result: "",
  riskType: "",
};
const results: Record<string, string> = {
  attempt: "尝试",
  allowed: "允许",
  denied: "拒绝",
  complete: "完成",
  queued: "已排队",
  failed: "失败",
};
const risks: Record<string, string> = {
  bulk_read: "疑似批量读取",
  permission_denied: "权限不足",
  unknown_tool: "未知工具",
  credential_scope: "凭据权限不足",
};

/** 管理员专属中文审计页面；查询仅展示元数据，不加载文档正文。 */
function RiskAudit() {
  const user = useCurrentUser();
  const { users } = useStores();
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!user.isAdmin) {
      return;
    }
    let active = true;
    setLoading(true);
    const body = Object.fromEntries(
      Object.entries(applied).filter(([, value]) => !!value)
    );
    void client
      .post<{ data: AuditRow[]; pagination: { total: number } }>(
        "/securityAudit.list",
        {
          ...body,
          ...(applied.after
            ? { after: new Date(applied.after).toISOString() }
            : {}),
          ...(applied.before
            ? { before: new Date(applied.before).toISOString() }
            : {}),
          offset,
          limit: 50,
        }
      )
      .then((response) => {
        if (active) {
          setRows(response.data);
          setTotal(response.pagination.total);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setRows([]);
          setError("审计查询失败，请检查权限或服务状态。");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [applied, offset, user.isAdmin]);
  if (!user.isAdmin) {
    return <Text>仅工作区管理员可以查看风险审计。</Text>;
  }
  const field = (key: keyof Filters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  return (
    <Scene title="风险审计" icon={<ShieldIcon />}>
      <Heading>风险审计</Heading>
      <Text as="p" type="secondary">
        保留访问与导出元数据 365
        天。打印为客户端上报，不能作为截图或泄漏证明。风险标记不会自动停用账号。
      </Text>
      <FiltersForm
        onSubmit={(event) => {
          event.preventDefault();
          setOffset(0);
          setApplied({ ...filters });
        }}
      >
        <label>
          开始时间
          <input
            type="datetime-local"
            value={filters.after}
            onChange={(event) => field("after", event.target.value)}
          />
        </label>
        <label>
          结束时间
          <input
            type="datetime-local"
            value={filters.before}
            onChange={(event) => field("before", event.target.value)}
          />
        </label>
        <label>
          用户 ID
          <input
            value={filters.userId}
            placeholder="留空为所有用户"
            onChange={(event) => field("userId", event.target.value)}
          />
        </label>
        <label>
          渠道
          <select
            value={filters.channel}
            onChange={(event) => field("channel", event.target.value)}
          >
            <option value="">全部</option>
            {["web", "api", "mcp", "worker"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          操作
          <input
            value={filters.operation}
            placeholder="如 documents.export"
            onChange={(event) => field("operation", event.target.value)}
          />
        </label>
        <label>
          结果
          <select
            value={filters.result}
            onChange={(event) => field("result", event.target.value)}
          >
            <option value="">全部</option>
            {Object.entries(results).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          风险类型
          <select
            value={filters.riskType}
            onChange={(event) => field("riskType", event.target.value)}
          >
            <option value="">全部</option>
            {Object.entries(risks).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={loading}>
          查询
        </Button>
      </FiltersForm>
      {error && <Text>{error}</Text>}
      <Text>
        {loading
          ? "加载中…"
          : `共 ${total} 条，当前 ${offset + (rows.length ? 1 : 0)}–${offset + rows.length}`}
      </Text>
      <TableContainer>
        <table>
          <thead>
            <tr>
              {[
                "北京时间",
                "用户及角色",
                "渠道 / 操作",
                "结果 / 风险",
                "目标",
                "返回量",
                "追踪及凭据",
                "IP",
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {new Date(row.time).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                  })}
                </td>
                <td>
                  {users.get(row.userId)?.name ?? row.userId}
                  <br />
                  {row.role}
                </td>
                <td>
                  {row.channel}
                  <br />
                  {row.operation}
                  {row.clientReported && (
                    <>
                      <br />
                      客户端上报
                    </>
                  )}
                </td>
                <td>
                  {results[row.result] ?? row.result}
                  <br />
                  {row.riskType
                    ? (risks[row.riskType] ?? row.riskType)
                    : row.reason}
                </td>
                <td>{row.targetIds?.join(", ")}</td>
                <td>
                  {row.documentCount} 篇<br />
                  {row.returnedBytes} 字节
                </td>
                <td>
                  {row.traceId}
                  <br />
                  {row.credentialId ?? row.clientId ?? "网页会话 / 后台"}
                </td>
                <td>{row.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableContainer>
      <Button
        disabled={loading || offset === 0}
        onClick={() => setOffset(Math.max(0, offset - 50))}
      >
        上一页
      </Button>{" "}
      <Button
        disabled={loading || offset + 50 >= total}
        onClick={() => setOffset(offset + 50)}
      >
        下一页
      </Button>
    </Scene>
  );
}
const FiltersForm = styled.form`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 20px 0;
  align-items: end;
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  input,
  select {
    padding: 6px;
    background: transparent;
    color: inherit;
    border: 1px solid #888;
    border-radius: 4px;
  }
`;
const TableContainer = styled.div`
  width: 100%;
  overflow-x: auto;
  margin: 16px 0;
  table {
    border-collapse: collapse;
    font-size: 12px;
    width: 100%;
  }
  th,
  td {
    padding: 8px;
    text-align: left;
    border-bottom: 1px solid #8885;
    vertical-align: top;
    overflow-wrap: anywhere;
    min-width: 100px;
    max-width: 260px;
  }
`;
export default observer(RiskAudit);
