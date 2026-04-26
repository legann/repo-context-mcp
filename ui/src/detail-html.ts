import { shortLabel } from './graph-model.js';
import type { UiGraphData, UiNode } from './types/graph.js';
import type { UiSemanticRich } from './types/graph.js';

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStringOrRecord(title: string, v: string | Record<string, string> | undefined | null): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    return `<div class="detail-semantic-section"><h4>${escapeHtml(title)}</h4><p>${escapeHtml(v)}</p></div>`;
  }
  const rows = Object.entries(v)
    .map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(val))}</dd>`)
    .join('');
  return `<div class="detail-semantic-section"><h4>${escapeHtml(title)}</h4><dl class="detail-kv">${rows}</dl></div>`;
}

function renderBulletSection(title: string, items: string[] | undefined): string {
  if (!items?.length) return '';
  const lis = items.map(x => `<li>${escapeHtml(x)}</li>`).join('');
  return `<div class="detail-semantic-section"><h4>${escapeHtml(title)}</h4><ul class="detail-list">${lis}</ul></div>`;
}

function renderSemanticRichSections(sr: UiSemanticRich | undefined): string {
  if (!sr) return '';
  let h = '';
  if (sr.flowDescription) {
    h += `<div class="detail-semantic-section"><h4>Flow</h4><p>${escapeHtml(sr.flowDescription)}</p></div>`;
  }
  h += renderStringOrRecord('Data flow', sr.dataFlow);
  h += renderStringOrRecord('Integration', sr.integrationPoints);
  h += renderStringOrRecord('State / shape', sr.stateShape);
  h += renderBulletSection('Assumptions', sr.assumptions);
  h += renderBulletSection('Side effects', sr.sideEffects);
  h += renderBulletSection('Risks', sr.risks);
  h += renderBulletSection('Patterns', sr.patterns);
  h += renderBulletSection('Invariants', sr.invariants);
  h += renderBulletSection('Extension points', sr.extensionPoints);
  if (sr.keyExports && Object.keys(sr.keyExports).length) {
    const rows = Object.entries(sr.keyExports)
      .map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`)
      .join('');
    h += `<div class="detail-semantic-section"><h4>Key exports</h4><dl class="detail-kv">${rows}</dl></div>`;
  }
  if (sr.envDependencies && Object.keys(sr.envDependencies).length) {
    h += renderStringOrRecord('Env dependencies', sr.envDependencies);
  }
  return h;
}

export function buildDetailPanelHtml(n: UiNode, graphData: UiGraphData, nodeIndex: Map<string, UiNode>): string {
  let html = `<h3>${escapeHtml(n.label)}</h3>`;
  html += `<div class="detail-type">${escapeHtml(n.type)}${n.serviceKind ? ` · ${escapeHtml(n.serviceKind)}` : ''}</div>`;

  if (n.annotation) {
    html += `<div class="detail-annotation">${escapeHtml(n.annotation)}</div>`;
  }
  html += renderSemanticRichSections(n.semanticRich);

  if (n.description) html += `<div class="detail-desc">${escapeHtml(n.description)}</div>`;

  if (n.meta) {
    const skip = new Set(['triggers', 'resources', 'serviceKind']);
    const metaEntries = Object.entries(n.meta).filter(([k]) => !skip.has(k));
    if (metaEntries.length) {
      html += '<div class="detail-meta">';
      for (const [k, v] of metaEntries) html += `<span>${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
      html += '</div>';
    }
    const triggers = n.meta.triggers;
    if (Array.isArray(triggers) && triggers.length) {
      html += '<div class="detail-triggers">';
      for (const t of triggers) html += `<span class="trigger-item">${escapeHtml(String(t))}</span> `;
      html += '</div>';
    }
    const resources = n.meta.resources;
    if (Array.isArray(resources) && resources.length) {
      html += '<div class="conn-section"><h4>Resources</h4>';
      for (const r of resources) html += `<div class="detail-meta"><span>${escapeHtml(String(r))}</span></div>`;
      html += '</div>';
    }
  }

  const outgoing = graphData.edges.filter(e => e.source === n.id && e.kind !== 'contains').slice(0, 12);
  const incoming = graphData.edges.filter(e => e.target === n.id && e.kind !== 'contains').slice(0, 12);

  if (outgoing.length) {
    html += '<div class="conn-section"><h4>→ Out</h4>';
    for (const e of outgoing) {
      const tn = nodeIndex.get(e.target);
      html += `<div class="conn-item" data-nav="${escapeHtml(e.target)}"><span class="kind-tag">${escapeHtml(e.kind)}</span> ${tn ? escapeHtml(shortLabel(tn.label)) : escapeHtml(e.target)}</div>`;
    }
    html += '</div>';
  }
  if (incoming.length) {
    html += '<div class="conn-section"><h4>← In</h4>';
    for (const e of incoming) {
      const sn = nodeIndex.get(e.source);
      html += `<div class="conn-item" data-nav="${escapeHtml(e.source)}"><span class="kind-tag">${escapeHtml(e.kind)}</span> ${sn ? escapeHtml(shortLabel(sn.label)) : escapeHtml(e.source)}</div>`;
    }
    html += '</div>';
  }

  return html;
}

export function bindDetailNavClicks(panel: HTMLElement, navigateTo: (id: string) => void): void {
  panel.querySelectorAll('.conn-item[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.nav;
      if (id) navigateTo(id);
    });
  });
}
