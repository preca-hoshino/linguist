import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { LobeIcon } from "../components/LobeIcon";
import {
  CatalogError,
  catalogErrorMessage,
  createCatalogItem,
  deleteCatalogItem,
  getCatalogDetails,
  updateCatalogItem,
  validateScripts,
} from "./api";
import { catalogTitles } from "./navigation";
import type { CatalogResource, DetailItems, ScriptItem, ValidateScriptsResult } from "./types";
import { useCatalogRequest } from "./useCatalogRequest";

function PlainCode({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <textarea
      className="catalog-code-editor mono"
      aria-label={label}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

const CodeEditor = lazy(() => import("./CodeEditor").catch(() => ({ default: PlainCode })));

interface FormState {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  parentId: string;
  apiKey: string;
  clearApiKey: boolean;
  hasApiKey: boolean;
  scripts: ScriptItem[];
  expectedRevision?: number;
}

function defaultForm(resource: CatalogResource, defaultParentId?: string, rev?: number): FormState {
  return {
    id: "",
    name: "",
    icon: "",
    enabled: true,
    parentId: defaultParentId ?? "",
    apiKey: resource === "projects" ? generateProjectKey() : "",
    clearApiKey: false,
    hasApiKey: false,
    scripts: [],
    expectedRevision: rev,
  };
}

function detailToForm<K extends CatalogResource>(
  resource: K,
  item: DetailItems[K],
  revision: number,
): FormState {
  const parentId =
    resource === "provider-models" && "providerId" in item
      ? item.providerId
      : resource === "project-models" && "projectId" in item
        ? item.projectId
        : "";
  const apiKey = resource === "projects" && "apiKey" in item ? item.apiKey : "";
  const hasApiKey = resource === "providers" && "hasApiKey" in item ? item.hasApiKey : false;
  return {
    id: item.id,
    name: item.name,
    icon: item.icon,
    enabled: item.enabled,
    parentId,
    apiKey,
    clearApiKey: false,
    hasApiKey,
    scripts: item.scripts.map((s) => ({ ...s })),
    expectedRevision: revision,
  };
}

function generateProjectKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `lg_${hex}`;
}

interface CatalogDialogProps<K extends CatalogResource> {
  resource: K;
  mode: "create" | "edit";
  query: string;
  defaultParentId?: string;
  currentRevision: number;
  onSaved: () => void;
  onClose: () => void;
}

export function CatalogDialog<K extends CatalogResource>({
  resource,
  mode,
  query,
  defaultParentId,
  currentRevision,
  onSaved,
  onClose,
}: CatalogDialogProps<K>) {
  const { csrfToken, handleUnauthorized } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<FormState>(() =>
    defaultForm(resource, defaultParentId, currentRevision),
  );
  const [activeScriptIdx, setActiveScriptIdx] = useState(0);
  const [validation, setValidation] = useState<ValidateScriptsResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const request = useCallback(
    (signal: AbortSignal) => {
      if (mode === "create") {
        return Promise.resolve(null);
      }
      return getCatalogDetails(resource, query, signal);
    },
    [mode, query, resource],
  );
  const result = useCatalogRequest(request, attempt);

  useEffect(() => {
    if (result?.error instanceof CatalogError && result.error.status === 401) {
      handleUnauthorized();
    }
  }, [result?.error, handleUnauthorized]);

  useEffect(() => {
    if (mode === "edit" && result?.data) {
      setForm(detailToForm(resource, result.data.item, result.data.revision));
      setActiveScriptIdx(0);
      setValidation(null);
    }
  }, [mode, resource, result?.data]);

  useEffect(() => {
    const instance = dialog.current;
    if (instance && !instance.open) instance.showModal();
  }, []);

  const activeScript = form.scripts[activeScriptIdx] ?? null;

  function addScript() {
    const idx = form.scripts.length + 1;
    const unit: ScriptItem = {
      id: `script-${idx}`,
      name: `Script ${idx}`,
      enabled: true,
      code: `export function onRequest(ctx: ScriptContext) {\n  return ctx;\n}\n`,
    };
    setForm((prev) => ({ ...prev, scripts: [...prev.scripts, unit] }));
    setActiveScriptIdx(form.scripts.length);
  }

  function updateScript(idx: number, patch: Partial<ScriptItem>) {
    setForm((prev) => ({
      ...prev,
      scripts: prev.scripts.map((item, i) => (i === idx ? { ...item, ...patch } : item)),
    }));
  }

  function removeScript(idx: number) {
    setForm((prev) => ({
      ...prev,
      scripts: prev.scripts.filter((_, i) => i !== idx),
    }));
    setActiveScriptIdx((prevIdx) => Math.max(0, Math.min(prevIdx, form.scripts.length - 2)));
  }

  function moveScript(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= form.scripts.length) return;
    setForm((prev) => {
      const next = [...prev.scripts];
      const [moved] = next.splice(idx, 1);
      if (moved) next.splice(target, 0, moved);
      return { ...prev, scripts: next };
    });
    setActiveScriptIdx(target);
  }

  async function handleValidate() {
    setErrorMsg("");
    setValidation(null);
    try {
      const res = await validateScripts(form.scripts, csrfToken);
      setValidation(res);
    } catch (err) {
      if (err instanceof CatalogError && err.status === 401) {
        handleUnauthorized();
        return;
      }
      setErrorMsg(catalogErrorMessage(err));
    }
  }

  async function handleSave() {
    setSaving(true);
    setErrorMsg("");
    const payload: Record<string, unknown> = {
      id: form.id.trim(),
      name: form.name.trim() || form.id.trim(),
      icon: form.icon.trim(),
      enabled: form.enabled,
      scripts: form.scripts,
      expectedRevision: form.expectedRevision,
    };
    if (resource === "provider-models") {
      payload.providerId = form.parentId.trim();
    } else if (resource === "project-models") {
      payload.projectId = form.parentId.trim();
    } else if (resource === "providers") {
      if (form.apiKey.trim()) payload.apiKey = form.apiKey;
      if (form.clearApiKey) payload.clearApiKey = true;
    } else if (resource === "projects") {
      payload.apiKey = form.apiKey;
    }

    try {
      if (mode === "create") {
        await createCatalogItem(resource, payload, csrfToken);
      } else {
        await updateCatalogItem(resource, payload, csrfToken);
      }
      onSaved();
      dialog.current?.close();
    } catch (err) {
      if (err instanceof CatalogError && err.status === 401) {
        handleUnauthorized();
        return;
      }
      setErrorMsg(catalogErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`确认删除 ${form.name || form.id}？`)) return;
    setSaving(true);
    setErrorMsg("");
    const params = new URLSearchParams({ id: form.id });
    if (resource === "provider-models") params.set("provider_id", form.parentId);
    if (resource === "project-models") params.set("project_id", form.parentId);
    if (form.expectedRevision !== undefined) {
      params.set("expected_revision", String(form.expectedRevision));
    }
    try {
      await deleteCatalogItem(resource, params.toString(), csrfToken);
      onSaved();
      dialog.current?.close();
    } catch (err) {
      if (err instanceof CatalogError && err.status === 401) {
        handleUnauthorized();
        return;
      }
      setErrorMsg(catalogErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const loadingEdit = mode === "edit" && !result;

  return (
    <dialog
      ref={dialog}
      className="catalog-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.currentTarget.close();
        }
      }}
    >
      <header className="catalog-dialog-header">
        <div>
          <h2 id={titleId}>
            {mode === "create" ? "新建" : "编辑"}
            {catalogTitles[resource]}
          </h2>
          {form.name ? <span className="catalog-dialog-name">{form.name}</span> : null}
        </div>
        <span className="mono" style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          r{form.expectedRevision ?? currentRevision}
        </span>
      </header>

      <div className="catalog-dialog-body">
        {loadingEdit ? (
          <p className="empty-state" role="status">
            加载中…
          </p>
        ) : null}
        {mode === "edit" && result && !result.data ? (
          <div className="error-banner catalog-error" role="alert">
            {catalogErrorMessage(result.error)}
            <button
              type="button"
              className="btn-control"
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              重试
            </button>
          </div>
        ) : null}

        {(mode === "create" || result?.data) && (
          <>
            <div className="catalog-fields">
              <label className="catalog-field">
                <span>id</span>
                <input
                  className="select-control mono"
                  value={form.id}
                  readOnly={mode === "edit"}
                  onChange={(e) => {
                    setForm((p) => ({ ...p, id: e.target.value }));
                  }}
                />
              </label>

              <label className="catalog-field">
                <span>name</span>
                <input
                  className="select-control"
                  value={form.name}
                  onChange={(e) => {
                    setForm((p) => ({ ...p, name: e.target.value }));
                  }}
                />
              </label>

              <label className="catalog-field">
                <span>icon</span>
                <div className="entity-cell">
                  {form.icon ? <LobeIcon slug={form.icon} label={form.name || form.id} size={20} /> : null}
                  <input
                    className="select-control mono"
                    placeholder="自动推断或填写 slug"
                    value={form.icon}
                    onChange={(e) => {
                      setForm((p) => ({ ...p, icon: e.target.value }));
                    }}
                  />
                </div>
              </label>

              <label className="catalog-field">
                <span>enabled</span>
                <select
                  className="select-control"
                  value={String(form.enabled)}
                  onChange={(e) => {
                    setForm((p) => ({ ...p, enabled: e.target.value === "true" }));
                  }}
                >
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </select>
              </label>

              {(resource === "provider-models" || resource === "project-models") && (
                <label className="catalog-field">
                  <span>{resource === "provider-models" ? "providerId" : "projectId"}</span>
                  <input
                    className="select-control mono"
                    value={form.parentId}
                    readOnly={mode === "edit"}
                    onChange={(e) => {
                      setForm((p) => ({ ...p, parentId: e.target.value }));
                    }}
                  />
                </label>
              )}

              {resource === "providers" && (
                <div className="catalog-field">
                  <span>apiKey ({form.hasApiKey ? "已加密保存，留空保持不变" : "未配置"})</span>
                  <input
                    className="select-control mono"
                    type="password"
                    placeholder={form.hasApiKey ? "输入新密钥以覆盖…" : "输入上游 API Key…"}
                    value={form.apiKey}
                    onChange={(e) => {
                      setForm((p) => ({ ...p, apiKey: e.target.value, clearApiKey: false }));
                    }}
                  />
                  {mode === "edit" && form.hasApiKey ? (
                    <label className="filter-pills" style={{ marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={form.clearApiKey}
                        onChange={(e) => {
                          setForm((p) => ({
                            ...p,
                            clearApiKey: e.target.checked,
                            apiKey: e.target.checked ? "" : p.apiKey,
                          }));
                        }}
                      />
                      <span>清空已保存密钥</span>
                    </label>
                  ) : null}
                </div>
              )}

              {resource === "projects" && (
                <div className="catalog-field">
                  <span>apiKey（项目调用明文 Bearer Key）</span>
                  <div className="filter-pills">
                    <input
                      className="select-control mono"
                      value={form.apiKey}
                      onChange={(e) => {
                        setForm((p) => ({ ...p, apiKey: e.target.value }));
                      }}
                    />
                    <button
                      type="button"
                      className="btn-control"
                      onClick={() => {
                        setForm((p) => ({ ...p, apiKey: generateProjectKey() }));
                      }}
                    >
                      随机生成
                    </button>
                    <button
                      type="button"
                      className="btn-control"
                      onClick={() => {
                        void navigator.clipboard.writeText(form.apiKey);
                        setCopied(true);
                        setTimeout(() => {
                          setCopied(false);
                        }, 1500);
                      }}
                    >
                      {copied ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <section className="catalog-code-fields" aria-label="有序脚本链 scripts[]">
              <div className="section-header">
                <span className="catalog-field-label mono">
                  scripts[] ({form.scripts.length})
                </span>
                <div className="filter-pills">
                  <button type="button" className="btn-control" onClick={addScript}>
                    + 添加脚本
                  </button>
                  <button
                    type="button"
                    className="btn-control"
                    onClick={() => {
                      void handleValidate();
                    }}
                  >
                    编译校验
                  </button>
                </div>
              </div>

              {form.scripts.length > 0 ? (
                <>
                  <div className="segmented-group" role="group" aria-label="选择脚本单元">
                    {form.scripts.map((unit, idx) => (
                      <button
                        key={`${unit.id}-${idx}`}
                        type="button"
                        className={`segmented-btn mono${activeScriptIdx === idx ? " active" : ""}`}
                        onClick={() => {
                          setActiveScriptIdx(idx);
                        }}
                      >
                        {idx + 1}. {unit.name || unit.id}
                        {unit.enabled ? "" : " (停用)"}
                      </button>
                    ))}
                  </div>

                  {activeScript ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div className="catalog-controls">
                        <input
                          className="select-control mono"
                          aria-label="脚本 ID"
                          placeholder="script id"
                          value={activeScript.id}
                          onChange={(e) => {
                            updateScript(activeScriptIdx, { id: e.target.value });
                          }}
                        />
                        <input
                          className="select-control"
                          aria-label="脚本名称"
                          placeholder="脚本名称"
                          value={activeScript.name}
                          onChange={(e) => {
                            updateScript(activeScriptIdx, { name: e.target.value });
                          }}
                        />
                        <label className="filter-pills">
                          <input
                            type="checkbox"
                            checked={activeScript.enabled}
                            onChange={(e) => {
                              updateScript(activeScriptIdx, { enabled: e.target.checked });
                            }}
                          />
                          <span>启用</span>
                        </label>
                        <button
                          type="button"
                          className="btn-control"
                          disabled={activeScriptIdx === 0}
                          onClick={() => {
                            moveScript(activeScriptIdx, -1);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-control"
                          disabled={activeScriptIdx === form.scripts.length - 1}
                          onClick={() => {
                            moveScript(activeScriptIdx, 1);
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn-control"
                          onClick={() => {
                            removeScript(activeScriptIdx);
                          }}
                        >
                          删除脚本
                        </button>
                      </div>
                      <Suspense
                        fallback={
                          <PlainCode
                            label={activeScript.name}
                            value={activeScript.code}
                            onChange={(code) => {
                              updateScript(activeScriptIdx, { code });
                            }}
                          />
                        }
                      >
                        <CodeEditor
                          label={activeScript.name || activeScript.id}
                          language="typescript"
                          value={activeScript.code}
                          onChange={(code) => {
                            updateScript(activeScriptIdx, { code });
                          }}
                        />
                      </Suspense>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="empty-state">暂无脚本，点击“+ 添加脚本”创建</p>
              )}

              {validation ? (
                <div className={validation.ok ? "section-card" : "error-banner"} role="status">
                  {validation.ok ? (
                    <div className="mono" style={{ fontSize: 12 }}>
                      <div>编译通过 · hooks: {validation.hooks?.join(", ") || "—"}</div>
                      <div>tags: {validation.tags?.join(", ") || "—"}</div>
                      <div>meta: {JSON.stringify(validation.meta ?? {})}</div>
                    </div>
                  ) : (
                    <div>编译失败: {validation.message}</div>
                  )}
                </div>
              ) : null}
            </section>

            {errorMsg ? (
              <div className="error-banner" role="alert">
                {errorMsg}
              </div>
            ) : null}
          </>
        )}
      </div>

      <footer className="catalog-dialog-footer">
        {mode === "edit" ? (
          <button
            type="button"
            className="btn-control"
            disabled={saving}
            onClick={() => {
              void handleDelete();
            }}
          >
            删除
          </button>
        ) : null}
        <button
          type="button"
          className="btn-control"
          onClick={() => {
            dialog.current?.close();
          }}
        >
          关闭
        </button>
        <button
          type="button"
          className="btn-control"
          disabled={saving || loadingEdit}
          onClick={() => {
            void handleSave();
          }}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </footer>
    </dialog>
  );
}
