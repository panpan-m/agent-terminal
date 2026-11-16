import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import { ThemeProvider } from "./lib/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
