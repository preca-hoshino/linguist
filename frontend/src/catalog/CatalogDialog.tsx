import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { CatalogError, catalogErrorMessage, getCatalogDetails } from "./api";
import { catalogTitles } from "./navigation";
import type { CatalogResource, DetailItems, NamedItem } from "./types";
import { useCatalogRequest } from "./useCatalogRequest";

function PlainCode({ label, value }: { label: string; value: string }) {
  return <pre className="catalog-code-editor mono" aria-label={label} tabIndex={0}>{value}</pre>;
}

const CodeEditor = lazy(() => import("./CodeEditor").catch(() => ({ default: PlainCode })));

type Detail<K extends CatalogResource> = DetailItems[K] & { script: string | null };
interface CodeField {
  name: string;
  language: "typescript" | "json";
  value: string;
}

function Field({ name, value, type = "text" }: {
  name: string;
  value: string | number | null;
  type?: "text" | "number" | "url";
}) {
  return (
    <label className="catalog-field">
      <span>{name}</span>
      <input className="select-control" name={name} type={type} value={value ?? ""} readOnly />
    </label>
  );
}

function Flag({ name, value }: { name: string; value: boolean | null }) {
  return (
    <label className="catalog-field">
      <span>{name}</span>
      <select className="select-control" name={name} value={value === null ? "" : String(value)} disabled>
        <option value="">—</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    </label>
  );
}

function Lines({ name, values }: { name: string; values: readonly string[] | null }) {
  return (
    <label className="catalog-field">
      <span>{name}</span>
      <textarea className="select-control mono" name={name} rows={2} value={values?.join("\n") ?? ""} readOnly />
    </label>
  );
}

function ModelRefs({ name, items }: { name: string; items: NamedItem[] }) {
  return <Lines name={name} values={items.map((item) => `${item.id} · ${item.name}`)} />;
}

function Identity({ item }: { item: NamedItem & { icon?: string } }) {
  return (
    <>
      <Field name="id" value={item.id} />
      <Field name="name" value={item.name} />
      {item.icon !== undefined ? <Field name="icon" value={item.icon} /> : null}
    </>
  );
}

function jsonField(name: string, value: unknown): CodeField {
  return { name, language: "json", value: JSON.stringify(value, null, 2) };
}

function CodeFields({ source, extras = [] }: { source: string | null; extras?: readonly CodeField[] }) {
  const [selected, setSelected] = useState("script");
  const fields: CodeField[] = [{ name: "script", language: "typescript", value: source ?? "" }, ...extras];
  const field = fields.find(({ name }) => name === selected);
  if (!field) return null;
  return (
    <section className="catalog-code-fields" aria-label="代码字段">
      {fields.length > 1 ? (
        <div className="segmented-group" role="group" aria-label="选择字段">
          {fields.map(({ name }) => (
            <button
              key={name}
              type="button"
              className={`segmented-btn mono${selected === name ? " active" : ""}`}
              aria-pressed={selected === name}
              onClick={() => { setSelected(name); }}
            >{name}</button>
          ))}
        </div>
      ) : <span className="catalog-field-label mono">script</span>}
      <Suspense fallback={<PlainCode label={field.name} value={field.value} />}>
        <CodeEditor label={field.name} language={field.language} value={field.value} />
      </Suspense>
    </section>
  );
}

const fields: { [K in CatalogResource]: (item: Detail<K>) => ReactNode } = {
  providers: (item) => (
    <>
      <div className="catalog-fields">
        <Identity item={item} />
        <Field name="vendor" value={item.vendor} />
        <Field name="apiType" value={item.apiType} />
        <Field name="apiKey" value={item.hasApiKey ? "••••••••" : ""} />
        <ModelRefs name="models" items={item.models} />
      </div>
      <CodeFields source={item.script} />
    </>
  ),
  "provider-models": (item) => (
    <>
      <div className="catalog-fields">
        <Identity item={item} />
        <Field name="providerId" value={item.providerId} />
        <Field name="url" type="url" value={item.url} />
        <Lines name="supportsReasoningEffort" values={item.supportsReasoningEffort} />
        <Flag name="toolCalling" value={item.toolCalling} />
        <Flag name="vision" value={item.vision} />
        <Flag name="thinking" value={item.thinking} />
        <Flag name="streaming" value={item.streaming} />
        <Field name="maxInputTokens" value={item.maxInputTokens} type="number" />
        <Field name="maxOutputTokens" value={item.maxOutputTokens} type="number" />
      </div>
      <CodeFields source={item.script} />
    </>
  ),
  projects: (item) => (
    <>
      <div className="catalog-fields">
        <Identity item={item} />
        <Field name="apiKey" value={item.hasApiKey ? "••••••••" : ""} />
        <ModelRefs name="callModels" items={item.callModels} />
      </div>
      <CodeFields source={item.script} extras={[jsonField("meta", item.meta)]} />
    </>
  ),
  "project-models": (item) => (
    <>
      <div className="catalog-fields">
        <Identity item={item} />
        <Field name="projectId" value={item.projectId} />
      </div>
      <CodeFields source={item.script} extras={[jsonField("meta", item.meta)]} />
    </>
  ),
  routes: (item) => (
    <>
      <div className="catalog-fields">
        <Identity item={item} />
        <Field name="priority" type="number" value={item.priority} />
        <Flag name="enabled" value={item.enabled} />
        <Flag name="rewriteResponseModel" value={item.rewriteResponseModel} />
      </div>
      <div className="catalog-fields">
        <fieldset className="catalog-fieldset">
          <legend>match</legend>
          <Lines name="projectIds" values={item.match.projectIds} />
          <Lines name="callModelIds" values={item.match.callModelIds} />
        </fieldset>
        <fieldset className="catalog-fieldset">
          <legend>candidates</legend>
          <Lines name="allow" values={item.candidates.allow} />
          <Lines name="deny" values={item.candidates.deny} />
        </fieldset>
      </div>
      <CodeFields source={item.script} extras={[jsonField("target", item.target), jsonField("fallbacks", item.fallbacks)]} />
    </>
  ),
};

interface CatalogDialogProps<K extends CatalogResource> {
  resource: K;
  query: string;
  onClose: () => void;
}

export function CatalogDialog<K extends CatalogResource>({ resource, query, onClose }: CatalogDialogProps<K>) {
  const { handleUnauthorized } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const request = useCallback((signal: AbortSignal) => getCatalogDetails(resource, query, signal), [query, resource]);
  const result = useCatalogRequest(request, attempt);

  useEffect(() => {
    if (result?.error instanceof CatalogError && result.error.status === 401) {
      handleUnauthorized();
    }
  }, [result?.error, handleUnauthorized]);

  useEffect(() => {
    const instance = dialog.current;
    if (instance && !instance.open) instance.showModal();
  }, []);

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
          <h2 id={titleId}>编辑{catalogTitles[resource]}</h2>
          {result?.data ? <span className="catalog-dialog-name">{result.data.item.name}</span> : null}
        </div>
        <span className="catalog-readonly">只读</span>
      </header>
      <div className="catalog-dialog-body">
        {!result ? <p className="empty-state" role="status">加载中…</p> : null}
        {result?.data ? fields[resource](result.data.item) : null}
        {result && !result.data ? (
          <div className="error-banner catalog-error" role="alert">
            {catalogErrorMessage(result.error)}
            <button type="button" className="btn-control" onClick={() => { setAttempt((value) => value + 1); }}>重试</button>
          </div>
        ) : null}
      </div>
      <footer className="catalog-dialog-footer">
        <button type="button" className="btn-control" onClick={() => { dialog.current?.close(); }}>关闭</button>
        <button type="button" className="btn-control" disabled>保存</button>
      </footer>
    </dialog>
  );
}
