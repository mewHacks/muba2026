// The elder's own screen, and the only place the full scoring detail is
// shown.
//
// This is where Gonka's submission requirements are met on screen — the
// Truth Score, the reasoning trace and every Request ID, each linking to
// its receipt. It is also the one surface allowed to show the reasoning,
// because it is showing her her own conversation. The guardian dashboard
// deliberately shows none of it; see the header of dashboard/src/app.ts.

import { TIER_PLAIN, receiptUrlFor, type StateResponse, type Verdict } from './shared.ts';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function verdictCard(verdict: Verdict, scored: number): DocumentFragment {
  const fragment = document.createDocumentFragment();

  const tier = element('div', `tier ${verdict.tier}`);
  tier.append(element('div', 'lead', TIER_PLAIN[verdict.tier]));
  tier.append(element('div', 'sig', `Signal: ${verdict.category}`));
  fragment.append(tier);

  const facts = element('div', 'card');
  const row = element('div', 'row');
  row.append(
    element('span', undefined, `${scored} message${scored === 1 ? '' : 's'} checked`),
    element(
      'span',
      undefined,
      // Gonka calls this the Truth Score. Named on screen rather than
      // shown as a bare number, so it is traceable to what produced it.
      verdict.truthScore === null ? 'no score returned' : `Truth Score ${verdict.truthScore}/100`,
    ),
  );
  facts.append(row);

  // What redaction stripped, by kind and never by value. It is the
  // privacy claim made visible: she can see that the phone number in
  // that message did not leave her laptop.
  const removed = Object.entries(verdict.redacted).filter(([, count]) => count > 0);
  if (removed.length) {
    const pills = element('div');
    pills.style.marginTop = '9px';
    for (const [kind, count] of removed) {
      pills.append(element('span', 'pill', `${count} ${kind} removed before scoring`));
    }
    facts.append(pills);
  }
  fragment.append(facts);

  if (verdict.reasoning) {
    fragment.append(element('h2', undefined, 'Why'));
    const card = element('div', 'card');
    card.append(element('div', 'reasoning', verdict.reasoning));
    fragment.append(card);
  }

  fragment.append(element('h2', undefined, 'Gonka request ids'));
  const idCard = element('div', 'card');
  if (verdict.gonkaRequestIds.length) {
    const list = element('ul', 'ids');
    for (const id of verdict.gonkaRequestIds) {
      const item = element('li');
      const link = document.createElement('a');
      link.href = receiptUrlFor(id);
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = id;
      item.append(link);
      list.append(item);
    }
    idCard.append(list);
  } else {
    // Said plainly rather than shown as an empty list: no request id
    // means no model was reached, so this verdict came from the offline
    // heuristic and should not be read as a model's opinion.
    idCard.append(
      element(
        'div',
        'empty',
        'No request ids — this verdict came from the offline safety-net check, not from a model.',
      ),
    );
  }
  fragment.append(idCard);

  fragment.append(element('h2', undefined, 'Message fingerprint'));
  const hashCard = element('div', 'card');
  const hash = element('div', 'ids', verdict.messageHash);
  hashCard.append(hash);
  hashCard.append(
    element(
      'div',
      'empty',
      'The hash of the redacted message. This is what gets signed and checked on-chain — the message itself is not stored anywhere.',
    ),
  );
  fragment.append(hashCard);

  return fragment;
}

async function main(): Promise<void> {
  let state: StateResponse;
  try {
    state = (await chrome.runtime.sendMessage({ type: 'shou:state' })) as StateResponse;
  } catch (error) {
    $('error').classList.remove('hidden');
    $('error').textContent = error instanceof Error ? error.message : String(error);
    return;
  }

  const dashboard = $('dashboard') as HTMLAnchorElement;
  dashboard.href = state.settings.dashboardUrl;
  $('options').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  if (state.lastError) {
    $('error').classList.remove('hidden');
    $('error').textContent = `Not scoring: ${state.lastError}`;
  } else if (!state.settings.policyId) {
    $('error').classList.remove('hidden');
    $('error').textContent =
      'No policy id set, so nothing is being scored. Open Settings and fetch it from the dashboard.';
  }

  const body = $('body');
  // `worst`, not `latest`: the popup answers "is this conversation safe",
  // and the answer to that is the worst thing seen in it, not the last.
  const current = state.sessions[0];
  if (!current) {
    body.append(
      element(
        'div',
        'card empty',
        'No conversation scored yet. Open a chat in WhatsApp Web or Messenger and SHOU will check each message as it arrives.',
      ),
    );
    return;
  }
  body.append(verdictCard(current.worst, current.scored));
}

void main();
