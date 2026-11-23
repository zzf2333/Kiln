import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { DiscoveredGitRepo } from "../api/types";
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
