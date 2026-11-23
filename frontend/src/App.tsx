import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { CatalogPage } from "./catalog/CatalogPage";
import { catalogPath, catalogTitles } from "./catalog/navigation";
import type { CatalogResource } from "./catalog/types";
import { ConsoleSidebar } from "./components/ConsoleSidebar";
import { TelemetryPage } from "./pages/TelemetryPage";
import "./styles/console.css";

const resources = Object.keys(catalogTitles) as CatalogResource[];

export function App() {
  const [token, setToken] = useState("");
  return (
    <BrowserRouter>
      <a href="#main-content" className="console-skip">跳到内容</a>
      <div className="console-shell">
        <ConsoleSidebar />
        <div className="console-content">
          <Routes>
            <Route path="/" element={<TelemetryPage />} />
            {resources.map((resource) => (
              <Route
                key={resource}
                path={catalogPath(resource)}
                element={<CatalogPage key={resource} resource={resource} token={token} onToken={setToken} />}
              />
            ))}
            <Route path="*" element={<Navigate replace to="/" />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}

export default App;
