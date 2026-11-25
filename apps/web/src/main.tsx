import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/layout.css";
import { App } from "./app";
import { applyThemeToDocument, readStoredThemePreference } from "./state/theme";

applyThemeToDocument(readStoredThemePreference());
if (typeof navigator !== "undefined" && navigator.userAgent.includes("KilnDesktop/mac")) {
  document.documentElement.classList.add("is-mac-desktop");
}

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(<App />);
}
