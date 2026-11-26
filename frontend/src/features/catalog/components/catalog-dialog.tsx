import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Code2,
  Copy,
  Eye,
  EyeOff,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/auth-provider";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LobeIcon } from "@/components/lobe-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  CatalogError,
  catalogErrorMessage,
  createCatalogItem,
  deleteCatalogItem,
  getCatalogDetails,
  updateCatalogItem,
  validateScripts,
} from "../api";
import {
  catalogTitles,
  useCatalogRequest,
  type CatalogResource,
  type DetailItems,
  type ScriptItem,
  type ValidateScriptsResult,
} from "../types";

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
    <Textarea
      className="mono h-full min-h-[260px] w-full resize-none font-mono text-xs"
      aria-label={label}
      value={value}
      onChange={(e) => {
        onChange?.(e.target.value);
      }}
    />
  );
}

const CodeEditor = lazy(() =>
  import("./code-editor").catch(() => ({ default: PlainCode })),
);

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

function generateProjectKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `lg_${hex}`;
}

function defaultForm(
  resource: CatalogResource,
  defaultParentId?: string,
  rev?: number,
): FormState {
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
  const [attempt, setAttempt] = useState(0);
  const [initialForm, setInitialForm] = useState<FormState>(() =>
    defaultForm(resource, defaultParentId, currentRevision),
  );
  const [form, setForm] = useState<FormState>(() =>
    defaultForm(resource, defaultParentId, currentRevision),
  );
  const [rightView, setRightView] = useState<"list" | "editor">("list");
  const [activeScriptIdx, setActiveScriptIdx] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileTab, setMobileTab] = useState<"params" | "scripts">("params");
  const [showKey, setShowKey] = useState(false);
  const [validation, setValidation] = useState<ValidateScriptsResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

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
      const next = detailToForm(resource, result.data.item, result.data.revision);
      setInitialForm(next);
      setForm(next);
      setRightView("list");
      setActiveScriptIdx(0);
      setValidation(null);
    }
  }, [mode, resource, result?.data]);

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initialForm),
    [form, initialForm],
  );

  const activeScript = form.scripts[activeScriptIdx] ?? null;
  const loadingEdit = mode === "edit" && !result;

  function requestClose() {
    if (isDirty) {
      setDiscardConfirmOpen(true);
    } else {
      onClose();
    }
  }

  function addScript() {
    const idx = form.scripts.length + 1;
    const unit: ScriptItem = {
      id: `script-${idx}`,
      name: `Script ${idx}`,
      enabled: true,
      code: `export function onRequest(ctx: ScriptContext) {\n  return ctx;\n}\n`,
    };
    const nextIdx = form.scripts.length;
    setForm((prev) => ({ ...prev, scripts: [...prev.scripts, unit] }));
    setActiveScriptIdx(nextIdx);
    setRightView("editor");
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
    setActiveScriptIdx((prevIdx) => {
      const nextLen = form.scripts.length - 1;
      if (nextLen <= 0) {
        setRightView("list");
        return 0;
      }
      return Math.max(0, Math.min(prevIdx, nextLen - 1));
    });
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
    setValidating(true);
    try {
      const res = await validateScripts(form.scripts, csrfToken);
      setValidation(res);
      if (res.ok) {
        toast.success("脚本链编译校验通过");
      } else {
        toast.error(res.message || "脚本校验未通过");
      }
    } catch (err) {
      if (err instanceof CatalogError && err.status === 401) {
        handleUnauthorized();
        return;
      }
      setErrorMsg(catalogErrorMessage(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleSave() {
    if (!form.id.trim()) {
      setErrorMsg("ID 不能为空");
      return;
    }
    if (
      (resource === "provider-models" || resource === "project-models") &&
      !form.parentId.trim()
    ) {
      setErrorMsg(resource === "provider-models" ? "providerId 不能为空" : "projectId 不能为空");
      return;
    }
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
        toast.success(`已新建${catalogTitles[resource]}：${String(payload.name)}`);
      } else {
        await updateCatalogItem(resource, payload, csrfToken);
        toast.success(`已保存${catalogTitles[resource]}：${String(payload.name)}`);
      }
      onSaved();
      onClose();
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
      toast.success(`已删除 ${form.name || form.id}`);
      setDeleteConfirmOpen(false);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof CatalogError && err.status === 401) {
        handleUnauthorized();
        return;
      }
      setErrorMsg(catalogErrorMessage(err));
      setDeleteConfirmOpen(false);
    } finally {
      setSaving(false);
    }
  }

  const parameterFields = (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="cat-id">ID</Label>
        <Input
          id="cat-id"
          className="mono"
          value={form.id}
          readOnly={mode === "edit"}
          placeholder="例如 openai 或 gpt-4o"
          onChange={(e) => {
            setForm((p) => ({ ...p, id: e.target.value }));
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cat-name">显示名称</Label>
        <Input
          id="cat-name"
          value={form.name}
          placeholder="友好展示名称"
          onChange={(e) => {
            setForm((p) => ({ ...p, name: e.target.value }));
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cat-icon">图标 Slug</Label>
        <div className="flex items-center gap-2">
          {form.icon ? (
            <LobeIcon slug={form.icon} label={form.name || form.id} size={22} />
          ) : null}
          <Input
            id="cat-icon"
            className="mono"
            placeholder="自动推断或填写 slug"
            value={form.icon}
            onChange={(e) => {
              setForm((p) => ({ ...p, icon: e.target.value }));
            }}
          />
        </div>
      </div>

      {(resource === "provider-models" || resource === "project-models") && (
        <div className="space-y-1.5">
          <Label htmlFor="cat-parent">
            {resource === "provider-models" ? "所属提供商 ID (providerId)" : "所属项目 ID (projectId)"}
          </Label>
          <Input
            id="cat-parent"
            className="mono"
            value={form.parentId}
            readOnly={mode === "edit"}
            onChange={(e) => {
              setForm((p) => ({ ...p, parentId: e.target.value }));
            }}
          />
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border bg-background p-3">
        <div className="space-y-0.5">
          <Label htmlFor="cat-enabled" className="text-sm">
            启用状态
          </Label>
          <p className="text-xs text-muted-foreground">
            {form.enabled ? "当前处于激活参与调度状态" : "已停用，不参与路由调度"}
          </p>
        </div>
        <Switch
          id="cat-enabled"
          checked={form.enabled}
          onCheckedChange={(checked) => {
            setForm((p) => ({ ...p, enabled: checked }));
          }}
        />
      </div>

      {resource === "providers" && (
        <div className="space-y-2 rounded-lg border bg-background p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="cat-provider-key">上游 API Key</Label>
            <Badge variant={form.hasApiKey ? "secondary" : "outline"} className="text-[10px]">
              {form.hasApiKey ? "已加密保存" : "未配置"}
            </Badge>
          </div>
          <div className="relative">
            <Input
              id="cat-provider-key"
              className="mono pe-9"
              type={showKey ? "text" : "password"}
              placeholder={form.hasApiKey ? "输入新密钥以覆盖（留空不变）" : "输入上游 API Key…"}
              value={form.apiKey}
              onChange={(e) => {
                setForm((p) => ({ ...p, apiKey: e.target.value, clearApiKey: false }));
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute end-0.5 top-0.5 size-8"
              onClick={() => {
                setShowKey((v) => !v);
              }}
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </div>
          {mode === "edit" && form.hasApiKey ? (
            <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-muted-foreground">
              <Checkbox
                checked={form.clearApiKey}
                onCheckedChange={(checked) => {
                  const val = Boolean(checked);
                  setForm((p) => ({
                    ...p,
                    clearApiKey: val,
                    apiKey: val ? "" : p.apiKey,
                  }));
                }}
              />
              <span>清空已保存密钥</span>
            </label>
          ) : null}
        </div>
      )}

      {resource === "projects" && (
        <div className="space-y-2 rounded-lg border bg-background p-3">
          <Label htmlFor="cat-project-key">Bearer API Key（明文）</Label>
          <Input
            id="cat-project-key"
            className="mono text-xs"
            value={form.apiKey}
            onChange={(e) => {
              setForm((p) => ({ ...p, apiKey: e.target.value }));
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={() => {
                setForm((p) => ({ ...p, apiKey: generateProjectKey() }));
                toast.success("已生成新 Project Key");
              }}
            >
              <RefreshCw className="size-3" />
              随机生成
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={() => {
                void navigator.clipboard.writeText(form.apiKey);
                setCopied(true);
                toast.success("已复制 Project Key");
                setTimeout(() => {
                  setCopied(false);
                }, 1500);
              }}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const scriptWorkspace = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {rightView === "list" ? (
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">有序脚本链</h3>
              <Badge variant="secondary" className="mono">
                {form.scripts.length} 个脚本
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={addScript} className="gap-1.5">
                <Plus className="size-3.5" />
                添加脚本
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={validating}
                onClick={() => {
                  void handleValidate();
                }}
                className="gap-1.5"
              >
                <Play className="size-3.5" />
                {validating ? "校验中…" : "编译校验"}
              </Button>
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {form.scripts.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center">
                <Code2 className="size-8 text-muted-foreground/60" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">暂无脚本单元</p>
                  <p className="text-xs text-muted-foreground">
                    点击右上角「添加脚本」编写 onRequest / onBilling TypeScript 脚本
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addScript} className="gap-1.5">
                  <Plus className="size-3.5" />
                  添加第一个脚本
                </Button>
              </div>
            ) : (
              form.scripts.map((unit, idx) => (
                <div
                  key={`${unit.id}-${idx}`}
                  className={cn(
                    "group flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 transition-colors hover:border-primary/40",
                    !unit.enabled && "opacity-65",
                  )}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                    onClick={() => {
                      setActiveScriptIdx(idx);
                      setRightView("editor");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveScriptIdx(idx);
                        setRightView("editor");
                      }
                    }}
                  >
                    <Badge variant="outline" className="mono size-7 shrink-0 justify-center">
                      {idx + 1}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {unit.name || unit.id}
                        </span>
                        <span className="mono truncate text-xs text-muted-foreground">
                          {unit.id}
                        </span>
                      </div>
                      <p className="mono mt-0.5 truncate text-xs text-muted-foreground">
                        {unit.code.split("\n").find((l) => l.trim()) || "// empty script"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={unit.enabled}
                      aria-label={`启停脚本 ${unit.name || unit.id}`}
                      onCheckedChange={(checked) => {
                        updateScript(idx, { enabled: checked });
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={idx === 0}
                      aria-label="上移"
                      onClick={() => {
                        moveScript(idx, -1);
                      }}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={idx === form.scripts.length - 1}
                      aria-label="下移"
                      onClick={() => {
                        moveScript(idx, 1);
                      }}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        setActiveScriptIdx(idx);
                        setRightView("editor");
                      }}
                    >
                      <Code2 className="size-3.5" />
                      编辑代码
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive hover:text-destructive"
                      aria-label="删除脚本"
                      onClick={() => {
                        removeScript(idx);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}

            {validation ? (
              <Alert variant={validation.ok ? "default" : "destructive"}>
                <AlertTitle>{validation.ok ? "编译校验通过" : "编译校验失败"}</AlertTitle>
                <AlertDescription className="mono text-xs">
                  {validation.ok ? (
                    <div className="space-y-0.5">
                      <div>hooks: {validation.hooks?.join(", ") || "—"}</div>
                      <div>tags: {validation.tags?.join(", ") || "—"}</div>
                      <div>meta: {JSON.stringify(validation.meta ?? {})}</div>
                    </div>
                  ) : (
                    validation.message
                  )}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setRightView("list");
                }}
              >
                <ArrowLeft className="size-3.5" />
                脚本列表
              </Button>

              {form.scripts.length > 1 ? (
                <Select
                  value={String(activeScriptIdx)}
                  onValueChange={(v) => {
                    setActiveScriptIdx(Number(v));
                  }}
                >
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {form.scripts.map((unit, idx) => (
                      <SelectItem key={`${unit.id}-${idx}`} value={String(idx)}>
                        {idx + 1}. {unit.name || unit.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>

            {activeScript ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="mono h-8 w-32 text-xs"
                  aria-label="脚本 ID"
                  placeholder="script id"
                  value={activeScript.id}
                  onChange={(e) => {
                    updateScript(activeScriptIdx, { id: e.target.value });
                  }}
                />
                <Input
                  className="h-8 w-36 text-xs"
                  aria-label="脚本名称"
                  placeholder="脚本名称"
                  value={activeScript.name}
                  onChange={(e) => {
                    updateScript(activeScriptIdx, { name: e.target.value });
                  }}
                />
                <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <Switch
                    size="sm"
                    checked={activeScript.enabled}
                    onCheckedChange={(checked) => {
                      updateScript(activeScriptIdx, { enabled: checked });
                    }}
                  />
                  <span>启用</span>
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={validating}
                  onClick={() => {
                    void handleValidate();
                  }}
                >
                  <Play className="size-3" />
                  校验
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-1 flex-col gap-2 overflow-hidden p-3">
            {activeScript ? (
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
                  key={`script-editor-${activeScriptIdx}`}
                  label={activeScript.name || activeScript.id}
                  language="typescript"
                  value={activeScript.code}
                  onChange={(code) => {
                    updateScript(activeScriptIdx, { code });
                  }}
                />
              </Suspense>
            ) : null}

            {validation ? (
              <Alert
                variant={validation.ok ? "default" : "destructive"}
                className="shrink-0 py-2"
              >
                <AlertDescription className="mono text-xs">
                  {validation.ok
                    ? `编译通过 · hooks: ${validation.hooks?.join(", ") || "—"} · tags: ${validation.tags?.join(", ") || "—"}`
                    : `编译失败: ${validation.message ?? "未知错误"}`}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <Dialog
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            requestClose();
          }
        }}
      >
        <DialogContent
          className="flex h-[88vh] max-h-[860px] w-[94vw] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[92vw] lg:max-w-6xl"
          onEscapeKeyDown={(event) => {
            const active = document.activeElement;
            if (active?.closest(".monaco-editor")) {
              event.preventDefault();
            }
          }}
        >
          <DialogHeader className="flex-row items-center justify-between gap-4 border-b px-5 py-3.5 pe-12 text-start">
            <div className="flex min-w-0 items-center gap-3">
              <DialogTitle className="truncate text-base font-semibold">
                {mode === "create" ? "新建" : "编辑"}
                {catalogTitles[resource]}
                {form.name ? ` · ${form.name}` : ""}
              </DialogTitle>
              <Badge variant="outline" className="mono shrink-0 text-xs">
                r{form.expectedRevision ?? currentRevision}
              </Badge>
              {isDirty ? (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  未保存修改
                </Badge>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="hidden gap-1.5 lg:inline-flex"
                onClick={() => {
                  setSidebarCollapsed((v) => !v);
                }}
              >
                {sidebarCollapsed ? (
                  <>
                    <PanelLeftOpen className="size-3.5" />
                    展开参数
                  </>
                ) : (
                  <>
                    <PanelLeftClose className="size-3.5" />
                    收起参数
                  </>
                )}
              </Button>
            </div>
            <DialogDescription className="sr-only">
              编辑{catalogTitles[resource]}基础属性与有序 TypeScript 脚本链
            </DialogDescription>
          </DialogHeader>

          {loadingEdit ? (
            <div className="flex-1 space-y-4 p-6">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : mode === "edit" && result && !result.data ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertTitle>加载配置详情失败</AlertTitle>
                <AlertDescription className="flex items-center gap-3 pt-1">
                  <span>{catalogErrorMessage(result.error)}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAttempt((v) => v + 1);
                    }}
                  >
                    重试
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
              {/* Mobile Tab Switcher */}
              <div className="border-b px-4 py-2 lg:hidden">
                <Tabs
                  value={mobileTab}
                  onValueChange={(v) => {
                    setMobileTab(v as "params" | "scripts");
                  }}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="params" className="flex-1">
                      基础参数
                    </TabsTrigger>
                    <TabsTrigger value="scripts" className="flex-1">
                      脚本链 ({form.scripts.length})
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* Left Parameters Sidebar */}
              {!sidebarCollapsed ? (
                <aside
                  className={cn(
                    "w-full shrink-0 overflow-y-auto border-b bg-muted/20 p-5 lg:w-[330px] lg:border-e lg:border-b-0",
                    mobileTab !== "params" && "hidden lg:block",
                  )}
                >
                  {parameterFields}
                </aside>
              ) : null}

              {/* Right Script List <-> Immersive Editor */}
              <div
                className={cn(
                  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                  mobileTab !== "scripts" && "hidden lg:flex",
                )}
              >
                {scriptWorkspace}
              </div>
            </div>
          )}

          {errorMsg ? (
            <div className="border-t bg-destructive/5 px-5 py-2.5 text-xs text-destructive">
              {errorMsg}
            </div>
          ) : null}

          <DialogFooter className="flex-row items-center justify-between border-t px-5 py-3 sm:justify-between">
            <div>
              {mode === "edit" ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={saving || loadingEdit}
                  onClick={() => {
                    setDeleteConfirmOpen(true);
                  }}
                >
                  删除对象
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={requestClose}>
                取消
              </Button>
              <Button
                type="button"
                disabled={saving || loadingEdit}
                onClick={() => {
                  void handleSave();
                }}
              >
                {saving ? "保存中…" : "保存配置"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={`删除${catalogTitles[resource]}`}
        desc={`确认永久删除「${form.name || form.id}」吗？此操作无法撤销。`}
        confirmText="确认删除"
        destructive
        isLoading={saving}
        handleConfirm={() => {
          void handleDelete();
        }}
      />

      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title="放弃未保存的修改？"
        desc="当前配置或脚本有尚未保存的更改，关闭弹窗将丢失这些编辑内容。"
        confirmText="放弃修改"
        destructive
        handleConfirm={() => {
          setDiscardConfirmOpen(false);
          onClose();
        }}
      />
    </>
  );
}
