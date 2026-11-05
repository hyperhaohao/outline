import { Share, Team, User } from "@server/models";
import { allow } from "./cancan";
import { canManageInternalShare } from "@server/security/internalSharing";
import { and, isTeamModel, isTeamMutable } from "./utils";

allow(User, "createShare", Team, (actor, team) =>
  and(
    //
    isTeamModel(actor, team),
    isTeamMutable(actor),
    !actor.isGuest
  )
);

allow(User, "listShares", Team, (actor, team) =>
  and(
    //
    isTeamModel(actor, team),
    !actor.isGuest
  )
);

allow(User, "read", Share, (actor, share) =>
  and(
    //
    isTeamModel(actor, share),
    !actor.isGuest
  )
);

allow(User, ["update", "revoke"], Share, (actor, share) =>
  and(
    isTeamModel(actor, share),
    share?.audience === "workspace",
    canManageInternalShare(actor, share?.document ?? share?.collection)
  )
);
