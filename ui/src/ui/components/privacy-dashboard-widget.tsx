import React from "react";
import { createRoot } from "react-dom/client";
import PrivacyDashboard from "./PrivacyDashboard.tsx";

class PrivacyDashboardWidgetElement extends HTMLElement {
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
    this.root.render(<PrivacyDashboard apiBase={apiBase} />);
  }
}

if (!customElements.get("privacy-dashboard-widget")) {
  customElements.define("privacy-dashboard-widget", PrivacyDashboardWidgetElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "privacy-dashboard-widget": PrivacyDashboardWidgetElement;
  }
}
