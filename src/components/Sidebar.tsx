import type { Conversation, Transport } from "../types";
import { GhostButton, Icon, IconButton } from "./ui";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  keyword: string;
  transport: Transport;
  /** 通道探测是否已完成 */
  ready: boolean;
  onKeyword: (v: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onCollapse: () => void;
  onImport: () => void;
  onExport: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  keyword,
  transport,
  ready,
  onKeyword,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onCollapse,
  onImport,
  onExport,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar" id="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="22" height="22">
            <defs>
              <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#7c5cff" />
                <stop offset="1" stopColor="#4ea8ff" />
              </linearGradient>
            </defs>
            <rect width="64" height="64" rx="16" fill="url(#brandGrad)" />
            <text x="32" y="42" fontSize="26" fontFamily="Verdana, Geneva, sans-serif" fontWeight="700" textAnchor="middle" fill="#fff">
              zxz
            </text>
          </svg>
        </span>
        <span className="brand-text">zxz</span>
        <IconButton id="btnCollapse" className="icon-btn ghost collapse-btn" title="收起侧边栏" name="collapse" onClick={onCollapse} />
      </div>

      <button className="new-chat" id="btnNew" onClick={onNew}>
        <Icon name="plus" />
        <span>新建对话</span>
      </button>

      <div className="search">
        <Icon name="search" />
        <input
          id="searchConv"
          type="search"
          placeholder="搜索对话"
          autoComplete="off"
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
        />
      </div>

      <nav className="conv-list" id="convList" aria-label="对话列表">
        {conversations.length === 0 ? (
          <p className="empty-list">{keyword.trim() ? "没有匹配的对话" : "还没有对话，点上方「新建对话」开始"}</p>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={"conv-item" + (conv.id === activeId ? " active" : "")}
              onClick={() => onSelect(conv.id)}
              onDoubleClick={() => onRename(conv.id)}
            >
              <span className="title">{conv.title || "未命名对话"}</span>
              <button
                className="del"
                type="button"
                title="删除对话"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
              >
                <svg viewBox="0 0 24 24" className="ico">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </nav>

      <div className="sidebar-foot">
        <div
          className={"transport" + (!ready ? "" : transport.mode === "proxy" ? " ok" : " warn")}
          id="transport"
          title="当前请求通道"
        >
          <span className="dot" />
          <span id="transportText">
            {!ready
              ? "检测中"
              : transport.mode === "proxy"
                ? `本地代理 :${transport.port}`
                : "浏览器直连（可能受跨域限制）"}
          </span>
        </div>
        <div className="foot-row">
          <GhostButton id="btnImport" onClick={onImport} title="导入对话 JSON">
            导入
          </GhostButton>
          <GhostButton id="btnExport" onClick={onExport} title="导出全部对话">
            导出
          </GhostButton>
        </div>
        <button className="ghost-btn wide" id="btnSettings" onClick={onOpenSettings}>
          <Icon name="gear" />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
