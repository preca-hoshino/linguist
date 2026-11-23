import { useEffect, useId, useRef } from "react";
import { NavLink } from "react-router";
import { catalogPath, catalogTitles } from "../catalog/navigation";
import type { CatalogResource } from "../catalog/types";

interface NavigationGroup {
  title?: string;
  resources: (CatalogResource | "telemetry")[];
}

const groups: NavigationGroup[] = [
  { resources: ["telemetry"] },
  { title: "供给侧", resources: ["providers", "provider-models"] },
  { title: "调用侧", resources: ["projects", "project-models"] },
  { resources: ["routes"] },
];

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
              to={resource === "telemetry" ? "/" : catalogPath(resource)}
              className={({ isActive }) => `console-nav-link${isActive ? " active" : ""}`}
              onClick={onNavigate}
            >
              {resource === "telemetry" ? "统计总览" : catalogTitles[resource]}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
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
      <aside className="console-sidebar"><ConsoleNavigation /></aside>
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
      </dialog>
    </>
  );
}
