import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';

cytoscape.use(dagre);

export interface CyCallbacks {
  onTapNode: (id: string) => void;
  onDblTapDomain: (id: string) => void;
  onTapBackground: () => void;
}

export function createCy(container: HTMLElement, callbacks: CyCallbacks): Core {
  const cy = cytoscape({
    container,
    elements: [],
    minZoom: 0.05,
    maxZoom: 3,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(shortLabel)',
          'text-valign': 'center',
          'text-halign': 'center',
          'background-color': 'data(bg)',
          'border-color': 'data(border)',
          'border-width': 2,
          color: 'data(textColor)',
          'font-size': '10px',
          'font-family': "'JetBrains Mono', monospace",
          'text-outline-color': 'data(bg)',
          'text-outline-width': 1.5,
          width: 'data(w)',
          height: 36,
          shape: 'roundrectangle',
          'text-max-width': 'data(w)',
          'text-wrap': 'ellipsis',
        },
      },
      {
        selector: 'node[type="domain"]',
        style: {
          shape: 'roundrectangle',
          'border-width': 3,
          'font-size': '11px',
          'font-weight': 600,
        },
      },
      {
        selector: 'node[serviceKind="lambda"]',
        style: { shape: 'diamond', height: 42 },
      },
      {
        selector: 'node[serviceKind="dynamodb"]',
        style: { shape: 'barrel', height: 38 },
      },
      {
        selector: 'node[serviceKind="sqs"]',
        style: { shape: 'tag', height: 34 },
      },
      {
        selector: 'node[serviceKind="s3"]',
        style: { shape: 'hexagon', height: 38 },
      },
      {
        selector: 'node[?ghost]',
        style: { opacity: 0.4, 'border-style': 'dashed' },
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 4,
          'border-color': '#fff',
          'overlay-color': '#58a6ff',
          'overlay-padding': 6,
          'overlay-opacity': 0.15,
        },
      },
      {
        selector: 'node.highlighted',
        style: { 'border-width': 3 },
      },
      {
        selector: 'node.dimmed',
        style: { opacity: 0.08 },
      },
      {
        selector: 'edge',
        style: {
          width: 'data(w)',
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.8,
          'curve-style': 'bezier',
          opacity: 0.35,
        },
      },
      {
        selector: 'edge.highlighted',
        style: { opacity: 0.9, width: 3, 'z-index': 999 },
      },
      {
        selector: 'edge.dimmed',
        style: { opacity: 0.03 },
      },
      {
        selector: 'edge[kind="tagged"]',
        style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 3] },
      },
      {
        selector: 'edge[kind="contains"]',
        style: { 'line-style': 'dotted', opacity: 0.15 },
      },
    ],
  });

  cy.on('tap', 'node', evt => {
    callbacks.onTapNode(evt.target.id());
  });
  cy.on('dbltap', 'node', evt => {
    const node = evt.target;
    if (node.data('type') === 'domain') callbacks.onDblTapDomain(node.id());
  });
  cy.on('tap', evt => {
    if (evt.target === cy) callbacks.onTapBackground();
  });

  setupHorizontalPanAndScroll(cy);
  return cy;
}

export function applyBaseEdgeOpacity(cy: Core, opacity: number): void {
  const o = Math.min(1, Math.max(0.05, opacity));
  cy.style().selector('edge').style('opacity', String(o)).update();
}

export function runLayout(cy: Core, rankDir: 'TB' | 'LR', elements: ElementDefinition[]): void {
  cy.elements().remove();
  cy.add(elements);
  cy.layout({
    name: 'dagre',
    rankDir,
    nodeSep: 40,
    rankSep: 70,
    edgeSep: 15,
    animate: false,
    fit: true,
    padding: 50,
  } as Parameters<Core['layout']>[0]).run();
  cy.fit(undefined, 50);
}

export function highlightNode(cy: Core, id: string): void {
  cy.elements().removeClass('highlighted dimmed');
  const node = cy.$(`#${CSS.escape(id)}`);
  if (!node.length) return;
  const neighborhood = node.neighborhood().add(node);
  cy.elements().not(neighborhood).addClass('dimmed');
  neighborhood.addClass('highlighted');
  node.select();
}

export function clearHighlight(cy: Core): void {
  cy.elements().removeClass('highlighted dimmed');
  cy.$(':selected').unselect();
}

function setupHorizontalPanAndScroll(cy: Core): void {
  function bindShiftWheelHorizontalScroll(el: Element | null): void {
    if (!el) return;
    el.addEventListener(
      'wheel',
      e => {
        const we = e as WheelEvent;
        if (!we.shiftKey) return;
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (maxScroll <= 0) return;
        we.preventDefault();
        el.scrollLeft += we.deltaY + we.deltaX;
      },
      { passive: false },
    );
  }

  bindShiftWheelHorizontalScroll(document.querySelector('.sidebar-scroll'));
  bindShiftWheelHorizontalScroll(document.getElementById('detail-scroll'));

  const canvasHost = document.getElementById('canvas-container');
  if (!canvasHost) return;

  canvasHost.addEventListener(
    'wheel',
    e => {
      const we = e as WheelEvent;
      const dominantH = Math.abs(we.deltaX) > Math.abs(we.deltaY);
      if (we.shiftKey || dominantH) {
        we.preventDefault();
        we.stopPropagation();
        const p = cy.pan();
        const dx = we.shiftKey ? we.deltaY + we.deltaX : we.deltaX;
        cy.pan({ x: p.x - dx, y: p.y });
      }
    },
    { passive: false, capture: true },
  );
}
