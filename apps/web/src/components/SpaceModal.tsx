import { useEffect, useState } from "preact/hooks";
import { useKilnStore } from "../state/store";

export function SpaceModal() {
  const { store, state } = useKilnStore();
  const { spaceModalOpen, editingSpaceId, spaces } = state;
  const editingSpace = editingSpaceId ? spaces[editingSpaceId] : undefined;
  const isEditing = Boolean(editingSpaceId);

  const [repoPath, setRepoPath] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [name, setName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [defaultAcceptCmd, setDefaultAcceptCmd] = useState("");
  const [copyUntracked, setCopyUntracked] = useState("");
  const [cloneDeps, setCloneDeps] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [inspectInfo, setInspectInfo] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!spaceModalOpen) return;
    if (editingSpace) {
      setRepoPath(editingSpace.repo_path ?? "");
      setSpaceId(editingSpace.id);
      setName(editingSpace.name);
      setDefaultBranch(editingSpace.default_branch || "main");
      setDefaultAcceptCmd(editingSpace.default_accept_cmd ?? "");
      setCopyUntracked(editingSpace.copy_untracked.join(", "));
      setCloneDeps(editingSpace.clone_deps.join(", "));
      setIdTouched(true);
      setNameTouched(true);
    } else {
      setRepoPath("");
      setSpaceId("");
      setName("");
      setDefaultBranch("main");
      setDefaultAcceptCmd("");
      setCopyUntracked("");
      setCloneDeps("");
      setIdTouched(false);
      setNameTouched(false);
    }
    setInspectInfo(null);
    setErrorMsg(null);
    setInspectBusy(false);
    setSaveBusy(false);
  }, [spaceModalOpen, editingSpaceId]);

  if (!spaceModalOpen) {
    return null;
  }

  const handleInspect = async (): Promise<void> => {
    const raw = repoPath.trim();
    if (!raw || inspectBusy) return;
    setInspectBusy(true);
    setErrorMsg(null);
    setInspectInfo(null);
    try {
      const info = await store.inspectSpace(raw);
      setRepoPath(info.repo_path);
      if (!isEditing && !idTouched) {
        setSpaceId(info.suggested_id);
      }
      if (!nameTouched) {
        setName(info.suggested_name);
      }
      setDefaultBranch(info.default_branch);
      if (!defaultAcceptCmd.trim() && info.default_accept_cmd) {
        setDefaultAcceptCmd(info.default_accept_cmd);
      }
      if (!cloneDeps.trim() && info.clone_deps.length > 0) {
        setCloneDeps(info.clone_deps.join(", "));
      }
      setInspectInfo(
        `已识别 Git 仓库（分支：${info.default_branch}${
          info.default_accept_cmd ? ` · 默认验收：${info.default_accept_cmd}` : ""
        }）`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "识别 Git 仓库失败");
    } finally {
      setInspectBusy(false);
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
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "保存项目空间失败");
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <div
      class="palette-mask open"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saveBusy) {
          store.closeSpaceModal();
        }
      }}
    >
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? "编辑项目空间" : "添加项目空间"}
      >
        <div class="modal-head">
          <h2>{isEditing ? `编辑项目空间 · ${editingSpaceId}` : "添加项目空间"}</h2>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => store.closeSpaceModal()}
          >
            关闭
          </button>
        </div>

        <div class="modal-body">
          <div class="modal-field">
            <label for="spaceRepoPath">仓库路径</label>
            <div class="modal-row">
              <input
                id="spaceRepoPath"
                aria-label="仓库路径"
                class="input mono"
                placeholder="/Users/you/Projects/my-app 或 ~/Projects/my-app"
                value={repoPath}
                onInput={(e) =>
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
                class="btn"
                disabled={!repoPath.trim() || inspectBusy}
                onClick={() => void handleInspect()}
              >
                {inspectBusy ? "识别中…" : "识别仓库"}
              </button>
            </div>
          </div>

          {inspectInfo ? <p class="modal-ok">{inspectInfo}</p> : null}
          {errorMsg ? (
            <p class="warn-line" role="alert" style={{ marginTop: "0" }}>
              {errorMsg}
            </p>
          ) : null}

          <div class="modal-grid">
            <label class="modal-field">
              <span>空间标识</span>
              <input
                aria-label="空间标识"
                class="input mono"
                placeholder="如 kiln"
                value={spaceId}
                disabled={isEditing}
                onInput={(e) => {
                  setIdTouched(true);
                  setSpaceId((e.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>

            <label class="modal-field">
              <span>显示名称</span>
              <input
                aria-label="显示名称"
                class="input"
                placeholder="如 Kiln 本体"
                value={name}
                onInput={(e) => {
                  setNameTouched(true);
                  setName((e.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
          </div>

          <div class="modal-grid">
            <label class="modal-field">
              <span>默认分支</span>
              <input
                aria-label="默认分支"
                class="input mono"
                placeholder="main"
                value={defaultBranch}
                onInput={(e) =>
                  setDefaultBranch((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>

            <label class="modal-field">
              <span>默认验收命令（可选）</span>
              <input
                aria-label="默认验收命令"
                class="input mono"
                placeholder="如 pnpm test"
                value={defaultAcceptCmd}
                onInput={(e) =>
                  setDefaultAcceptCmd((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
          </div>

          <details class="modal-advanced">
            <summary>高级设置（环境文件与依赖克隆）</summary>
            <div class="modal-grid" style={{ marginTop: "10px" }}>
              <label class="modal-field">
                <span>复制未跟踪文件</span>
                <input
                  aria-label="复制未跟踪文件"
                  class="input mono"
                  placeholder="如 .env.local（逗号分隔）"
                  value={copyUntracked}
                  onInput={(e) =>
                    setCopyUntracked((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>

              <label class="modal-field">
                <span>APFS 克隆依赖目录</span>
                <input
                  aria-label="APFS 克隆依赖目录"
                  class="input mono"
                  placeholder="如 node_modules（逗号分隔）"
                  value={cloneDeps}
                  onInput={(e) =>
                    setCloneDeps((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
            </div>
          </details>
        </div>

        <div class="modal-foot">
          <button
            type="button"
            class="btn"
            disabled={saveBusy}
            onClick={() => store.closeSpaceModal()}
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn-light"
            disabled={saveBusy || !spaceId.trim() || !name.trim() || !repoPath.trim()}
            onClick={() => void handleSave()}
          >
            {saveBusy ? "保存中…" : "保存空间"}
          </button>
        </div>
      </div>
    </div>
  );
}
