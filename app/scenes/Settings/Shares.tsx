import type { ColumnSort } from "@tanstack/react-table";
import { observer } from "mobx-react";
import { GlobeIcon, WarningIcon } from "outline-icons";
import type * as React from "react";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Link, useHistory, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { ConditionalFade } from "~/components/Fade";
import Heading from "~/components/Heading";
import InputSearch from "~/components/InputSearch";
import Notice from "~/components/Notice";
import Scene from "~/components/Scene";
import Text from "~/components/Text";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import usePolicy from "~/hooks/usePolicy";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import { useTableRequest } from "~/hooks/useTableRequest";
import { SharesTable } from "./components/SharesTable";
import { StickyFilters } from "./components/StickyFilters";

function Shares() {
  const team = useCurrentTeam();
  const { t } = useTranslation();
  const location = useLocation();
  const history = useHistory();
  const { shares, auth } = useStores();
  const canShareDocuments = auth.team && auth.team.sharing;
  const can = usePolicy(team);
  const params = useQuery();
  const [query, setQuery] = useState("");

  const reqParams = useMemo(
    () => ({
      query: params.get("query") || undefined,
      sort: params.get("sort") || "createdAt",
      direction: (params.get("direction") || "desc").toUpperCase() as
        | "ASC"
        | "DESC",
    }),
    [params]
  );

  const sort: ColumnSort = useMemo(
    () => ({
      id: reqParams.sort,
      desc: reqParams.direction === "DESC",
    }),
    [reqParams.sort, reqParams.direction]
  );

  const { data, error, loading, next } = useTableRequest({
    data: shares.findByQuery(reqParams.query ?? ""),
    sort,
    reqFn: shares.fetchPage,
    reqParams,
  });

  const updateParams = useCallback(
    (name: string, value: string) => {
      if (value) {
        params.set(name, value);
      } else {
        params.delete(name);
      }

      history.replace({
        pathname: location.pathname,
        search: params.toString(),
      });
    },
    [params, history, location.pathname]
  );

  const handleSearch = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setQuery(value);
    },
    []
  );

  useEffect(() => {
    if (error) {
      toast.error(t("Could not load shares"));
    }
  }, [t, error]);

  useEffect(() => {
    const timeout = setTimeout(() => updateParams("query", query), 250);
    return () => clearTimeout(timeout);
  }, [query, updateParams]);

  return (
    <Scene title={t("Shared links")} icon={<GlobeIcon />} wide>
      <Heading>{t("Shared links")}</Heading>

      {can.update && !canShareDocuments && (
        <>
          <Notice icon={<WarningIcon />}>
            {t("Sharing is currently disabled.")}{" "}
            <Trans
              defaults="可在<em>安全设置</em>中统一启用或关闭内部分享。"
              components={{
                em: <Link to="/settings/security" />,
              }}
            />
          </Notice>
          <br />
        </>
      )}

      <Text as="p" type="secondary">
        以下为内部分享链接。同一工作区的有效员工须登录后只读访问，关闭或撤销后停止访问。
      </Text>

      <StickyFilters>
        <InputSearch
          short
          value={query}
          placeholder={`${t("Filter")}…`}
          onChange={handleSearch}
        />
      </StickyFilters>
      <ConditionalFade animate={!data}>
        <SharesTable
          data={data ?? []}
          sort={sort}
          canManage={can.update}
          loading={loading}
          page={{
            hasNext: !!next,
            fetchNext: next,
          }}
        />
      </ConditionalFade>
    </Scene>
  );
}

export default observer(Shares);
