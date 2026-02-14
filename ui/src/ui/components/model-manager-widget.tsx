import React from "react";
import { createRoot } from "react-dom/client";
import ModelManager from "./ModelManager.tsx";

class ModelManagerWidgetElement extends HTMLElement {
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
    this.root.render(<ModelManager apiBase={apiBase} />);
  }
}

if (!customElements.get("model-manager-widget")) {
  customElements.define("model-manager-widget", ModelManagerWidgetElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "model-manager-widget": ModelManagerWidgetElement;
  }
}
