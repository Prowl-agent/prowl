import React from "react";
import { createRoot } from "react-dom/client";
import DashboardShell from "./DashboardShell.tsx";

class DashboardShellWidgetElement extends HTMLElement {
  private root: {
    render: (node: unknown) => void;
    unmount: () => void;
  } | null = null;

  static get observedAttributes(): string[] {
    return ["api-base"];
  }

  connectedCallback() {
    if (!this.root) {
      this.root = createRoot(this);
    }
    this.renderReact();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  attributeChangedCallback() {
    this.renderReact();
  }

  private renderReact() {
    if (!this.root) {
      return;
    }
    const apiBase = this.getAttribute("api-base") ?? "";
    this.root.render(<DashboardShell apiBase={apiBase} />);
  }
}

if (!customElements.get("dashboard-shell-widget")) {
  customElements.define("dashboard-shell-widget", DashboardShellWidgetElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "dashboard-shell-widget": DashboardShellWidgetElement;
  }
}
