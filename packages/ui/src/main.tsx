import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./board.css";

// A meta tag cannot set frame-ancestors, so refuse to render inside any frame (clickjacking guard).
if (window.top !== window.self) {
  document.body.textContent = "This page cannot be displayed in a frame.";
} else {
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
}
