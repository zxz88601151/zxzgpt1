import type { Theme, Workspace } from "../types";
import { Icon, IconButton } from "./ui";

interface TopBarProps {
  title: string;
  model: string;
  workspace: Workspace | null;
  theme: Theme;
  showRegen: boolean;
  onOpenSidebar: () => void;
  onRegen: () => void;
  onClear: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  /** 写入历史（只在本地工程模式下出现） */
  onOpenUndo: () => void;
}

export function TopBar({
  title,
  model,
  workspace,
  theme,
  showRegen,
  onOpenSidebar,
  onRegen,
  onClear,
  onToggleTheme,
  onOpenSettings,
  onOpenWorkspace,
  onOpenUndo,
}: TopBarProps) {
  return (
    <header className="topbar">
      <IconButton id="btnOpenSidebar" title="展开侧边栏" name="menu" onClick={onOpenSidebar} />
      <h1 className="conv-title" id="convTitle">
        {title}
      </h1>
      <button
        className={"model-pill" + (model ? "" : " unset")}
        id="modelPill"
        title="点击打开设置切换模型"
        type="button"
        onClick={onOpenSettings}
      >
        <span className="pill-dot" />
        <span id="modelName">{model || "未配置模型"}</span>
      </button>
      <button
        className={"ws-chip" + (workspace ? " on" : "")}
        id="btnWorkspace"
        type="button"
        title={workspace ? `工程目录：${workspace.root}\n点击更换` : "选择本地文件夹，让模型把代码写进去"}
        onClick={onOpenWorkspace}
      >
        <Icon name="folder" size={13} />
        <span className="ws-name">{workspace ? workspace.name : "选文件夹"}</span>
      </button>
      <div className="spacer" />
      <IconButton
        id="btnUndo"
        title="写入历史：看每个文件改了什么，随时退回上一版"
        name="history"
        onClick={onOpenUndo}
        hidden={!workspace}
      />
      <IconButton id="btnRegen" title="重新生成最后一条回复" name="refresh" onClick={onRegen} hidden={!showRegen} />
      <IconButton id="btnClearConv" title="清空当前对话" name="trash" onClick={onClear} />
      <IconButton id="btnTheme" title="切换主题" name={theme === "light" ? "sun" : "moon"} onClick={onToggleTheme} />
    </header>
  );
}
