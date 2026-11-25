import { useEffect, useRef } from "react";
import { editor } from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import {
  ModuleKind,
  ScriptTarget,
  typescriptDefaults,
} from "monaco-editor/languages/features/typescript/register.js";
import "monaco-editor/language/json/monaco.contribution.js";
import "monaco-editor/features/find/register.js";
import linguistDts from "../../../linguist.d.ts?raw";

self.MonacoEnvironment = {
  getWorker: (_id, label) => {
    if (label === "json") return new JsonWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

let dtsRegistered = false;
function ensureLinguistTypes() {
  if (dtsRegistered) return;
  dtsRegistered = true;
  typescriptDefaults.setCompilerOptions({
    target: ScriptTarget.ES2020,
    module: ModuleKind.ESNext,
    allowNonTsExtensions: true,
    strict: false,
  });
  typescriptDefaults.addExtraLib(linguistDts, "ts:linguist.d.ts");
}

interface CodeEditorProps {
  label: string;
  language: "typescript" | "json";
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

export default function CodeEditor({
  label,
  language,
  value,
  readOnly = false,
  onChange,
}: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValueRef = useRef(value);
  initialValueRef.current = value;

  useEffect(() => {
    if (!container.current) return;
    ensureLinguistTypes();
    const model = editor.createModel(initialValueRef.current, language);
    modelRef.current = model;
    const instance = editor.create(container.current, {
      model,
      ariaLabel: label,
      theme: "vs",
      readOnly,
      domReadOnly: readOnly,
      tabFocusMode: false,
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: true,
      lineNumbersMinChars: 3,
      renderLineHighlight: readOnly ? "none" : "line",
      renderValidationDecorations: readOnly ? "off" : "on",
      padding: { top: 8, bottom: 8 },
    });
    instanceRef.current = instance;
    const sub = model.onDidChangeContent(() => {
      if (onChangeRef.current) {
        onChangeRef.current(model.getValue());
      }
    });
    return () => {
      sub.dispose();
      instance.dispose();
      model.dispose();
      instanceRef.current = null;
      modelRef.current = null;
    };
  }, [label, language, readOnly]);

  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [value]);

  return <div ref={container} className="catalog-code-editor" />;
}
