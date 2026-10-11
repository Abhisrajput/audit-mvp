import type { Response } from 'express';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A tiny HTML page. Redirecting from our own page keeps the SameSite=Strict session cookie on the next request. */
export function page(res: Response, status: number, title: string, message: string, next?: string) {
  const go = next ? escapeHtml(next) : null;
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8">${go ? `<meta http-equiv="refresh" content="0;url=${go}">` : ''}` +
        `<title>${escapeHtml(title)}</title><p>${escapeHtml(message)}</p>${go ? `<p><a href="${go}">Continue</a></p>` : ''}`,
    );
}
