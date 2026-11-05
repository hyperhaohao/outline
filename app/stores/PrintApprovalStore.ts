import { action, makeObservable, observable } from "mobx";

/** 打印许可仅保存在当前页面内存，不写本地存储，也不与其他账号或文档共享。 */
interface PrintSession {
  userId: string;
  documentId: string;
  approvalId: string;
  secret: string;
}

class PrintApprovalStore {
  @observable.ref
  session: PrintSession | undefined = undefined;

  @observable
  ready = false;

  constructor() {
    makeObservable(this);
  }

  /** 领取批准后激活本篇打印预览，服务器仍会逐次校验有效期和版本。 */
  @action
  set(session: PrintSession) {
    this.ready = false;
    this.session = session;
  }

  /** 离开文档或关闭打印预览即清除，避免后续Ctrl+P沿用授权。 */
  @action
  clear() {
    this.ready = false;
    this.session = undefined;
  }

  /** 水印组件收到服务器确认后通知预览入口，防止窗口早于权限加载。 */
  @action
  confirm() {
    this.ready = true;
  }
}

export default new PrintApprovalStore();
