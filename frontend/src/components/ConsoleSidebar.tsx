import { useEffect, useId, useRef } from "react";
import { NavLink } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { catalogPath, catalogTitles } from "../catalog/navigation";
import type { CatalogResource } from "../catalog/types";

type NavSection = CatalogResource | "telemetry" | "monitoring" | "logs";

interface NavigationGroup {
  title?: string;
  resources: NavSection[];
}

const groups: NavigationGroup[] = [
  { resources: ["telemetry", "monitoring", "logs"] },
  { title: "供给侧", resources: ["providers", "provider-models"] },
  { title: "调用侧", resources: ["projects", "project-models"] },
  { resources: ["routes"] },
];

function navTarget(resource: NavSection): string {
  if (resource === "telemetry") return "/";
  if (resource === "monitoring") return "/data";
  if (resource === "logs") return "/logs";
  return catalogPath(resource);
}

function navLabel(resource: NavSection): string {
  if (resource === "telemetry") return "统计总览";
  if (resource === "monitoring") return "数据";
  if (resource === "logs") return "请求日志";
  return catalogTitles[resource];
}

function ConsoleNavigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="主导航" className="console-nav">
      {groups.map(({ title, resources }) => (
        <div key={resources[0]} className="console-nav-group">
          {title ? <span className="console-nav-label">{title}</span> : null}
          {resources.map((resource) => (
            <NavLink
              key={resource}
              end
              to={navTarget(resource)}
              className={({ isActive }) => `console-nav-link${isActive ? " active" : ""}`}
              onClick={onNavigate}
            >
              {navLabel(resource)}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function ConsoleUserFooter() {
  const { user, logout } = useAuth();
  const label = user?.displayName || user?.email || user?.subject || "";
  return (
    <div className="console-user-footer">
      {label ? <span className="console-user-name" title={label}>{label}</span> : null}
      <button type="button" className="btn-control" onClick={() => { void logout(); }}>
        退出登录
      </button>
    </div>
  );
}

export function ConsoleSidebar() {
  const drawer = useRef<HTMLDialogElement>(null);
  const drawerId = useId();
  useEffect(() => {
    const viewport = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => { if (viewport.matches) drawer.current?.close(); };
    viewport.addEventListener("change", closeOnDesktop);
    return () => { viewport.removeEventListener("change", closeOnDesktop); };
  }, []);

  return (
    <>
      <aside className="console-sidebar">
        <ConsoleNavigation />
        <ConsoleUserFooter />
      </aside>
      <div className="console-mobile-nav">
        <button
          type="button"
          className="btn-control"
          aria-haspopup="dialog"
          aria-controls={drawerId}
          onClick={() => { drawer.current?.showModal(); }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 4h11m-11 4h11m-11 4h11" stroke="currentColor" strokeLinecap="round" />
          </svg>
          菜单
        </button>
      </div>
      <dialog
        id={drawerId}
        ref={drawer}
        className="console-nav-drawer"
        aria-label="菜单"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.currentTarget.close();
          }
        }}
      >
        <div className="console-drawer-header">
          <strong>菜单</strong>
          <button type="button" className="btn-control" onClick={() => { drawer.current?.close(); }}>关闭</button>
        </div>
        <ConsoleNavigation onNavigate={() => { drawer.current?.close(); }} />
        <ConsoleUserFooter />
      </dialog>
    </>
  );
}
