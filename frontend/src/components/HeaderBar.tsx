import type { FilterEntityItem } from "../types/telemetry";

interface HeaderBarProps {
  title: string;
  projects: FilterEntityItem[];
  providers: FilterEntityItem[];
  selectedProject: string;
  selectedProvider: string;
  autoRefresh: boolean;
  isRefreshing: boolean;
  lastUpdated: string | null;
  onProjectChange: (projectId: string) => void;
  onProviderChange: (providerId: string) => void;
  onToggleAutoRefresh: () => void;
  onManualRefresh: () => void;
}

export function HeaderBar({
  title,
  projects,
  providers,
  selectedProject,
  selectedProvider,
  autoRefresh,
  isRefreshing,
  lastUpdated,
  onProjectChange,
  onProviderChange,
  onToggleAutoRefresh,
  onManualRefresh,
}: HeaderBarProps) {
  return (
    <header className="header-bar">
      <div className="header-inner">
        <div className="brand-group">
          <div className="brand-mark">LG</div>
          <div>
            <h1 className="brand-title">{title}</h1>
            <p className="brand-subtitle">
              Programmable OpenAI Chat Gateway &amp; Read-Only Token Telemetry
              {lastUpdated ? ` · 更新于 ${lastUpdated}` : ""}
            </p>
          </div>
        </div>

        <div className="header-controls">
          <select
            aria-label="Filter by project"
            className="select-control"
            value={selectedProject}
            onChange={(e) => {
              onProjectChange(e.target.value);
            }}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                项目: {p.name} ({p.id})
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by provider"
            className="select-control"
            value={selectedProvider}
            onChange={(e) => {
              onProviderChange(e.target.value);
            }}
          >
            <option value="">全部提供商</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                提供商: {p.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`btn-control ${autoRefresh ? "active" : ""}`}
            onClick={onToggleAutoRefresh}
          >
            <span className={`live-dot ${autoRefresh ? "" : "paused"}`} />
            {autoRefresh ? "自动轮询 5s" : "已暂停轮询"}
          </button>

          <button
            type="button"
            className="btn-control"
            onClick={onManualRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? "刷新中..." : "立即刷新"}
          </button>
        </div>
      </div>
    </header>
  );
}
