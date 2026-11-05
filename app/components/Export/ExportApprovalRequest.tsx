import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { FileOperationFormat } from "@shared/types";
import type { ExportApprovalAction } from "@shared/types/exportApprovals";
import { client } from "~/utils/ApiClient";
import { errToString } from "@shared/utils/error";
import Button from "~/components/Button";
import Text from "~/components/Text";

interface Props {
  resourceId: string;
  resourceType: "document" | "collection";
  action?: ExportApprovalAction;
}

/** 申请窗口明确展示版本清单和范围，提交只创建申请，不执行导出或开放权限。 */
export function ExportApprovalRequest({
  resourceId,
  resourceType,
  action = "export",
}: Props) {
  const [format, setFormat] = useState(FileOperationFormat.MarkdownZip);
  const [children, setChildren] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{
    digest: string;
    titles: string[];
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(undefined);
    setError("");
    void client
      .post("/exportApprovals.preview", {
        resourceId,
        resourceType,
        includeChildDocuments: children,
      })
      .then((result) => {
        if (active) {
          setPreview({
            digest: result.data.manifestDigest,
            titles: result.data.manifest.map(
              (item: { title: string }) => item.title
            ),
          });
        }
      })
      .catch((failure) => {
        if (active) {
          setError(errToString(failure));
        }
      });
    return () => {
      active = false;
    };
  }, [resourceId, resourceType, children]);
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!preview) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await client.post("/exportApprovals.create", {
        resourceId,
        resourceType,
        action,
        ...(action === "export" ? { format } : {}),
        includeChildDocuments: children,
        reason,
        expectedManifestDigest: preview.digest,
      });
      setSubmitted(true);
    } catch (failure) {
      setError(errToString(failure));
    } finally {
      setBusy(false);
    }
  };
  if (submitted) {
    return (
      <div role="status">
        <p>已提交，等待知识库管理员审核。</p>
        <p>批准后24小时内可使用一次，资料变化或权限撤回后需重新申请。</p>
        <Link to="/settings/export-approvals">查看我的申请</Link>
      </div>
    );
  }
  return (
    <Form onSubmit={handleSubmit}>
      <Text as="p">
        {action === "print" ? "打印预览" : "导出文件"}
        需要工作区管理员批准，本次不会立即执行。
      </Text>
      {action === "export" && (
        <label>
          文件格式
          <select
            value={format}
            onChange={(event) =>
              setFormat(event.target.value as FileOperationFormat)
            }
          >
            <option value={FileOperationFormat.MarkdownZip}>Markdown</option>
            <option value={FileOperationFormat.HTMLZip}>HTML</option>
            <option value={FileOperationFormat.TextBundleZip}>
              TextBundle
            </option>
            {resourceType === "collection" && (
              <>
                <option value={FileOperationFormat.OKFZip}>
                  Open Knowledge Format
                </option>
                <option value={FileOperationFormat.JSON}>JSON</option>
              </>
            )}
          </select>
        </label>
      )}
      {action === "export" && resourceType === "document" && (
        <label>
          <input
            type="checkbox"
            checked={children}
            onChange={(event) => setChildren(event.target.checked)}
          />
          包含当前文档的下级文档
        </label>
      )}
      <p>
        {resourceType === "collection"
          ? "范围：当前集合全部有效已发布文档。"
          : children
            ? "范围：当前文档及其下级。"
            : "范围：仅当前文档。"}
      </p>
      {preview && (
        <details>
          <summary>本次共{preview.titles.length}篇，查看资料清单</summary>
          <ul>
            {preview.titles.map((title, index) => (
              <li key={index}>{title}</li>
            ))}
          </ul>
        </details>
      )}
      <label>
        用途说明
        <textarea
          required
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={4}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !preview || !reason.trim()}>
        提交管理员审核
      </Button>
    </Form>
  );
}

const Form = styled.form`
  display: grid;
  gap: 12px;
  label {
    display: grid;
    gap: 6px;
  }
  textarea,
  select {
    font: inherit;
    padding: 8px;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
  }
  ul {
    max-height: 220px;
    overflow-y: auto;
  }
`;
