import { action, computed, observable } from "mobx";

/** 可见文档水印元数据，独立于正文和持久化缓存。 */
export interface WatermarkIdentity {
  name: string;
  account: string;
  traceId?: string;
}

/** 多个分屏与演示共用一个水印层，同时保留各次文档访问的追踪编号。 */
class DocumentSecurityStore {
  identities = observable.map<symbol, WatermarkIdentity>();

  /** 文档组件刷新身份信息时更新可见水印。 */
  @action
  set(token: symbol, identity: WatermarkIdentity) {
    this.identities.set(token, identity);
  }

  /** 关闭文档或分屏时移除该访问，避免旧身份残留。 */
  @action
  remove(token: symbol) {
    this.identities.delete(token);
  }

  /** 仅第一个可见组件绘制水印，避免分屏与演示重叠降低可读性。 */
  isOwner(token: symbol) {
    return this.identities.keys().next().value === token;
  }

  /** 同一身份的重复访问编号去重，完整编号仍然可见。 */
  @computed
  get traces() {
    return [
      ...new Set(
        [...this.identities.values()]
          .map((identity) => identity.traceId)
          .filter(Boolean)
      ),
    ].join(" / ");
  }
}

export default new DocumentSecurityStore();
