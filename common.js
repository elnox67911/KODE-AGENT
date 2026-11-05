import { firstLine } from '../utils.js';

export function ok(output, meta = {}) {
  return {
    output,
    isError: false,
    meta: {
      summary: meta.summary || firstLine(typeof output === 'string' ? output : 'done', 110),
      ...meta,
    },
  };
}

export function fail(message, meta = {}) {
  const text = String(message || 'Tool failed');
  return {
    output: text,
    isError: true,
    meta: {
      summary: meta.summary || firstLine(text, 110),
      preview: meta.preview ?? text,
      ...meta,
    },
  };
}
