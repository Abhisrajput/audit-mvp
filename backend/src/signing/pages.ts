import type { Response } from 'express';
import { escapeHtml, popupHeaders } from '../auth/page';
import type { SignOutcome } from './flow';
import type { SignIntent } from './intent-repo';

const MEANING = { review: 'Reviewed', approve: 'Approved', reject: 'Rejected' } as const;

const WORKPAPER = { scope: 'scope', rcm: 'RCM', report: 'report' } as const;

/** What the signer is signing, as HTML. */
const subjectOf = (intent: SignIntent) =>
  intent.subjectKind === 'workpaper' && intent.workpaper
    ? `the <b>${WORKPAPER[intent.workpaper]}</b> workpaper`
    : `finding <b>${escapeHtml(intent.findingId ?? '')}</b>`;

/**
 * Demo users have no password: they re-authenticate by typing their user id. The page names the id, because the app
 * shows only display names, so the typed confirmation is a formality that proves presence, not a secret. DEV_AUTH only.
 */
export function devConfirmPage(res: Response, intent: SignIntent, userName: string, userId: string) {
  popupHeaders(res);
  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Confirm your signature</title>` +
        `<h1>Confirm your signature</h1>` +
        `<p>${escapeHtml(userName)}, you are signing ${subjectOf(intent)} as <b>${MEANING[intent.action]}</b>.</p>` +
        `<p>Demo sign-in has no password, so type your user id, <code>${escapeHtml(userId)}</code>, to confirm it is you.</p>` +
        `<form method="post" action="/auth/sign/${escapeHtml(intent.id)}/dev">` +
        `<input type="hidden" name="nonce" value="${escapeHtml(intent.nonce)}">` +
        `<label>User id <input name="confirm" autocomplete="off" autofocus></label> <button type="submit">Sign</button></form>`,
    );
}

/** The last page of the pop-up. The app is polling the request's status, so this window can close itself. */
export function resultPage(res: Response, outcome: SignOutcome) {
  const [status, title, message] = outcome.ok
    ? [200, 'Signed', 'Your signature was recorded. You can close this window.']
    : [409, 'Not signed', outcome.message];
  const nonce = popupHeaders(res);
  res
    .status(status as number)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title as string)}</title><h1>${escapeHtml(title as string)}</h1>` +
        `<p>${escapeHtml(message as string)}</p><script nonce="${nonce}">setTimeout(function () { window.close(); }, 1500);</script>`,
    );
}
