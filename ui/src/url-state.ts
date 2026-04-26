export type ViewerUrlState = {
  view: 'overview' | 'detail';
  domain: string | null;
  node: string | null;
};

export function readUrlState(): ViewerUrlState {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') === 'detail' ? 'detail' : 'overview';
  const domain = params.get('domain');
  const node = params.get('node');
  return {
    view,
    domain: domain && domain.length ? domain : null,
    node: node && node.length ? node : null,
  };
}

export function writeUrlState(state: ViewerUrlState): void {
  const params = new URLSearchParams();
  if (state.view === 'detail') params.set('view', 'detail');
  if (state.domain) params.set('domain', state.domain);
  if (state.node) params.set('node', state.node);
  const q = params.toString();
  const path = q ? `${window.location.pathname}?${q}` : window.location.pathname;
  window.history.replaceState(null, '', path);
}
