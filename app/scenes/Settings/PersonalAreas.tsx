import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { UserIcon } from "outline-icons";
import styled from "styled-components";
import type { NavigationNode } from "@shared/types";
import { client } from "~/utils/ApiClient";
import useCurrentUser from "~/hooks/useCurrentUser";
import Scene from "~/components/Scene";
import Heading from "~/components/Heading";
import Button from "~/components/Button";
import Text from "~/components/Text";

interface Employee {
  id: string;
  name: string;
  role: string;
}
interface PersonalArea {
  id: string;
  ownerId: string;
}
interface Page<T> {
  data: T[];
  pagination: { total: number };
}

/** 分页查看员工的原生个人目录；管理入口仅提供读取，权限由服务端再次校验。 */
export const PersonalAreas = observer(function PersonalAreas() {
  const user = useCurrentUser();
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [areas, setAreas] = useState<PersonalArea[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Employee>();
  const [nodes, setNodes] = useState<NavigationNode[]>([]);
  const [extras, setExtras] = useState<NavigationNode[]>([]);
  const [extraOffset, setExtraOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!user.isAdmin) {
      return;
    }
    let active = true;
    setLoading(true);
    setSelected(undefined);
    setNodes([]);
    void client
      .post<Page<Employee>>("/users.list", {
        query: applied,
        offset,
        limit: 50,
      })
      .then(async (response) => {
        const personal = response.data.length
          ? await client.post<Page<PersonalArea>>("/collections.list", {
              filters: [
                {
                  field: "ownerId",
                  operator: "in",
                  value: response.data.map((row) => row.id),
                },
              ],
              limit: 100,
            })
          : { data: [] };
        if (active) {
          setEmployees(response.data);
          setAreas(personal.data);
          setTotal(response.pagination.total);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setEmployees([]);
          setAreas([]);
          setError("个人区域查询失败，请检查权限或稍后重试。");
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
  }, [applied, offset, refresh, user.isAdmin]);
  useEffect(() => {
    const area = areas.find((row) => row.ownerId === selected?.id);
    if (!user.isAdmin || !selected || !area) {
      setNodes([]);
      return;
    }
    let active = true;
    setNodes([]);
    void Promise.all([
      client.post<{ data: NavigationNode[] }>("/collections.documents", {
        id: area.id,
      }),
      client.post<{ data: NavigationNode[] }>("/documents.list", {
        collectionId: area.id,
        statusFilter: ["draft", "archived"],
        offset: extraOffset,
        limit: 50,
      }),
    ])
      .then(([response, additional]) => {
        if (active) {
          setNodes(response.data);
          setExtras(additional.data);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setNodes([]);
          setError("个人目录读取失败，权限可能已经变化。");
        }
      });
    return () => {
      active = false;
    };
  }, [selected, areas, extraOffset, user.isAdmin]);
  if (!user.isAdmin) {
    return <Text>仅工作区管理员可以查看个人区域管理。</Text>;
  }
  return (
    <Scene title="个人区域管理" icon={<UserIcon />}>
      <Heading>个人区域管理</Heading>
      <Text as="p">
        此入口用于查阅员工个人资料，访问会记入风险审计，不提供修改、授权、导出或打印功能。
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(query);
          setOffset(0);
          setRefresh((value) => value + 1);
        }}
      >
        <label>
          员工姓名{" "}
          <input
            aria-label="员工姓名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>{" "}
        <Button type="submit">查询</Button>
      </form>
      {error && <Text role="alert">{error}</Text>}
      {loading && <Text>正在加载…</Text>}
      <Table>
        <thead>
          <tr>
            <th>员工</th>
            <th>个人区域</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((employee) => (
            <tr key={employee.id}>
              <td>{employee.name}</td>
              <td>
                {areas.some((area) => area.ownerId === employee.id) ? (
                  <Button
                    onClick={() => {
                      setSelected(employee);
                      setExtraOffset(0);
                    }}
                  >
                    查看 {employee.name} 的个人区域
                  </Button>
                ) : employee.role === "guest" ? (
                  "访客不开放个人区域"
                ) : (
                  "尚未创建"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Button
        disabled={offset === 0 || loading}
        onClick={() => setOffset(Math.max(0, offset - 50))}
      >
        上一页
      </Button>{" "}
      <Button
        disabled={offset + employees.length >= total || loading}
        onClick={() => setOffset(offset + 50)}
      >
        下一页
      </Button>
      {selected && (
        <section aria-label={`${selected.name} 的个人目录`}>
          <Heading as="h2">{selected.name} 的个人目录</Heading>
          {nodes.length ? (
            <PersonalTree nodes={nodes} />
          ) : (
            <Text>当前没有已发布文档。</Text>
          )}
          <Heading as="h3">草稿与归档文档</Heading>
          {extras.length ? (
            <PersonalTree nodes={extras} />
          ) : (
            <Text>当前没有草稿或归档文档。</Text>
          )}
          <Button
            disabled={extraOffset === 0}
            onClick={() => setExtraOffset(Math.max(0, extraOffset - 50))}
          >
            前一页资料
          </Button>{" "}
          <Button
            disabled={extras.length < 50}
            onClick={() => setExtraOffset(extraOffset + 50)}
          >
            更多资料
          </Button>
        </section>
      )}
    </Scene>
  );
});

/** 保留实际文档树及根路径链接，不生成写入或分享动作。 */
function PersonalTree({ nodes }: { nodes: NavigationNode[] }) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.id}>
          <Link to={node.url}>{node.title || "无标题"}</Link>
          {!!node.children?.length && <PersonalTree nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

const Table = styled.table`
  width: 100%;
  margin: 16px 0;
  text-align: left;
  td,
  th {
    padding: 8px;
  }
`;
