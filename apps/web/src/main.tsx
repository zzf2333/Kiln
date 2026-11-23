import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/layout.css";
import { App } from "./app";
import { applyThemeToDocument, readStoredThemePreference } from "./state/theme";

applyThemeToDocument(readStoredThemePreference());

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(<App />);
}
