import type { UiNode } from './types/graph.js';

export const NODE_PALETTE = {
  domain: { bg: '#6d4c00', border: '#f0b429', text: '#ffd666' },
  package: { bg: '#0d4222', border: '#3fb950', text: '#7ee787' },
  module: { bg: '#0c2d6b', border: '#58a6ff', text: '#a5d6ff' },
  lambda: { bg: '#6b2e1a', border: '#f78166', text: '#ffb4a1' },
  dynamodb: { bg: '#0c3b5c', border: '#4493f8', text: '#79c0ff' },
  sqs: { bg: '#3b1f4e', border: '#bc8cff', text: '#d2a8ff' },
  s3: { bg: '#1a3a2a', border: '#56d364', text: '#7ee787' },
  k8s: { bg: '#1a3a5c', border: '#539bf5', text: '#79c0ff' },
  aws: { bg: '#3d2b00', border: '#d29922', text: '#e3b341' },
  other: { bg: '#21262d', border: '#484f58', text: '#8b949e' },
  ghost: { bg: '#161b22', border: '#30363d', text: '#636c76' },
} as const;

export type PaletteKey = keyof typeof NODE_PALETTE;

export const EDGE_COLORS: Record<string, string> = {
  imports: '#58a6ff',
  tagged: '#f0b429',
  infra: '#f78166',
  contains: '#30363d',
  handles: '#da3633',
  consumes: '#bc8cff',
  publishes: '#bc8cff',
  exposes: '#8b949e',
  implements: '#8b949e',
  binds_to: '#d29922',
  uses_env: '#636c76',
  uses_secret: '#da3633',
};

export const TIER_ORDER: Record<string, number> = {
  business: 0,
  feature: 1,
  layer: 2,
  technical: 3,
};

export const SERVICE_KIND_LABELS: Record<string, string> = {
  lambda: 'Lambda',
  dynamodb: 'DynamoDB',
  sqs: 'SQS',
  s3: 'S3',
  k8s: 'K8s',
  aws: 'AWS',
  api: 'API',
  other: 'Service',
};

export function colorsFor(node: UiNode): (typeof NODE_PALETTE)[PaletteKey] {
  const ghost = (node as { ghost?: boolean }).ghost;
  if (ghost) return NODE_PALETTE.ghost;
  if (node.type === 'service') {
    const k = node.serviceKind ?? 'other';
    return (NODE_PALETTE[k as PaletteKey] ?? NODE_PALETTE.other) as (typeof NODE_PALETTE)[PaletteKey];
  }
  return (NODE_PALETTE[node.type as PaletteKey] ?? NODE_PALETTE.other) as (typeof NODE_PALETTE)[PaletteKey];
}
