import React from "react";
import { createRoot } from "react-dom/client";
import CostSavings from "./CostSavings.tsx";

class CostSavingsWidgetElement extends HTMLElement {
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
    this.root.render(<CostSavings apiBase={apiBase} />);
  }
}

if (!customElements.get("cost-savings-widget")) {
  customElements.define("cost-savings-widget", CostSavingsWidgetElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "cost-savings-widget": CostSavingsWidgetElement;
  }
}
