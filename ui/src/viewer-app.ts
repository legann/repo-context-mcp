import { colorsFor, NODE_PALETTE, SERVICE_KIND_LABELS } from './colors.js';
import {
  applyBaseEdgeOpacity,
  clearHighlight,
  createCy,
  highlightNode,
  runLayout,
  type CyCallbacks,
} from './cytoscape-graph.js';
import { bindDetailNavClicks, buildDetailPanelHtml } from './detail-html.js';
import { buildExportPayload, copyTextToClipboard, exportGraphJson, exportGraphPng } from './export-debug.js';
import {
  buildNodeIndex,
  collectDomainSliceIds,
  collectVisibleEdgesForExport,
  collectVisibleNodesForExport,
  computeDomainOverview,
  computeDomainSlice,
  defaultAllowedEdgeKinds,
  getDomainScopeIds,
  groupModulesByPackage,
  overviewMatchingDomains,
  shortLabel,
  sortedDomainsForOverview,
  type CyElement,
} from './graph-model.js';
import type { UiDomainMeta, UiGraphData, UiNode } from './types/graph.js';
import { readUrlState, writeUrlState, type ViewerUrlState } from './url-state.js';
import type { Core } from 'cytoscape';

const STORAGE_EDGE_OPACITY = 'repo-context-ui-edge-opacity';

/** Overview: min cross-domain import edges between two domains to draw a link. */
const OVERVIEW_MIN_IMPORT_COUNT = 2;

export class RepoContextViewer {
  private graphData: UiGraphData | null = null;
  private nodeIndex = new Map<string, UiNode>();
  private cy: Core | null = null;

  private currentView: 'overview' | 'detail' = 'overview';
  private currentDomainId: string | null = null;
  private rankDir: 'TB' | 'LR' = 'LR';
  private sidebarSelectedNodeId: string | null = null;
  private sidebarFilterOn = new Map<string, boolean>();
  private overviewTierOn = new Map<string, boolean>();
  /** Detail: which edge kinds to draw; all on → pass null to computeDomainSlice */
  private edgeKindOn = new Map<string, boolean>();

  private edgeOpacity = 0.35;

  constructor() {
    const storedO = localStorage.getItem(STORAGE_EDGE_OPACITY);
    if (storedO) {
      const n = Number(storedO);
      if (!Number.isNaN(n)) this.edgeOpacity = Math.min(1, Math.max(0.05, n));
    }
  }

  init(): void {
    const cyHost = document.getElementById('cy');
    if (!cyHost) throw new Error('#cy missing');

    const callbacks: CyCallbacks = {
      onTapNode: id => {
        this.sidebarSelectedNodeId = id;
        if (this.cy) highlightNode(this.cy, id);
        this.showDetailPanel(id);
        this.renderSidebar();
        this.syncUrlFromState();
      },
      onDblTapDomain: id => {
        this.showDomainDetail(id);
      },
      onTapBackground: () => {
        this.sidebarSelectedNodeId = null;
        if (this.cy) clearHighlight(this.cy);
        this.hideDetailPanel();
        this.renderSidebar();
        this.syncUrlFromState();
      },
    };

    this.cy = createCy(cyHost, callbacks);
    applyBaseEdgeOpacity(this.cy, this.edgeOpacity);

    this.wireChrome();
    void this.loadData();
  }

  private wireChrome(): void {
    document.getElementById('search')?.addEventListener('input', () => {
      this.renderSidebar();
      if (this.currentView === 'overview' && this.graphData && this.cy) {
        this.renderGraph(this.computeOverviewElements());
      }
    });

    document.getElementById('btn-fit')?.addEventListener('click', () => {
      this.cy?.fit(undefined, 50);
    });

    document.querySelectorAll('.layout-btns button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.layout-btns button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.rankDir = (btn as HTMLButtonElement).dataset.dir as 'TB' | 'LR';
        if (this.currentView === 'overview') this.showOverview();
        else if (this.currentDomainId) this.showDomainDetail(this.currentDomainId);
      });
    });

    document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
      document.getElementById('app')?.classList.toggle('sidebar-open');
    });

    document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
      document.getElementById('app')?.classList.remove('sidebar-open');
    });

    const opacityRange = document.getElementById('edge-opacity') as HTMLInputElement | null;
    if (opacityRange) {
      opacityRange.value = String(this.edgeOpacity);
      opacityRange.addEventListener('input', () => {
        this.edgeOpacity = Number(opacityRange.value);
        localStorage.setItem(STORAGE_EDGE_OPACITY, String(this.edgeOpacity));
        if (this.cy) applyBaseEdgeOpacity(this.cy, this.edgeOpacity);
      });
    }

    document.getElementById('btn-export-png')?.addEventListener('click', () => {
      if (this.cy) exportGraphPng(this.cy);
    });

    document.getElementById('btn-export-json')?.addEventListener('click', () => {
      if (!this.graphData) return;
      const visibleDomains = overviewMatchingDomains(
        this.graphData,
        this.overviewTierOn,
        (document.getElementById('search') as HTMLInputElement)?.value ?? '',
      );
      const nodes = collectVisibleNodesForExport(
        this.graphData,
        this.nodeIndex,
        this.currentView,
        this.currentDomainId,
        visibleDomains,
      );
      const edges = collectVisibleEdgesForExport(
        this.graphData,
        this.nodeIndex,
        this.currentView,
        this.currentDomainId,
        visibleDomains,
        OVERVIEW_MIN_IMPORT_COUNT,
        this.getAllowedEdgeKindsForSlice(),
      );
      const payload = buildExportPayload({
        graphData: this.graphData,
        view: this.currentView,
        domainId: this.currentDomainId,
        nodes,
        edges,
        ui: {
          rankDir: this.rankDir,
          edgeOpacity: this.edgeOpacity,
          allowedEdgeKinds:
            this.getAllowedEdgeKindsForSlice() === null
              ? null
              : [...(this.getAllowedEdgeKindsForSlice() ?? [])],
        },
      });
      exportGraphJson(payload);
    });

    document.getElementById('btn-debug')?.addEventListener('click', () => {
      document.getElementById('debug-panel')?.classList.toggle('visible');
      this.refreshDebugPanel();
    });

    document.getElementById('btn-debug-close')?.addEventListener('click', () => {
      document.getElementById('debug-panel')?.classList.remove('visible');
    });

    document.getElementById('btn-close-detail')?.addEventListener('click', () => {
      this.hideDetailPanel();
      if (this.cy) clearHighlight(this.cy);
      this.sidebarSelectedNodeId = null;
      this.renderSidebar();
      this.syncUrlFromState();
    });

    document.getElementById('btn-copy-debug')?.addEventListener('click', async () => {
      const el = document.getElementById('debug-json');
      const text = el?.textContent ?? '';
      await copyTextToClipboard(text);
    });
  }

  private getAllowedEdgeKindsForSlice(): Set<string> | null {
    if (this.currentView !== 'detail' || !this.graphData) return null;
    const all = defaultAllowedEdgeKinds(this.graphData);
    const on = new Set<string>();
    for (const k of all) {
      if (this.edgeKindOn.get(k) !== false) on.add(k);
    }
    if (on.size === all.size) return null;
    return on;
  }

  private refreshDebugPanel(): void {
    const el = document.getElementById('debug-json');
    if (!el || !this.graphData) return;
    const summary = {
      builtAt: this.graphData.builtAt,
      stats: this.graphData.stats,
      view: this.currentView,
      domainId: this.currentDomainId,
      selectedNode: this.sidebarSelectedNodeId,
      rankDir: this.rankDir,
      edgeOpacity: this.edgeOpacity,
      meta: this.graphData.meta,
    };
    el.textContent = JSON.stringify(summary, null, 2);
  }

  private indexData(): void {
    this.nodeIndex = buildNodeIndex(this.graphData);
  }

  private computeOverviewElements(): CyElement[] {
    if (!this.graphData) return [];
    const q = (document.getElementById('search') as HTMLInputElement)?.value ?? '';
    const visible = overviewMatchingDomains(this.graphData, this.overviewTierOn, q);
    return computeDomainOverview(this.graphData, this.nodeIndex, visible, OVERVIEW_MIN_IMPORT_COUNT);
  }

  private computeDetailElements(): CyElement[] {
    if (!this.graphData || !this.currentDomainId) return [];
    return computeDomainSlice(this.graphData, this.nodeIndex, this.currentDomainId, this.getAllowedEdgeKindsForSlice());
  }

  private renderGraph(elements: CyElement[]): void {
    if (!this.cy) return;
    runLayout(this.cy, this.rankDir, elements as unknown as import('cytoscape').ElementDefinition[]);
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.graphData || !this.cy) return;
    const nc = this.cy.nodes().length;
    const ec = this.cy.edges().length;
    const built = new Date(this.graphData.builtAt).toLocaleTimeString();
    let slice = '';
    if (this.currentView === 'detail' && this.currentDomainId) {
      const { domainModIds } = collectDomainSliceIds(this.graphData, this.nodeIndex, this.currentDomainId);
      slice = ` · slice modules ${domainModIds.size}`;
    }
    const statInfo = document.getElementById('stat-info');
    if (statInfo) {
      statInfo.textContent = `${nc} nodes · ${ec} edges · built ${built} · total: ${this.graphData.stats.nodes}n/${this.graphData.stats.edges}e${slice}`;
    }
    this.refreshDebugPanel();
  }

  private syncUrlFromState(): void {
    const state: ViewerUrlState = {
      view: this.currentView,
      domain: this.currentView === 'overview' ? null : this.currentDomainId,
      node: this.currentView === 'overview' ? null : this.sidebarSelectedNodeId,
    };
    writeUrlState(state);
  }

  private applyUrlAfterLoad(): void {
    const url = readUrlState();
    if (url.view === 'detail' && url.domain && this.nodeIndex.has(url.domain)) {
      this.showDomainDetail(url.domain, true);
      if (url.node && this.nodeIndex.has(url.node)) {
        this.focusNode(url.node, true);
      }
    } else {
      this.showOverview(true);
    }
    this.syncUrlFromState();
  }

  showOverview(skipUrl = false): void {
    if (!this.graphData) return;
    this.currentView = 'overview';
    this.currentDomainId = null;
    this.sidebarSelectedNodeId = null;
    const badge = document.getElementById('view-badge');
    if (badge) badge.textContent = 'Domain Overview';
    const nav = document.getElementById('nav-bar');
    if (nav) nav.innerHTML = '<span class="nav-current">Domain Overview</span>';
    const filterSection = document.getElementById('filter-section');
    if (filterSection) filterSection.hidden = true;
    const overviewTier = document.getElementById('overview-tier-section');
    if (overviewTier) overviewTier.hidden = false;
    const fc = document.getElementById('filter-chips');
    if (fc) {
      fc.innerHTML = '';
      fc.classList.add('filter-chips--empty');
    }
    this.hideEdgeKindSection();
    this.renderLegend(['domain']);
    this.renderSidebar();
    this.renderGraph(this.computeOverviewElements());
    if (!skipUrl) this.syncUrlFromState();
  }

  showDomainDetail(domainId: string, skipUrl = false): void {
    if (!this.graphData) return;
    this.currentView = 'detail';
    this.currentDomainId = domainId;
    this.sidebarSelectedNodeId = null;
    if (this.cy) clearHighlight(this.cy);
    this.hideDetailPanel();
    const overviewTier = document.getElementById('overview-tier-section');
    if (overviewTier) overviewTier.hidden = true;
    const n = this.nodeIndex.get(domainId);
    const label = n?.label ?? domainId;
    const badge = document.getElementById('view-badge');
    if (badge) badge.textContent = `Domain: ${label}`;
    const nav = document.getElementById('nav-bar');
    if (nav) {
      nav.innerHTML = '';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'nav-crumb';
      back.textContent = 'Overview';
      back.addEventListener('click', () => this.showOverview());
      nav.appendChild(back);
      const sep = document.createElement('span');
      sep.className = 'nav-sep';
      sep.textContent = '›';
      nav.appendChild(sep);
      const cur = document.createElement('span');
      cur.className = 'nav-current';
      cur.textContent = label;
      nav.appendChild(cur);
    }
    this.renderLegend(['module', 'lambda', 'dynamodb', 'sqs', 'domain']);
    this.initDetailSidebarFilters(domainId);
    this.initEdgeKindFilters();
    this.renderFilterChips(domainId);
    this.renderEdgeKindSection();
    this.renderSidebar();
    this.renderGraph(this.computeDetailElements());
    if (!skipUrl) this.syncUrlFromState();
    document.getElementById('app')?.classList.remove('sidebar-open');
  }

  private initEdgeKindFilters(): void {
    this.edgeKindOn.clear();
    if (!this.graphData || !this.currentDomainId) return;
    const { allIds } = collectDomainSliceIds(this.graphData, this.nodeIndex, this.currentDomainId);
    const kinds = new Set<string>();
    for (const e of this.graphData.edges) {
      if (!allIds.has(e.source) || !allIds.has(e.target)) continue;
      if (e.kind === 'contains') continue;
      kinds.add(e.kind);
    }
    for (const k of kinds) this.edgeKindOn.set(k, true);
    for (const k of this.graphData.meta.edgeKinds ?? []) {
      if (!this.edgeKindOn.has(k)) this.edgeKindOn.set(k, true);
    }
  }

  private hideEdgeKindSection(): void {
    const s = document.getElementById('edge-kind-section');
    if (s) s.hidden = true;
    const wrap = document.getElementById('edge-kind-list');
    if (wrap) wrap.innerHTML = '';
  }

  private renderEdgeKindSection(): void {
    const section = document.getElementById('edge-kind-section');
    const wrap = document.getElementById('edge-kind-list');
    if (!section || !wrap) return;
    if (this.currentView !== 'detail' || !this.currentDomainId) {
      section.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    section.hidden = false;
    wrap.innerHTML = '';
    const kinds = [...this.edgeKindOn.keys()].sort((a, b) => a.localeCompare(b));
    for (const k of kinds) {
      const row = document.createElement('label');
      row.className = 'edge-kind-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.edgeKindOn.get(k) !== false;
      cb.addEventListener('change', () => {
        this.edgeKindOn.set(k, cb.checked);
        this.renderGraph(this.computeDetailElements());
        this.updateStatus();
      });
      row.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = k;
      row.appendChild(span);
      wrap.appendChild(row);
    }
  }

  private navigateTo(id: string): void {
    const n = this.nodeIndex.get(id);
    if (!n) return;
    if (n.type === 'domain') {
      this.showDomainDetail(id);
      return;
    }
    if (this.currentView === 'overview' && n.domains?.length) {
      this.showDomainDetail(n.domains[0]!);
      return;
    }
    this.focusNode(id);
  }

  focusNode(id: string, skipUrl = false): void {
    if (!this.cy || !this.graphData) return;
    const cyNode = this.cy.$(`#${CSS.escape(id)}`);
    if (!cyNode.length) return;
    this.sidebarSelectedNodeId = id;
    this.cy.animate({ center: { eles: cyNode }, zoom: 1.2, duration: 300 });
    highlightNode(this.cy, id);
    this.showDetailPanel(id);
    this.renderSidebar();
    if (!skipUrl) this.syncUrlFromState();
  }

  private showDetailPanel(id: string): void {
    const n = this.nodeIndex.get(id);
    if (!n || !this.graphData) return;
    document.getElementById('detail-panel')?.classList.add('visible');
    const panel = document.getElementById('detail-scroll');
    if (!panel) return;
    panel.innerHTML = buildDetailPanelHtml(n, this.graphData, this.nodeIndex);
    bindDetailNavClicks(panel, idNav => this.navigateTo(idNav));
  }

  private hideDetailPanel(): void {
    document.getElementById('detail-panel')?.classList.remove('visible');
    const panel = document.getElementById('detail-scroll');
    if (panel) panel.innerHTML = '';
  }

  private initDetailSidebarFilters(domainId: string): void {
    if (!this.graphData) return;
    const { allIds } = collectDomainSliceIds(this.graphData, this.nodeIndex, domainId);
    this.sidebarFilterOn.clear();
    this.sidebarFilterOn.set('module', true);
    for (const id of allIds) {
      const n = this.nodeIndex.get(id);
      if (n?.type === 'service') {
        const k = n.serviceKind || 'other';
        if (!this.sidebarFilterOn.has(k)) this.sidebarFilterOn.set(k, true);
      }
    }
  }

  private renderFilterChips(domainId: string): void {
    const section = document.getElementById('filter-section');
    const wrap = document.getElementById('filter-chips');
    if (!section || !wrap || !this.graphData) return;
    if (this.currentView !== 'detail' || !domainId) {
      section.hidden = true;
      wrap.innerHTML = '';
      wrap.classList.add('filter-chips--empty');
      return;
    }
    section.hidden = false;
    const { allIds } = collectDomainSliceIds(this.graphData, this.nodeIndex, domainId);
    const kinds = new Set<string>(['module']);
    for (const id of allIds) {
      const n = this.nodeIndex.get(id);
      if (n?.type === 'service') kinds.add(n.serviceKind || 'other');
    }
    const order = ['lambda', 'sqs', 'dynamodb', 's3', 'api', 'aws', 'k8s', 'other', 'module'];
    const ordered = [...kinds].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    wrap.innerHTML = '';
    for (const k of ordered) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip' + (this.sidebarFilterOn.get(k) !== false ? ' on' : ' off');
      chip.textContent = k === 'module' ? 'Modules' : (SERVICE_KIND_LABELS[k] ?? k);
      chip.addEventListener('click', () => {
        const cur = this.sidebarFilterOn.get(k) !== false;
        this.sidebarFilterOn.set(k, !cur);
        this.renderFilterChips(domainId);
        this.renderSidebar();
      });
      wrap.appendChild(chip);
    }
    wrap.classList.toggle('filter-chips--empty', ordered.length === 0);
  }

  private renderOverviewTierChips(): void {
    const section = document.getElementById('overview-tier-section');
    const wrap = document.getElementById('overview-tier-chips');
    if (!section || !wrap || !this.graphData) return;
    if (this.currentView !== 'overview') {
      section.hidden = true;
      return;
    }
    for (const d of this.graphData.meta.domains) {
      const t = d.tier || 'technical';
      if (!this.overviewTierOn.has(t)) this.overviewTierOn.set(t, true);
    }
    section.hidden = false;
    const tiersInData = new Set(this.graphData.meta.domains.map(d => d.tier || 'technical'));
    const tierOrderList = ['business', 'feature', 'layer', 'technical'];
    const ordered = [
      ...tierOrderList.filter(t => tiersInData.has(t)),
      ...[...tiersInData].filter(t => !tierOrderList.includes(t)).sort(),
    ];
    const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    wrap.innerHTML = '';
    for (const tier of ordered) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip' + (this.overviewTierOn.get(tier) !== false ? ' on' : ' off');
      chip.textContent = label(tier);
      chip.addEventListener('click', () => {
        const cur = this.overviewTierOn.get(tier) !== false;
        this.overviewTierOn.set(tier, !cur);
        this.renderOverviewTierChips();
        this.renderSidebar();
        this.renderGraph(this.computeOverviewElements());
      });
      wrap.appendChild(chip);
    }
  }

  private renderLegend(types: string[]): void {
    const legend = document.getElementById('legend');
    if (!legend) return;
    legend.innerHTML = '';
    const labels: Record<string, string> = {
      domain: 'Domain',
      module: 'Module',
      lambda: 'Lambda',
      dynamodb: 'DynamoDB',
      sqs: 'SQS',
      s3: 'S3',
      package: 'Package',
      k8s: 'K8s',
      aws: 'AWS',
    };
    const C = NODE_PALETTE;
    for (const t of types) {
      const c = (C as Record<string, { border: string }>)[t] ?? C.other;
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `<div class="legend-dot" style="background:${c.border}"></div>${labels[t] ?? t}`;
      legend.appendChild(item);
    }
    const ghostItem = document.createElement('div');
    ghostItem.className = 'legend-item';
    ghostItem.innerHTML = `<div class="legend-dot" style="background:${C.ghost.border};border:1px dashed ${C.ghost.text}"></div>External`;
    legend.appendChild(ghostItem);
    const lt = document.getElementById('legend-title');
    if (lt) lt.hidden = false;
  }

  private renderSidebar(): void {
    const list = document.getElementById('sidebar-list');
    if (!list || !this.graphData) return;
    list.innerHTML = '';

    if (this.currentView === 'overview') {
      this.renderOverviewTierChips();
      const q = (document.getElementById('search') as HTMLInputElement)?.value ?? '';
      const domains = sortedDomainsForOverview(this.graphData, this.overviewTierOn, q);

      let lastTier: string | null = null;
      for (const d of domains) {
        const tier = d.tier || 'technical';
        if (tier !== lastTier) {
          lastTier = tier;
          const lbl = document.createElement('div');
          lbl.className = 'section-label';
          lbl.textContent = tier;
          list.appendChild(lbl);
        }
        list.appendChild(this.createDomainItem(d));
      }
    } else if (this.currentDomainId) {
      const q = (document.getElementById('search') as HTMLInputElement)?.value ?? '';
      const ctx = collectDomainSliceIds(this.graphData, this.nodeIndex, this.currentDomainId);
      const dEntry = this.graphData.meta.domains.find(d => d.id === this.currentDomainId);
      const subs = dEntry?.subdomains ?? [];

      const servicesByKind = new Map<string, UiNode[]>();
      for (const id of ctx.allIds) {
        const n = this.nodeIndex.get(id);
        if (!n || n.type !== 'service') continue;
        const k = n.serviceKind || 'other';
        if (!servicesByKind.has(k)) servicesByKind.set(k, []);
        servicesByKind.get(k)!.push(n);
      }
      for (const arr of servicesByKind.values()) arr.sort((a, b) => a.label.localeCompare(b.label));

      const kindOrder = ['lambda', 'sqs', 'dynamodb', 's3', 'api', 'aws', 'k8s'];
      const seen = new Set(kindOrder);
      const otherKinds = [...servicesByKind.keys()].filter(k => !seen.has(k)).sort();

      for (const k of [...kindOrder, ...otherKinds]) {
        if (!servicesByKind.has(k)) continue;
        if (this.sidebarFilterOn.get(k) === false) continue;
        const nodes = servicesByKind.get(k)!.filter(n => this.nodeMatchesSearch(n, q));
        if (!nodes.length) continue;
        const title = `${SERVICE_KIND_LABELS[k] ?? k} (${nodes.length})`;
        this.addSection(list, title);
        for (const n of nodes) list.appendChild(this.createServiceItem(n));
      }

      if (this.sidebarFilterOn.get('module') !== false) {
        const seenModIds = new Set<string>();
        const modules: UiNode[] = [];
        for (const id of ctx.domainModIds) {
          const n = this.nodeIndex.get(id);
          if (n?.type === 'module' && !seenModIds.has(id)) {
            seenModIds.add(id);
            modules.push(n);
          }
        }
        for (const e of this.graphData.edges) {
          if (e.kind !== 'infra') continue;
          if (!ctx.lambdaIds.has(e.source)) continue;
          const mod = this.nodeIndex.get(e.target);
          if (mod?.type === 'module' && !seenModIds.has(mod.id)) {
            seenModIds.add(mod.id);
            modules.push(mod);
          }
        }
        for (const id of ctx.allIds) {
          const n = this.nodeIndex.get(id);
          if (n?.type === 'module' && !seenModIds.has(id)) {
            seenModIds.add(id);
            modules.push(n);
          }
        }
        let modList = modules.filter(n => this.nodeMatchesSearch(n, q));
        modList.sort((a, b) => a.label.localeCompare(b.label));
        if (modList.length === 0) {
          const scope = getDomainScopeIds(this.graphData, this.currentDomainId);
          modList = this.graphData.nodes
            .filter(n => n.type === 'module' && n.domains?.some(d => scope.has(d)))
            .filter(n => this.nodeMatchesSearch(n, q));
          modList.sort((a, b) => a.label.localeCompare(b.label));
        }

        const usedInSub = new Set<string>();
        for (const sub of subs) {
          const inSub = modList.filter(m => m.domains?.includes(sub.id));
          for (const m of inSub) usedInSub.add(m.id);
          if (!inSub.length) continue;
          this.addSection(list, `${sub.label} (${inSub.length})`);
          const byPkg = groupModulesByPackage(inSub, this.nodeIndex);
          for (const [pkgLabel, mods] of byPkg.entries()) {
            const sublbl = document.createElement('div');
            sublbl.className = 'section-label';
            sublbl.style.paddingLeft = '18px';
            sublbl.style.fontSize = '9px';
            sublbl.style.opacity = '0.85';
            sublbl.textContent = pkgLabel === '—' ? 'Package — (no pkg node in graph)' : pkgLabel;
            list.appendChild(sublbl);
            for (const m of mods) list.appendChild(this.createModuleItem(m));
          }
        }

        const rest = modList.filter(m => !usedInSub.has(m.id));
        if (rest.length) {
          this.addSection(list, `Modules (${rest.length})`);
          const byPkg = groupModulesByPackage(rest, this.nodeIndex);
          for (const [pkgLabel, mods] of byPkg.entries()) {
            const sublbl = document.createElement('div');
            sublbl.className = 'section-label';
            sublbl.style.fontSize = '10px';
            sublbl.textContent = pkgLabel === '—' ? 'Package — (no pkg node in graph)' : pkgLabel;
            list.appendChild(sublbl);
            for (const m of mods) list.appendChild(this.createModuleItem(m));
          }
        }
      }
    }

    if (this.sidebarSelectedNodeId) {
      requestAnimationFrame(() => {
        const el = document.querySelector('#sidebar-list .list-item.active');
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  private nodeMatchesSearch(n: UiNode, q: string): boolean {
    if (!q) return true;
    const parts: string[] = [n.label, n.id, n.description || '', n.annotation || ''];
    if (n.semanticRich) {
      try {
        parts.push(JSON.stringify(n.semanticRich));
      } catch {
        /* ignore */
      }
    }
    const hay = parts.join('\n').toLowerCase();
    return hay.includes(q);
  }

  private addSection(list: HTMLElement, text: string): void {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = text;
    list.appendChild(lbl);
  }

  private createDomainItem(d: UiDomainMeta): HTMLElement {
    const item = document.createElement('div');
    item.className = 'list-item' + (d.id === this.sidebarSelectedNodeId ? ' active' : '');
    const c = NODE_PALETTE.domain;
    item.innerHTML =
      `<div class="dot" style="background:${c.border}"></div>` +
      `<span class="name">${d.label}</span>` +
      `<span class="badge">${d.moduleCount}</span>`;
    item.addEventListener('click', () => {
      this.showDomainDetail(d.id);
      document.getElementById('app')?.classList.remove('sidebar-open');
    });
    item.addEventListener('mouseenter', () => this.cy?.$(`#${CSS.escape(d.id)}`).addClass('highlighted'));
    item.addEventListener('mouseleave', () => this.cy?.$(`#${CSS.escape(d.id)}`).removeClass('highlighted'));
    return item;
  }

  private createServiceItem(n: UiNode): HTMLElement {
    const c = colorsFor(n);
    const item = document.createElement('div');
    item.className = 'list-item' + (n.id === this.sidebarSelectedNodeId ? ' active' : '');
    item.innerHTML =
      `<div class="dot diamond" style="background:${c.border}"></div>` +
      `<span class="name" title="${n.label}">${n.label}</span>`;
    item.addEventListener('click', () => {
      this.focusNode(n.id);
      document.getElementById('app')?.classList.remove('sidebar-open');
    });
    item.addEventListener('mouseenter', () => this.cy?.$(`#${CSS.escape(n.id)}`).addClass('highlighted'));
    item.addEventListener('mouseleave', () => this.cy?.$(`#${CSS.escape(n.id)}`).removeClass('highlighted'));
    return item;
  }

  private createModuleItem(n: UiNode): HTMLElement {
    const item = document.createElement('div');
    item.className = 'list-item' + (n.id === this.sidebarSelectedNodeId ? ' active' : '');
    const exportCount = n.meta?.exports;
    item.innerHTML =
      `<div class="dot" style="background:${NODE_PALETTE.module.border}"></div>` +
      `<span class="name" title="${n.label}">${shortLabel(n.label)}</span>` +
      (exportCount != null ? `<span class="badge">${String(exportCount)}e</span>` : '');
    item.addEventListener('click', () => {
      this.focusNode(n.id);
      document.getElementById('app')?.classList.remove('sidebar-open');
    });
    item.addEventListener('mouseenter', () => this.cy?.$(`#${CSS.escape(n.id)}`).addClass('highlighted'));
    item.addEventListener('mouseleave', () => this.cy?.$(`#${CSS.escape(n.id)}`).removeClass('highlighted'));
    return item;
  }

  private async loadData(): Promise<void> {
    try {
      const resp = await fetch('/api/graph');
      this.graphData = (await resp.json()) as UiGraphData;
      this.indexData();
      this.applyUrlAfterLoad();
    } catch (e) {
      console.error('Load failed:', e);
      const statInfo = document.getElementById('stat-info');
      if (statInfo) statInfo.textContent = 'Failed to load graph data';
    }
  }

  connectSSE(): void {
    const es = new EventSource('/api/events');
    const dot = document.getElementById('status-dot');
    es.addEventListener('connected', () => {
      dot?.classList.add('connected');
      if (dot) dot.title = 'Live';
    });
    es.addEventListener('refresh', e => {
      try {
        this.graphData = JSON.parse((e as MessageEvent).data) as UiGraphData;
        this.indexData();
        if (this.currentView === 'overview') this.showOverview();
        else if (this.currentDomainId) this.showDomainDetail(this.currentDomainId);
      } catch (err) {
        console.error('SSE refresh parse error:', err);
      }
      const el = document.getElementById('stat-refresh');
      if (el) {
        el.textContent = '↻ ' + new Date().toLocaleTimeString();
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
    });
    es.onerror = () => {
      dot?.classList.remove('connected');
      if (dot) dot.title = 'Disconnected';
    };
  }
}
