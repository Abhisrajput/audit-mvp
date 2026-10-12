import crypto from 'node:crypto';
import type { Response } from 'express';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Sign-in and signing pages: never cached, never framed (no clickjacking of the signing window), and only the
 * page's own inline script may run, through a nonce that is new for every response.
 */
export function popupHeaders(res: Response): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
  });
  return nonce;
}

/** A tiny HTML page. Redirecting from our own page keeps the SameSite=Strict session cookie on the next request. */
export function page(res: Response, status: number, title: string, message: string, next?: string) {
  const go = next ? escapeHtml(next) : null;
  popupHeaders(res);
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8">${go ? `<meta http-equiv="refresh" content="0;url=${go}">` : ''}` +
        `<title>${escapeHtml(title)}</title><p>${escapeHtml(message)}</p>${go ? `<p><a href="${go}">Continue</a></p>` : ''}`,
    );
}
