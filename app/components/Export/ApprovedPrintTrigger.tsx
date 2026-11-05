import { when } from "mobx";
import { useEffect } from "react";
import { useHistory } from "react-router-dom";
import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import useCurrentUser from "~/hooks/useCurrentUser";
import useQuery from "~/hooks/useQuery";
import printApprovalStore from "~/stores/PrintApprovalStore";
import { client } from "~/utils/ApiClient";

/** 从“我的申请”回到原文后领取一次打印预览，身份、水印和服务端许可就绪才打印。 */
export function ApprovedPrintTrigger({ documentId }: { documentId: string }) {
  const approvalId = useQuery().get("printApproval");
  const user = useCurrentUser({ rejectOnEmpty: false });
  const history = useHistory();
  useEffect(() => {
    if (!approvalId || !user) {
      return;
    }
    let active = true;
    const query = new URLSearchParams(history.location.search);
    query.delete("printApproval");
    void (async () => {
      try {
        const response = await client.post("/exportApprovals.execute", {
          id: approvalId,
        });
        if (!active) {
          return;
        }
        printApprovalStore.set({
          userId: user.id,
          documentId,
          approvalId,
          secret: response.data.printSession,
        });
        await when(() => printApprovalStore.ready, { timeout: 10000 });
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve())
        );
        if (active && printApprovalStore.session?.documentId === documentId) {
          window.print();
        }
      } catch (failure) {
        printApprovalStore.clear();
        toast.error(errToString(failure));
      } finally {
        if (active) {
          history.replace({ ...history.location, search: query.toString() });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [approvalId, user, documentId, history]);
  return null;
}
