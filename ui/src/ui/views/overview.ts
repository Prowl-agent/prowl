import { html } from "lit";

export type OverviewProps = Record<string, unknown>;

export function renderOverview(_props: OverviewProps) {
  return html`
    <dashboard-shell-widget></dashboard-shell-widget>
  `;
}
