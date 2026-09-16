// Interrupt duty reports: one page, one product, one button that asks the cluster's agent for
// today's report.
//
// The extension owns no agent of its own. Everything AI in it runs through codyrancher/agents,
// which puts one claude pod in the cluster and offers its conversations on `window.__agents` -
// so this bundle starts a conversation there and reads the result back out of the cluster. The
// page says so when that extension is missing, because without it there is nothing to press.
import { IPlugin } from '@shell/core/types';

export default function(plugin: IPlugin): void {
  plugin.metadata = require('./package.json');

  plugin.addProduct({
    name:    'interrupt-duty-reports',
    label:   'Interrupt Duty',
    sideBar: { icon: { name: 'icon-notifier' } },
    // Lazily, so the page and the report renderer are a chunk of their own rather than part of
    // a bundle every page of the dashboard loads.
    component: () => import('./pages/ReportsPage.vue'),
  });
}
