import React, { createContext, useContext } from "react";
import avatarSm from "../assets/avatar-sm.png";

/* ---------------------------------------------------------------- 图标 */

const PATHS = {
  collapse: '<path d="M14 6 8 12l6 6" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  search: '<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />',
  gear:
    '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 4.4 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1z" />',
  menu: '<path d="M4 6h16M4 12h16M4 18h16" />',
  refresh: '<path d="M21 12a9 9 0 1 1-3.2-6.9" /><path d="M21 4v5h-5" />',
  trash:
    '<path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />',
  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7" />',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />',
  close: '<path d="M6 6l12 12M18 6 6 18" />',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  file: '<path d="M6 3h7l5 5v13H6z" /><path d="M13 3v5h5" />',
  up: '<path d="M12 19V5M5 12l7-7 7 7" />',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3 4v4.5h4.5" /><path d="M12 8v4.4l3 1.8" />',
  layers: '<path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" />',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size, id }: { name: IconName; size?: number; id?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="ico"
      id={id}
      width={size}
      height={size}
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

/* ---------------------------------------------------------------- 按钮 */

interface IconButtonProps {
  id?: string;
  title: string;
  name: IconName;
  onClick?: () => void;
  hidden?: boolean;
  /** 额外 class，默认 "icon-btn ghost" */
  className?: string;
  disabled?: boolean;
}

export function IconButton({ id, title, name, onClick, hidden, className, disabled }: IconButtonProps) {
  return (
    <button
      id={id}
      type="button"
      className={className || "icon-btn ghost"}
      title={title}
      aria-label={title}
      onClick={onClick}
      hidden={hidden}
      disabled={disabled}
    >
      <Icon name={name} />
    </button>
  );
}

export function GhostButton({
  id,
  children,
  onClick,
  title,
  className,
  type,
}: {
  id?: string;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button id={id} type={type || "button"} className={className || "ghost-btn"} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Toast */

export type ToastKind = "" | "ok" | "error";
export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

export type PushToast = (text: string, kind?: ToastKind) => void;

export const ToastContext = createContext<PushToast>(() => {});

export function useToast(): PushToast {
  return useContext(ToastContext);
}

export function Toasts({ list }: { list: ToastItem[] }) {
  return (
    <div className="toast-host" id="toastHost">
      {list.map((t) => (
        <div key={t.id} className={"toast" + (t.kind ? " " + t.kind : "")}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- 头像 */

export function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "user") {
    return (
      <span className="avatar user">
        <img src={avatarSm} alt="我" draggable={false} />
      </span>
    );
  }
  return (
    <span className="avatar">
      <svg viewBox="0 0 64 64" width="16" height="16">
        <rect width="64" height="64" rx="16" fill="#7c5cff" />
        <text x="32" y="42" fontSize="24" fontFamily="Verdana,sans-serif" fontWeight="700" textAnchor="middle" fill="#fff">
          z
        </text>
      </svg>
    </span>
  );
}
