import { z } from "zod";
import {
  UserAuthentication,
  AuthenticationProvider,
  type User,
} from "@server/models";

/** 服务端核实的钉钉绑定；subject始终为Casdoor不可变用户ID。 */
export interface DingTalkIdentity {
  unionId: string;
  subject: string;
  issuer: string;
  source: "casdoor.dingtalk";
  verifiedAt: string;
}

/** 只接受完整的不含空白或控制字符的标识，不通过截断或修剪改变原值。 */
export const dingTalkIdentitySchema = z.object({
  unionId: z.string().regex(/^[!-~]{1,100}$/),
  subject: z.string().min(1).max(200),
  issuer: z.string().url(),
  source: z.literal("casdoor.dingtalk"),
  verifiedAt: z.string().datetime(),
});

/** 从当前工作区的有效OIDC认证关联读取身份，遇到歧义时不显示猜测值。 */
export async function getDingTalkIdentity(
  user: User
): Promise<DingTalkIdentity | undefined> {
  const authentications = await UserAuthentication.findAll({
    where: { userId: user.id },
    attributes: ["providerId", "identityMetadata"],
    include: [
      {
        model: AuthenticationProvider,
        as: "authenticationProvider",
        attributes: [],
        where: { name: "oidc", teamId: user.teamId, enabled: true },
        required: true,
      },
    ],
  });
  const identities = authentications.flatMap((authentication) => {
    const parsed = dingTalkIdentitySchema.safeParse(
      authentication.identityMetadata?.dingTalk
    );
    return parsed.success && parsed.data.subject === authentication.providerId
      ? [parsed.data]
      : [];
  });
  return identities.length === 1 ? identities[0] : undefined;
}
