import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { useStore } from "./store";
import { compositeStore } from "./canvas/CompositeStore";

// Surface store + composite canvas on window for live console probing.
// Diagnostic-only; safe to leave on for the lightweight footprint.
(window as unknown as { gengaze: unknown }).gengaze = {
  useStore,
  compositeStore,
  state: () => useStore.getState(),
  canvas: () => compositeStore.getCanvas(),
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
