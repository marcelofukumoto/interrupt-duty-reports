// Interrupt duty reports: one page, one product, one button that asks the cluster's agent for
// today's report.
//
// The extension owns no agent of its own. Everything AI in it runs through codyrancher/agents,
// which puts one claude pod in the cluster and offers its conversations on `window.__agents` -
// so this bundle starts a conversation there and reads the result back out of the cluster. The
// page says so when that extension is missing, because without it there is nothing to press.
import { IPlugin } from '@shell/core/types';
import { NAV_ICON } from './icon.generated';

export default function(plugin: IPlugin): void {
  plugin.metadata = require('./package.json');

  plugin.addProduct({
    name:  'interrupt-duty-reports-console',
    label: 'Interrupt Duty',
    // A data URI rather than a required file. Rancher renders this through an <img> and a built
    // extension is served from a path chosen by whoever installed it, so an emitted asset's URL
    // is not something this build gets to know - and the icon would 404 in half the installs.
    sideBar: { icon: { svg: NAV_ICON as unknown as () => string } },
    // Lazily, so the page and the report renderer are a chunk of their own rather than part of
    // a bundle every page of the dashboard loads.
    component: () => import('./pages/ReportsPage.vue'),
  });
}
