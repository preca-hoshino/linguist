import { useEffect, useRef } from "react";
import { editor } from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/language/json/monaco.contribution.js";
import "monaco-editor/features/find/register.js";

self.MonacoEnvironment = {
  getWorker: (_id, label) => label === "json" ? new JsonWorker() : new EditorWorker(),
};

interface CodeEditorProps {
  label: string;
  language: "typescript" | "json";
  value: string;
}

export default function CodeEditor({ label, language, value }: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const model = editor.createModel(value, language);
    const instance = editor.create(container.current, {
      model,
      ariaLabel: label,
      theme: "vs",
      readOnly: true,
      domReadOnly: true,
      tabFocusMode: true,
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: false,
      lineNumbersMinChars: 3,
      renderLineHighlight: "none",
      renderValidationDecorations: "off",
      padding: { top: 8, bottom: 8 },
    });
    return () => {
      instance.dispose();
      model.dispose();
    };
  }, [label, language, value]);
  return <div ref={container} className="catalog-code-editor" />;
}
