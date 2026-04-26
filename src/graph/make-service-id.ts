import type { InfraResource } from '../types.js';

/** Stable service node id for an infra resource (must match graph construction). */
export function makeServiceId(res: InfraResource): string {
  const base = res.id;
  if (res.provider === 'aws') {
    if (res.kind === 'lambda') return `service:aws-lambda:${base}`;
    if (res.kind === 'queue') return `service:aws-sqs:${base}`;
    if (res.kind === 'topic') return `service:aws-sns:${base}`;
    if (res.kind === 'table') return `service:aws-dynamodb:${base}`;
    if (res.kind === 'api') return `service:aws-api:${base}`;
    if (res.kind === 'bucket') return `service:aws-s3:${base}`;
  }
  if (res.provider === 'k8s') {
    if (res.kind === 'k8s-deployment') return `service:k8s-deployment:${base}`;
    if (res.kind === 'k8s-service') return `service:k8s-service:${base}`;
  }
  return `service:${res.provider}:${base}`;
}
