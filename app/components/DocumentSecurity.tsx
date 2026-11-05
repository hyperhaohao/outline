import { observer } from "mobx-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styled, { createGlobalStyle } from "styled-components";
import { s } from "@shared/styles";
import { TeamPreference } from "@shared/types";
import useStores from "~/hooks/useStores";
import printApprovalStore from "~/stores/PrintApprovalStore";
import securityStore from "~/stores/DocumentSecurityStore";
import { client } from "~/utils/ApiClient";
import {
  watermarkTileCount,
  WATERMARK_COLUMN_WIDTH,
  WATERMARK_ROW_HEIGHT,
} from "~/utils/watermarkLayout";
import {
  registerPrintGuard,
  updatePrintProtection,
} from "~/utils/printSecurity";

interface SecurityContext {
  userId: string;
  documentId: string;
  traceId?: string;
  name: string;
  account: string;
  dingTalkUnionId?: string;
  canPrint: boolean;
  approvedPrintSession?: boolean;
}

/** 登录工作区的水印和打印保护；渲染层不接触编辑器协作数据。 */
function DocumentSecurity({
  documentId,
  shareId,
}: {
  documentId: string;
  shareId?: string;
}) {
  const stores = useStores();
  const { user, team } = stores.auth;
  const [context, setContext] = useState<SecurityContext>();
  const [verifiedAt, setVerifiedAt] = useState(0);
  const [time, setTime] = useState(new Date());
  const [tileCount, setTileCount] = useState(() =>
    watermarkTileCount(window.innerWidth, window.innerHeight)
  );
  const printSession =
    printApprovalStore.session?.userId === user?.id &&
    printApprovalStore.session?.documentId === documentId
      ? printApprovalStore.session
      : undefined;
  const currentContext =
    context?.userId === user?.id && context?.documentId === documentId
      ? context
      : undefined;
  const token = useRef(Symbol("watermark"));
  const latest = useRef<() => boolean>(() => false);
  const ability = stores.policies.abilities(documentId).download;
  const role = user?.role;
  const exportEnabled = team?.getPreference(TeamPreference.ViewersCanExport);
  latest.current = () =>
    !!(
      currentContext?.canPrint &&
      user &&
      ((user.isAdmin && ability) ||
        (currentContext.approvedPrintSession && printSession)) &&
      Date.now() - verifiedAt < 30000
    );

  useLayoutEffect(() => {
    if (currentContext?.approvedPrintSession && printSession) {
      printApprovalStore.confirm();
    }
  }, [currentContext, printSession]);

  useLayoutEffect(
    () => registerPrintGuard(() => latest.current()),
    [documentId]
  );
  useLayoutEffect(() => {
    updatePrintProtection();
  }, [currentContext, ability, role, exportEnabled, verifiedAt]);

  useEffect(() => {
    let active = true;
    setContext(undefined);
    setVerifiedAt(0);
    let accessTrace: string | undefined;
    const refresh = async () => {
      try {
        const response = await client.post("/securityAudit.context", {
          documentId,
          ...(shareId ? { shareId } : {}),
          ...(printSession
            ? {
                approvalId: printSession.approvalId,
                printSession: printSession.secret,
              }
            : {}),
          ...(accessTrace ? { accessTrace } : {}),
        });
        if (active) {
          accessTrace = response.data.traceId;
          stores.documents.addPolicies(response.policies);
          setContext(response.data as SecurityContext);
          setVerifiedAt(Date.now());
        }
      } catch {
        if (active) {
          setVerifiedAt(0);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    documentId,
    user?.id,
    role,
    exportEnabled,
    stores.documents,
    shareId,
    printSession,
  ]);

  useEffect(() => {
    const resize = () =>
      setTileCount(watermarkTileCount(window.innerWidth, window.innerHeight));
    window.addEventListener("resize", resize);
    window.addEventListener("beforeprint", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("beforeprint", resize);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTime(new Date());
      updatePrintProtection();
    }, 60000);
    const afterPrint = () => {
      const session = printApprovalStore.session;
      if (session?.documentId === documentId) {
        void client
          .post("/exportApprovals.finishPrint", {
            id: session.approvalId,
            printSession: session.secret,
          })
          .catch(() => undefined);
      }
      printApprovalStore.clear();
    };
    window.addEventListener("afterprint", afterPrint);
    const beforePrint = () => {
      const allowed = updatePrintProtection();
      const session = printApprovalStore.session;
      void client
        .post("/securityAudit.print", {
          documentId,
          result: allowed ? "allowed" : "denied",
          ...(session?.documentId === documentId
            ? { approvalId: session.approvalId, printSession: session.secret }
            : {}),
        })
        .catch(() => undefined);
    };
    window.addEventListener("beforeprint", beforePrint);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      afterPrint();
    };
  }, [documentId]);

  const stamp = time.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const label = `${currentContext?.name ?? user?.name ?? ""} · ${currentContext?.account ?? user?.email ?? user?.id ?? ""}`;
  useLayoutEffect(() => {
    const currentToken = token.current;
    securityStore.set(currentToken, {
      name: currentContext?.name ?? user?.name ?? "",
      account: currentContext?.account ?? user?.email ?? user?.id ?? "",
      traceId: currentContext?.traceId,
      dingTalkUnionId: currentContext?.dingTalkUnionId,
    });
    return () => securityStore.remove(currentToken);
  }, [currentContext, user?.name, user?.email, user?.id]);
  return createPortal(
    <>
      <PrintStyles />
      <PrintDenied className="outline-print-denied">
        此账号无权打印当前页面中的文档。
      </PrintDenied>
      {securityStore.isOwner(token.current) && (
        <Watermark className="outline-identity-watermark" aria-hidden="true">
          {Array.from({ length: tileCount }, (_, index) => (
            <Tile key={index}>
              <span>{label}</span>
              {currentContext?.dingTalkUnionId && (
                <span className="outline-dingtalk-watermark">
                  钉钉 UnionID：{currentContext.dingTalkUnionId}
                </span>
              )}
              <span>{stamp} 北京时间</span>
              <span>{securityStore.traces || "访问审计暂不可用"}</span>
            </Tile>
          ))}
        </Watermark>
      )}
    </>,
    document.body
  );
}

const Watermark = styled.div`
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  user-select: none;
  overflow: hidden;
  display: grid;
  grid-template-columns: repeat(
    auto-fill,
    minmax(${WATERMARK_COLUMN_WIDTH}px, 1fr)
  );
  grid-auto-rows: ${WATERMARK_ROW_HEIGHT}px;
  color: ${s("text")};
  opacity: 0.085;
  @media print {
    color: #555;
    opacity: 0.18;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
`;
const Tile = styled.div`
  transform: rotate(-24deg);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 5px;
  overflow-wrap: anywhere;
  padding: 16px 32px;
  span {
    max-width: 100%;
    white-space: normal;
    word-break: break-all;
  }
`;
const PrintDenied = styled.div`
  display: none;
`;
const PrintStyles = createGlobalStyle`
  @media print {
    html[data-outline-print-blocked], html[data-outline-print-blocked] body {
      background: #fff !important;
      background-image: none !important;
    }
    html[data-outline-print-blocked] body > * { display: none !important; }
    html[data-outline-print-blocked] body > .outline-print-denied:first-of-type,
    html[data-outline-print-blocked] body > .outline-print-denied {
      display: block !important;
      color: #000 !important;
      font-size: 20px !important;
    }
    html[data-outline-print-blocked] body > .outline-print-denied ~ .outline-print-denied { display: none !important; }
    html:not([data-outline-print-blocked]) .outline-identity-watermark { display: grid !important; }
  }
`;

export default observer(DocumentSecurity);
