import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import type {
  AcceptEntryConfig,
  AcceptEntryKind,
  AcceptServiceSpec,
  DiscoveredGitRepo,
} from "../api/types";

interface DraftAcceptServiceRow {
  name: string;
  cmd: string;
  cwd: string;
  dependsOnText: string;
  needsPort: boolean;
  primary: boolean;
  readyKind: "http" | "tcp" | "stdout_regex" | "delay";
  readyValue: string;
}

function defaultServiceRow(index: number, isDesktop = false): DraftAcceptServiceRow {
  return {
    name: index === 0 ? (isDesktop ? "app" : "web") : `svc${index + 1}`,
    cmd: "",
    cwd: "",
    dependsOnText: "",
    needsPort: !isDesktop,
    primary: index === 0,
    readyKind: isDesktop ? "delay" : "http",
    readyValue: isDesktop ? "500" : "/",
  };
}

function toServiceRows(services: readonly AcceptServiceSpec[]): DraftAcceptServiceRow[] {
  return services.map((s) => ({
    name: s.name,
    cmd: s.cmd,
    cwd: s.cwd ?? "",
    dependsOnText: (s.depends_on ?? []).join(", "),
    needsPort: s.needs_port ?? true,
    primary: Boolean(s.primary),
    readyKind: s.ready?.kind ?? "http",
    readyValue:
      s.ready?.kind === "http"
        ? s.ready.path
        : s.ready?.kind === "stdout_regex"
          ? s.ready.pattern
          : s.ready?.kind === "delay"
            ? String(s.ready.ms)
            : "",
  }));
}
import { useKilnStore } from "../state/store";

export function SpaceModal() {
  const { store, state } = useKilnStore();
  const {
    spaceModalOpen,
    editingSpaceId,
    spaceModalSelectInIntake,
    spaceModalPrefillPath,
    spaces,
    authMode,
    discoveredRepos,
    discoverBusy,
    discoverLoaded,
    discoverError,
    pickDirBusy,
  } = state;
  const editingSpace = editingSpaceId ? spaces[editingSpaceId] : undefined;
  const isEditing = Boolean(editingSpaceId);

  const [searchQuery, setSearchQuery] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [name, setName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [defaultAcceptCmd, setDefaultAcceptCmd] = useState("");
  const [copyUntracked, setCopyUntracked] = useState("");
  const [cloneDeps, setCloneDeps] = useState("");
  const [scriptSetup, setScriptSetup] = useState("");
  const [scriptDev, setScriptDev] = useState("");
  const [scriptTest, setScriptTest] = useState("");
  const [scriptLint, setScriptLint] = useState("");
  const [scriptDeliver, setScriptDeliver] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [quickBusyPath, setQuickBusyPath] = useState<string | null>(null);
  const [inspectInfo, setInspectInfo] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [suggestedAcceptEntry, setSuggestedAcceptEntry] =
    useState<AcceptEntryConfig | null>(null);
  const [acceptKind, setAcceptKind] = useState<AcceptEntryKind>("none");
  const [acceptPrepareCmd, setAcceptPrepareCmd] = useState("");
  const [acceptObserveHttp, setAcceptObserveHttp] = useState(true);
  const [acceptEntryHint, setAcceptEntryHint] = useState("");
  const [acceptServices, setAcceptServices] = useState<DraftAcceptServiceRow[]>([
    defaultServiceRow(0),
  ]);

  const applyAcceptConfigToForm = (cfg?: AcceptEntryConfig | null): void => {
    if (!cfg || cfg.kind === "none") {
      setAcceptKind("none");
      setAcceptPrepareCmd("");
      setAcceptObserveHttp(true);
      setAcceptEntryHint("");
      setAcceptServices([defaultServiceRow(0)]);
      return;
    }
    setAcceptKind(cfg.kind);
    setAcceptPrepareCmd(cfg.prepare_cmd ?? "");
    if (cfg.kind === "http_server") {
      setAcceptObserveHttp(cfg.observe_http ?? true);
      setAcceptEntryHint("");
      setAcceptServices(
        cfg.services.length > 0 ? toServiceRows(cfg.services) : [defaultServiceRow(0)],
      );
    } else if (cfg.kind === "desktop_app") {
      setAcceptObserveHttp(false);
      setAcceptEntryHint("");
      setAcceptServices(
        cfg.services.length > 0
          ? toServiceRows(cfg.services)
          : [defaultServiceRow(0, true)],
      );
    } else {
      setAcceptObserveHttp(false);
      setAcceptEntryHint(cfg.entry_hint ?? "");
      setAcceptServices([defaultServiceRow(0)]);
    }
  };

  const runInspect = async (
    targetPath: string,
    resetTouched = false,
  ): Promise<void> => {
    const raw = targetPath.trim();
    if (!raw) return;
    setInspectBusy(true);
    setErrorMsg(null);
    setInspectInfo(null);
    try {
      const info = await store.inspectSpace(raw);
      setRepoPath(info.repo_path);
      if (!isEditing && (resetTouched || !idTouched)) {
        setSpaceId(
          store.suggestUniqueSpaceId(info.suggested_id, info.repo_path),
        );
      }
      if (resetTouched || !nameTouched) {
        setName(info.suggested_name);
      }
      setDefaultBranch(info.default_branch);
      if (resetTouched || !defaultAcceptCmd.trim()) {
        setDefaultAcceptCmd(info.default_accept_cmd ?? "");
      }
      if (resetTouched || !cloneDeps.trim()) {
        setCloneDeps(info.clone_deps.join(", "));
      }
      setSuggestedAcceptEntry(info.suggested_accept_entry ?? null);
      setInspectInfo(
        `已识别 Git 仓库（分支：${info.default_branch}${
          info.default_accept_cmd
            ? ` · 默认验收：${info.default_accept_cmd}`
            : ""
        }）`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "识别 Git 仓库失败");
    } finally {
      setInspectBusy(false);
    }
  };

  useEffect(() => {
    if (!spaceModalOpen) return;
    setSearchQuery("");
    setInspectInfo(null);
    setErrorMsg(null);
    setInspectBusy(false);
    setSaveBusy(false);
    setQuickBusyPath(null);

    if (editingSpace) {
      setRepoPath(editingSpace.repo_path ?? "");
      setSpaceId(editingSpace.id);
      setName(editingSpace.name);
      setDefaultBranch(editingSpace.default_branch || "main");
      setDefaultAcceptCmd(editingSpace.default_accept_cmd ?? "");
      setCopyUntracked(editingSpace.copy_untracked.join(", "));
      setCloneDeps(editingSpace.clone_deps.join(", "));
      setScriptSetup(editingSpace.scripts?.setup ?? "");
      setScriptDev(editingSpace.scripts?.dev ?? "");
      setScriptTest(editingSpace.scripts?.test ?? "");
      setScriptLint(editingSpace.scripts?.lint ?? "");
      setScriptDeliver(editingSpace.scripts?.deliver ?? "");
      setIdTouched(true);
      setNameTouched(true);
      setSuggestedAcceptEntry(null);
      applyAcceptConfigToForm(editingSpace.accept_entry ?? null);
      return;
    }

    setRepoPath(spaceModalPrefillPath ?? "");
    setSpaceId("");
    setName("");
    setDefaultBranch("main");
    setDefaultAcceptCmd("");
    setCopyUntracked("");
    setCloneDeps("");
    setScriptSetup("");
    setScriptDev("");
    setScriptTest("");
    setScriptLint("");
    setScriptDeliver("");
    setIdTouched(false);
    setNameTouched(false);
    setSuggestedAcceptEntry(null);
    applyAcceptConfigToForm(null);

    void store.discoverLocalSpaces(true);
    if (spaceModalPrefillPath) {
      void runInspect(spaceModalPrefillPath, true);
    }
  }, [spaceModalOpen, editingSpaceId, spaceModalPrefillPath]);

  if (!spaceModalOpen) {
    return null;
  }

  const handleInspect = async (): Promise<void> => {
    if (inspectBusy) return;
    await runInspect(repoPath, false);
  };

  const handlePickFromFolder = async (): Promise<void> => {
    if (pickDirBusy || saveBusy) return;
    const picked = await store.pickSpaceDirectory();
    if (!picked) return;
    setRepoPath(picked);
    await runInspect(picked, true);
  };

  const handleSelectExisting = (spaceIdToUse: string): void => {
    if (spaceModalSelectInIntake) {
      store.selectIntakeProjectSpace(spaceIdToUse);
    }
    store.closeSpaceModal();
    const label = spaces[spaceIdToUse]?.name ?? spaceIdToUse;
    store.showToast(`已选择项目空间 ${label}`);
  };

  const handleQuickAdd = async (repo: DiscoveredGitRepo): Promise<void> => {
    if (quickBusyPath || saveBusy) return;
    setQuickBusyPath(repo.repo_path);
    setErrorMsg(null);
    try {
      await store.quickAddDiscoveredRepo(repo);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "添加项目空间失败");
    } finally {
      setQuickBusyPath(null);
    }
  };

  const handleSave = async (): Promise<void> => {
    const cleanId = spaceId.trim();
    const cleanName = name.trim();
    const cleanPath = repoPath.trim();
    const cleanBranch = defaultBranch.trim() || "main";
    if (!cleanId || !cleanName || !cleanPath || saveBusy) return;

    const splitList = (raw: string): string[] =>
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    const cleanScripts = {
      ...(scriptSetup.trim() ? { setup: scriptSetup.trim() } : {}),
      ...(scriptDev.trim() ? { dev: scriptDev.trim() } : {}),
      ...(scriptTest.trim() ? { test: scriptTest.trim() } : {}),
      ...(scriptLint.trim() ? { lint: scriptLint.trim() } : {}),
      ...(scriptDeliver.trim() ? { deliver: scriptDeliver.trim() } : {}),
    };
    const hasScripts = Object.keys(cleanScripts).length > 0;

    let builtAcceptEntry: AcceptEntryConfig | undefined;
    if (acceptKind === "none") {
      if (editingSpace?.accept_entry && editingSpace.accept_entry.kind !== "none") {
        builtAcceptEntry = { kind: "none" };
      }
    } else if (acceptKind === "cli_binary") {
      builtAcceptEntry = {
        kind: "cli_binary",
        ...(acceptPrepareCmd.trim() ? { prepare_cmd: acceptPrepareCmd.trim() } : {}),
        ...(acceptEntryHint.trim() ? { entry_hint: acceptEntryHint.trim() } : {}),
        required_capability: "cli",
      };
    } else {
      const validServices: AcceptServiceSpec[] = acceptServices
        .map((row) => {
          const cmd = row.cmd.trim();
          const svcName = row.name.trim();
          if (!cmd || !svcName) return null;
          const deps = row.dependsOnText
            .split(/[\n,]+/)
            .map((d) => d.trim())
            .filter(Boolean);
          const ready =
            row.readyKind === "http"
              ? { kind: "http" as const, path: row.readyValue.trim() || "/" }
              : row.readyKind === "tcp"
                ? { kind: "tcp" as const }
                : row.readyKind === "stdout_regex"
                  ? { kind: "stdout_regex" as const, pattern: row.readyValue.trim() || "ready" }
                  : {
                      kind: "delay" as const,
                      ms: Math.max(100, Number.parseInt(row.readyValue, 10) || 500),
                    };
          return {
            name: svcName,
            cmd,
            ...(row.cwd.trim() ? { cwd: row.cwd.trim() } : {}),
            needs_port: row.needsPort,
            primary: row.primary,
            depends_on: deps,
            ready,
            ready_timeout_ms: 30_000,
          } satisfies AcceptServiceSpec;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (validServices.length === 0) {
        setErrorMsg("请至少填写 1 个有效的真实验收服务名称与启动命令");
        return;
      }

      if (acceptKind === "http_server") {
        builtAcceptEntry = {
          kind: "http_server",
          ...(acceptPrepareCmd.trim() ? { prepare_cmd: acceptPrepareCmd.trim() } : {}),
          services: validServices,
          observe_http: acceptObserveHttp,
          required_capability: "browser",
        };
      } else {
        builtAcceptEntry = {
          kind: "desktop_app",
          ...(acceptPrepareCmd.trim() ? { prepare_cmd: acceptPrepareCmd.trim() } : {}),
          services: validServices,
          required_capability: "desktop_gui",
        };
      }
    }

    setSaveBusy(true);
    setErrorMsg(null);
    try {
      await store.saveSpace(cleanId, {
        name: cleanName,
        repo_path: cleanPath,
        default_branch: cleanBranch,
        copy_untracked: splitList(copyUntracked),
        clone_deps: splitList(cloneDeps),
        ...(defaultAcceptCmd.trim()
          ? { default_accept_cmd: defaultAcceptCmd.trim() }
          : {}),
        ...(builtAcceptEntry !== undefined ? { accept_entry: builtAcceptEntry } : {}),
        freeze_patterns: editingSpace?.freeze_patterns ?? [],
        ...(editingSpace?.pinned !== undefined ? { pinned: editingSpace.pinned } : {}),
        ...(hasScripts ? { scripts: cleanScripts } : {}),
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "保存项目空间失败");
    } finally {
      setSaveBusy(false);
    }
  };

  const q = searchQuery.trim().toLowerCase();
  const filteredRepos = discoveredRepos.filter((r) => {
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.display_path.toLowerCase().includes(q) ||
      r.repo_path.toLowerCase().includes(q)
    );
  });

  return (
    <Dialog.Root
      open={spaceModalOpen}
      onOpenChange={(open) => {
        if (!open && !saveBusy && !quickBusyPath) {
          store.closeSpaceModal();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="palette-mask open"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saveBusy && !quickBusyPath) {
              store.closeSpaceModal();
            }
          }}
        >
          <Dialog.Content
            className="modal-card modal-card-wide"
            aria-label={isEditing ? "编辑项目空间" : "添加项目空间"}
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              if (!saveBusy && !quickBusyPath) {
                store.closeSpaceModal();
              }
            }}
            onPointerDownOutside={(e) => {
              if (saveBusy || quickBusyPath) {
                e.preventDefault();
              }
            }}
            onInteractOutside={(e) => {
              if (saveBusy || quickBusyPath) {
                e.preventDefault();
              }
            }}
          >
            <div className="modal-head">
              <Dialog.Title asChild>
                <h2>{isEditing ? `编辑项目空间 · ${editingSpaceId}` : "添加项目空间"}</h2>
              </Dialog.Title>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => store.closeSpaceModal()}
              >
                关闭
              </button>
            </div>

        <div className="modal-body">
          {!isEditing ? (
            <section className="discover-section" aria-label="选择本机 Git 项目">
              <div className="discover-toolbar">
                <input
                  aria-label="搜索本机 Git 项目"
                  className="input"
                  placeholder="搜索本机扫描出的 Git 项目或路径…"
                  value={searchQuery}
                  onChange={(e) =>
                    setSearchQuery((e.currentTarget as HTMLInputElement).value)
                  }
                />
                {authMode === "local" ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={pickDirBusy || saveBusy}
                    onClick={() => void handlePickFromFolder()}
                  >
                    {pickDirBusy ? "等待选择…" : "从文件目录选择"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={discoverBusy}
                  onClick={() => void store.discoverLocalSpaces(true)}
                >
                  {discoverBusy ? "扫描中…" : "重新扫描"}
                </button>
              </div>

              {discoverError ? (
                <p className="warn-line" style={{ marginTop: "6px" }}>
                  {discoverError}
                </p>
              ) : (discoverBusy || !discoverLoaded) && discoveredRepos.length === 0 ? (
                <div className="discover-empty">
                  正在扫描常见代码目录中的 Git 项目…
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="discover-empty">
                  {discoveredRepos.length === 0
                    ? "未在常见目录扫描到 Git 项目，可点击「从文件目录选择」或下方手动输入路径。"
                    : "没有匹配的 Git 项目，请调整关键词或从文件目录选择。"}
                </div>
              ) : (
                <div className="discover-list" role="list">
                  {filteredRepos.map((repo) => {
                    const isExisting = repo.already_added && Boolean(repo.space_id);
                    const isQuickBusy = quickBusyPath === repo.repo_path;
                    return (
                      <div key={repo.repo_path} className="discover-item" role="listitem">
                        <button
                          type="button"
                          className="discover-main"
                          onClick={() => {
                            if (isExisting && repo.space_id && spaceModalSelectInIntake) {
                              handleSelectExisting(repo.space_id);
                              return;
                            }
                            setRepoPath(repo.repo_path);
                            void runInspect(repo.repo_path, true);
                          }}
                        >
                          <div className="discover-title-row">
                            <span className="discover-name">{repo.name}</span>
                            <span className="chip mono">{repo.default_branch}</span>
                            {isExisting ? (
                              <span className="chip chip-ok">已添加</span>
                            ) : null}
                          </div>
                          <div className="discover-path mono" title={repo.repo_path}>
                            {repo.display_path}
                          </div>
                        </button>
                        <div className="discover-act">
                          {isExisting && repo.space_id ? (
                            spaceModalSelectInIntake ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-light"
                                onClick={() => handleSelectExisting(repo.space_id!)}
                              >
                                选用
                              </button>
                            ) : null
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-light"
                              disabled={quickBusyPath !== null || saveBusy}
                              onClick={() => void handleQuickAdd(repo)}
                            >
                              {isQuickBusy ? "添加中…" : "一键添加"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          <div className="modal-field">
            <label htmlFor="spaceRepoPath">仓库路径</label>
            <div className="modal-row">
              <input
                id="spaceRepoPath"
                aria-label="仓库路径"
                className="input mono"
                placeholder="/Users/you/Projects/my-app 或 ~/Projects/my-app"
                value={repoPath}
                onChange={(e) =>
                  setRepoPath((e.currentTarget as HTMLInputElement).value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleInspect();
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={!repoPath.trim() || inspectBusy}
                onClick={() => void handleInspect()}
              >
                {inspectBusy ? "识别中…" : "识别仓库"}
              </button>
            </div>
          </div>

          {inspectInfo ? <p className="modal-ok">{inspectInfo}</p> : null}
          {errorMsg ? (
            <p className="warn-line" role="alert" style={{ marginTop: "0" }}>
              {errorMsg}
            </p>
          ) : null}

          <div className="modal-grid">
            <label className="modal-field">
              <span>空间标识</span>
              <input
                aria-label="空间标识"
                className="input mono"
                placeholder="如 kiln"
                value={spaceId}
                disabled={isEditing}
                onChange={(e) => {
                  setIdTouched(true);
                  setSpaceId((e.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>

            <label className="modal-field">
              <span>显示名称</span>
              <input
                aria-label="显示名称"
                className="input"
                placeholder="如 Kiln 本体"
                value={name}
                onChange={(e) => {
                  setNameTouched(true);
                  setName((e.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
          </div>

          <div className="modal-grid">
            <label className="modal-field">
              <span>默认分支</span>
              <input
                aria-label="默认分支"
                className="input mono"
                placeholder="main"
                value={defaultBranch}
                onChange={(e) =>
                  setDefaultBranch((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>

            <label className="modal-field">
              <span>默认验收命令（可选）</span>
              <input
                aria-label="默认验收命令"
                className="input mono"
                placeholder="如 pnpm test"
                value={defaultAcceptCmd}
                onChange={(e) =>
                  setDefaultAcceptCmd((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
          </div>

          <details className="modal-advanced">
            <summary>高级设置（环境文件、依赖克隆与项目脚本）</summary>
            <div className="modal-grid" style={{ marginTop: "10px" }}>
              <label className="modal-field">
                <span>复制未跟踪文件</span>
                <input
                  aria-label="复制未跟踪文件"
                  className="input mono"
                  placeholder="如 .env.local（逗号分隔）"
                  value={copyUntracked}
                  onChange={(e) =>
                    setCopyUntracked((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>

              <label className="modal-field">
                <span>APFS 克隆依赖目录</span>
                <input
                  aria-label="APFS 克隆依赖目录"
                  className="input mono"
                  placeholder="如 node_modules（逗号分隔）"
                  value={cloneDeps}
                  onChange={(e) =>
                    setCloneDeps((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
            </div>

            <div className="script-grid" style={{ marginTop: "12px" }}>
              <label className="modal-field">
                <span>setup 脚本（创建工作树自动跑）</span>
                <input
                  aria-label="setup 脚本"
                  className="input mono"
                  placeholder="如 pnpm install --frozen-lockfile"
                  value={scriptSetup}
                  onChange={(e) =>
                    setScriptSetup((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
              <label className="modal-field">
                <span>dev 脚本</span>
                <input
                  aria-label="dev 脚本"
                  className="input mono"
                  placeholder="如 pnpm dev"
                  value={scriptDev}
                  onChange={(e) =>
                    setScriptDev((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
              <label className="modal-field">
                <span>test 脚本</span>
                <input
                  aria-label="test 脚本"
                  className="input mono"
                  placeholder="如 pnpm test"
                  value={scriptTest}
                  onChange={(e) =>
                    setScriptTest((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
              <label className="modal-field">
                <span>lint 脚本</span>
                <input
                  aria-label="lint 脚本"
                  className="input mono"
                  placeholder="如 pnpm typecheck"
                  value={scriptLint}
                  onChange={(e) =>
                    setScriptLint((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
              <label className="modal-field">
                <span>deliver 脚本</span>
                <input
                  aria-label="deliver 脚本"
                  className="input mono"
                  placeholder="可选交付后置命令"
                  value={scriptDeliver}
                  onChange={(e) =>
                    setScriptDeliver((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
            </div>
          </details>

          <details
            className="modal-advanced"
            open={acceptKind !== "none" || suggestedAcceptEntry !== null}
          >
            <summary>真实验收入口（accept_entry · 多进程隔离拉起）</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" }}>
              <div className="modal-row" style={{ flexWrap: "wrap" }}>
                <label className="modal-field" style={{ flex: "1 1 200px" }}>
                  <span>入口模式</span>
                  <select
                    aria-label="真实验收入口模式"
                    className="select"
                    value={acceptKind}
                    onChange={(e) => {
                      const next = (e.currentTarget as HTMLSelectElement).value as AcceptEntryKind;
                      setAcceptKind(next);
                      if (next === "desktop_app" && acceptServices.length === 1 && !acceptServices[0]?.cmd) {
                        setAcceptServices([defaultServiceRow(0, true)]);
                      }
                    }}
                  >
                    <option value="none">不自动拉起（none）</option>
                    <option value="http_server">Web / API 服务组合（http_server）</option>
                    <option value="desktop_app">桌面 GUI 应用（desktop_app）</option>
                    <option value="cli_binary">CLI / 产物检查（cli_binary）</option>
                  </select>
                </label>

                {suggestedAcceptEntry ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ alignSelf: "flex-end" }}
                    onClick={() => applyAcceptConfigToForm(suggestedAcceptEntry)}
                  >
                    应用推荐配置
                  </button>
                ) : null}
              </div>

              {acceptKind !== "none" ? (
                <label className="modal-field">
                  <span>前置准备命令（prepare_cmd，可选）</span>
                  <input
                    aria-label="前置准备命令"
                    className="input mono"
                    placeholder="如 pnpm build（启动服务前同步执行）"
                    value={acceptPrepareCmd}
                    onChange={(e) =>
                      setAcceptPrepareCmd((e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </label>
              ) : null}

              {acceptKind === "cli_binary" ? (
                <label className="modal-field">
                  <span>验收入口提示（entry_hint，可选）</span>
                  <input
                    aria-label="验收入口提示"
                    className="input mono"
                    placeholder="如 node dist/cli.js --help"
                    value={acceptEntryHint}
                    onChange={(e) =>
                      setAcceptEntryHint((e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </label>
              ) : null}

              {acceptKind === "http_server" || acceptKind === "desktop_app" ? (
                <>
                  {acceptKind === "http_server" ? (
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "12px",
                        color: "var(--t2)",
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label="启用 HTTP 透明流量观测代理"
                        checked={acceptObserveHttp}
                        onChange={(e) =>
                          setAcceptObserveHttp((e.currentTarget as HTMLInputElement).checked)
                        }
                      />
                      <span>启用本地透明流量观测代理（零请求直接拦截防假验收，捕获 4xx/5xx）</span>
                    </label>
                  ) : null}

                  {acceptServices.map((row, idx) => (
                    <div key={idx} className="accept-svc-card">
                      <div className="modal-grid">
                        <label className="modal-field">
                          <span>服务名 #{idx + 1}</span>
                          <input
                            aria-label={`服务名 ${idx + 1}`}
                            className="input mono"
                            placeholder="如 api 或 web"
                            value={row.name}
                            onChange={(e) => {
                              const v = (e.currentTarget as HTMLInputElement).value;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, name: v } : it)),
                              );
                            }}
                          />
                        </label>
                        <label className="modal-field">
                          <span>启动命令（支持 {"{{port}}"} {"{{ports.api}}"} {"{{tmpdir}}"}）</span>
                          <input
                            aria-label={`启动命令 ${idx + 1}`}
                            className="input mono"
                            placeholder="如 pnpm dev -- --port {{port}}"
                            value={row.cmd}
                            onChange={(e) => {
                              const v = (e.currentTarget as HTMLInputElement).value;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, cmd: v } : it)),
                              );
                            }}
                          />
                        </label>
                      </div>

                      <div className="modal-grid">
                        <label className="modal-field">
                          <span>子目录 cwd（可选相对路径）</span>
                          <input
                            aria-label={`子目录 ${idx + 1}`}
                            className="input mono"
                            placeholder="如 apps/web"
                            value={row.cwd}
                            onChange={(e) => {
                              const v = (e.currentTarget as HTMLInputElement).value;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, cwd: v } : it)),
                              );
                            }}
                          />
                        </label>
                        <label className="modal-field">
                          <span>依赖服务 depends_on（逗号分隔）</span>
                          <input
                            aria-label={`依赖服务 ${idx + 1}`}
                            className="input mono"
                            placeholder="如 api"
                            value={row.dependsOnText}
                            onChange={(e) => {
                              const v = (e.currentTarget as HTMLInputElement).value;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, dependsOnText: v } : it)),
                              );
                            }}
                          />
                        </label>
                      </div>

                      <div className="modal-row" style={{ flexWrap: "wrap" }}>
                        <select
                          aria-label={`就绪探针 ${idx + 1}`}
                          className="select"
                          style={{ width: "130px" }}
                          value={row.readyKind}
                          onChange={(e) => {
                            const k = (e.currentTarget as HTMLSelectElement).value as DraftAcceptServiceRow["readyKind"];
                            setAcceptServices((prev) =>
                              prev.map((it, i) =>
                                i === idx
                                  ? {
                                      ...it,
                                      readyKind: k,
                                      readyValue:
                                        k === "http" ? "/" : k === "delay" ? "500" : it.readyValue,
                                    }
                                  : it,
                              ),
                            );
                          }}
                        >
                          <option value="http">HTTP 探针</option>
                          <option value="tcp">TCP 端口</option>
                          <option value="stdout_regex">日志正则</option>
                          <option value="delay">固定延时</option>
                        </select>
                        {row.readyKind !== "tcp" ? (
                          <input
                            aria-label={`探针参数 ${idx + 1}`}
                            className="input mono"
                            style={{ maxWidth: "160px" }}
                            value={row.readyValue}
                            placeholder={row.readyKind === "http" ? "/" : "ready"}
                            onChange={(e) => {
                              const v = (e.currentTarget as HTMLInputElement).value;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, readyValue: v } : it)),
                              );
                            }}
                          />
                        ) : null}
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
                          <input
                            type="checkbox"
                            checked={row.needsPort}
                            onChange={(e) => {
                              const c = (e.currentTarget as HTMLInputElement).checked;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, needsPort: c } : it)),
                              );
                            }}
                          />
                          <span>分配端口</span>
                        </label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px" }}>
                          <input
                            type="checkbox"
                            checked={row.primary}
                            onChange={(e) => {
                              const c = (e.currentTarget as HTMLInputElement).checked;
                              setAcceptServices((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, primary: c } : c ? { ...it, primary: false } : it)),
                              );
                            }}
                          />
                          <span>主入口</span>
                        </label>
                        {acceptServices.length > 1 ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() =>
                              setAcceptServices((prev) => prev.filter((_, i) => i !== idx))
                            }
                          >
                            移除
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}

                  {acceptServices.length < 4 ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ alignSelf: "flex-start" }}
                      onClick={() =>
                        setAcceptServices((prev) => [
                          ...prev,
                          defaultServiceRow(prev.length, acceptKind === "desktop_app"),
                        ])
                      }
                    >
                      + 添加进程（前后端拆分）
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </details>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn"
            disabled={saveBusy || quickBusyPath !== null}
            onClick={() => store.closeSpaceModal()}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-light"
            disabled={
              saveBusy ||
              quickBusyPath !== null ||
              !spaceId.trim() ||
              !name.trim() ||
              !repoPath.trim()
            }
            onClick={() => void handleSave()}
          >
            {saveBusy ? "保存中…" : "保存空间"}
          </button>
        </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
