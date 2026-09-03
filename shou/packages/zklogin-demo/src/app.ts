// Browser half of the zkLogin demo.
//
// Proves the piece the pitch depends on: the elder signs in with Google
// and gets a Sui address, with no seed phrase anywhere in the flow.
//
// Enoki handles the two things that are genuinely hard here — the
// per-user salt and the ZK proof. That matters beyond convenience: a
// lost salt permanently destroys access to a zkLogin address, and
// hand-rolling that service under time pressure was the sharpest risk
// in this part of the design.

import { EnokiFlow } from '@mysten/enoki';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { walletFromZkLogin } from '../../driver/src/recovery.ts';

// Stand-ins for the son and a second relative. In the real product these
// are their own keys on their own devices; here they only need to be
// deterministic so the wallet address is stable across reloads.
const DEMO_GUARDIAN = Ed25519Keypair.deriveKeypairFromSeed(
  '0'.repeat(63) + '1',
).getPublicKey();
const DEMO_SECOND = Ed25519Keypair.deriveKeypairFromSeed(
  '0'.repeat(63) + '2',
).getPublicKey();

interface Config {
  googleClientId: string;
  enokiApiKey: string;
  network: 'testnet';
  redirectUrl: string;
  /** Real on-chain ids from demo-ids.json; empty until seed-demo.ts runs. */
  policyId: string;
  denyListId: string;
  packageId: string;
}

const els = {
  status: document.getElementById('status')!,
  address: document.getElementById('address')!,
  signIn: document.getElementById('signin') as HTMLButtonElement,
  signOut: document.getElementById('signout') as HTMLButtonElement,
  detail: document.getElementById('detail')!,
  debug: document.getElementById('debug')!,
  debugCard: document.getElementById('debug-card') as HTMLDetailsElement | null,
};

const log: string[] = [];
function trace(line: string) {
  log.push(line);
  els.debug.textContent = log.join('\n');
  // Expand the panel automatically if the URL has ?debug
  if (new URLSearchParams(location.search).has('debug') && els.debugCard) {
    els.debugCard.open = true;
  }
  console.log('[shou]', line);
}

function show(status: string, detail = '') {
  els.status.textContent = status;
  els.detail.textContent = detail;
}

const config: Config = await fetch('/config.json').then((r) => r.json());

// The Enoki SDK surfaces only "status: 400" and swallows the response
// body, which is where the actual reason lives. Tap fetch to read it.
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
  const response = await originalFetch(input as never, init);
  if (url.includes('enoki') && !response.ok) {
    const body = await response.clone().text();
    trace(`ENOKI ${response.status} ${url.replace(/https?:\/\/[^/]+/, '')}`);
    trace(`  -> ${body.slice(0, 400)}`);
  }
  return response;
};

if (!config.googleClientId || !config.enokiApiKey) {
  show('Not configured', 'GOOGLE_CLIENT_ID or NEXT_PUBLIC_ENOKI_API_KEY missing from .env');
  els.signIn.disabled = true;
} else {
  const flow = new EnokiFlow({ apiKey: config.enokiApiKey });

  trace(`path: ${window.location.pathname}`);
  trace(`hash present: ${Boolean(window.location.hash)} (len ${window.location.hash.length})`);
  trace(`hash has id_token: ${window.location.hash.includes('id_token')}`);
  if (window.location.search) trace(`query: ${window.location.search.slice(0, 200)}`);

  // Google can return an error in the query string rather than a token.
  const queryError = new URLSearchParams(window.location.search).get('error');
  if (queryError) trace(`GOOGLE ERROR: ${queryError}`);

  // Coming back from Google: the JWT arrives in the URL fragment.
  if (window.location.hash.includes('id_token')) {
    show('Completing sign-in…');
    try {
      const result = await flow.handleAuthCallback();
      trace(`handleAuthCallback ok (returned OAuth state: ${JSON.stringify(result)})`);
      history.replaceState(null, '', '/');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace(`handleAuthCallback THREW: ${message}`);
      show('Sign-in failed', message);
    }
  } else {
    trace('no id_token in fragment — callback branch skipped');
  }

  async function refresh() {
    const session = await flow.getSession();
    // The address lives in $zkLoginState, NOT on the session — the
    // session carries the ephemeral keypair and JWT, while the derived
    // address, salt and public key are set separately by
    // handleAuthCallback. Reading the wrong one looks exactly like a
    // failed login.
    const state = flow.$zkLoginState.get();
    trace(`session keys: ${session ? JSON.stringify(Object.keys(session)) : 'null'}`);
    trace(`zkLoginState address: ${state.address ?? '(none)'}`);

    if (state.address) {
      show('Signed in', 'No seed phrase was created at any point in this flow.');
      els.address.textContent = state.address;

      // The zkLogin address is only her SIGNER. Her actual wallet is the
      // multisig that also contains the two recovery members — which is
      // what keeps the funds reachable if this signer ever stops working.
      const wallet = document.getElementById('wallet')!;
      try {
        if (session?.jwt && state.salt) {
          const { address } = walletFromZkLogin({
            jwt: session.jwt,
            salt: state.salt,
            guardian: DEMO_GUARDIAN,
            second: DEMO_SECOND,
          });
          wallet.textContent = address;
          trace(`recovery wallet: ${address}`);
        } else {
          wallet.textContent = 'needs jwt + salt';
          trace(`cannot derive wallet — jwt:${Boolean(session?.jwt)} salt:${Boolean(state.salt)}`);
        }
      } catch (error) {
        wallet.textContent = 'derivation failed';
        trace(`wallet derivation THREW: ${error instanceof Error ? error.message : error}`);
      }
      els.signIn.hidden = true;
      els.signOut.hidden = false;
      const transferCard = document.getElementById('transfer-card');
      if (transferCard) transferCard.hidden = false;
      // Handy for wiring into the multisig: this is the address that
      // becomes the elder's signer.
      console.log('zkLogin address:', state.address);
    } else {
      show('Signed out');
      els.address.textContent = '—';
      els.signIn.hidden = false;
      els.signOut.hidden = true;
      const transferCard = document.getElementById('transfer-card');
      if (transferCard) transferCard.hidden = true;
    }
  }

  const messageInput = document.getElementById('scam-message') as HTMLTextAreaElement | null;
  const recipientInput = document.getElementById('recipient') as HTMLInputElement | null;
  const amountInput = document.getElementById('amount') as HTMLInputElement | null;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null;
  const checkRiskBtn = document.getElementById('check-risk-btn') as HTMLButtonElement | null;
  const transferFeedback = document.getElementById('transfer-feedback');

  // Anything interpolated into innerHTML below comes back over HTTP, so it
  // gets escaped. A `category` containing markup would otherwise execute.
  const esc = (v: unknown) =>
    String(v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );

  /**
   * Renders a value the backend returned, or says plainly that it did not
   * return one.
   *
   * NO DEFAULTS HERE, deliberately. Filling a missing truthScore with "90"
   * or a missing request id with "req-1" would mean a judge watching a
   * demo with Gonka down still sees confident-looking model output. That
   * is fabricated evidence on stage, and one question — "what was that
   * request id?" — exposes it. If the model did not answer, the screen
   * says so.
   */
  const orMissing = (v: unknown) =>
    v === undefined || v === null || v === '' ? '<em style="color:#6b7280">not returned</em>' : esc(v);

  const sessionId = `zklogin-${Date.now()}`;

  /**
   * Scores the message currently in the textarea, inside the enclave.
   *
   * Tracked so the transfer step can tell "already scored" from "never
   * looked at". In the shipped product the extension scores each message
   * as it arrives, so a verdict always exists by the time money moves;
   * requiring a human to click a button first is a demo artifact, and one
   * that silently produces a LOW when you forget.
   */
  let scoredMessage: string | null = null;

  async function scoreCurrentMessage(message: string): Promise<Record<string, any>> {
    const resp = await fetch('http://localhost:4000/risk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Pass the policy so the enclave files this verdict against it.
      // Without it the HIGH lands under the zero address and the
      // transfer step, which looks up by the real policy, misses it.
      body: JSON.stringify({ sessionId, message, policyId: config.policyId || undefined }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'risk check failed');
    scoredMessage = message;
    return data;
  }

  if (checkRiskBtn && transferFeedback) {
    checkRiskBtn.onclick = async () => {
      const message = messageInput?.value.trim();
      if (!message) {
        transferFeedback.textContent = 'Type the message she received first.';
        return;
      }
      transferFeedback.textContent = 'Scoring inside the enclave…';
      try {
        const data = await scoreCurrentMessage(message);

        const high = data.tier === 'HIGH';
        const medium = data.tier === 'MEDIUM';
        const colours = high
          ? 'background:#fee2e2;color:#991b1b'
          : medium
            ? 'background:#fef3c7;color:#92400e'
            : 'background:#dcfce7;color:#166534';
        transferFeedback.innerHTML = `
          <div style="padding:.5rem;border-radius:.25rem;margin-top:.5rem;${colours}">
            <strong>${high ? '🔴' : medium ? '🟠' : '🟢'} ${orMissing(data.tier)}</strong>
            — ${orMissing(data.category)}<br/>
            <strong>Truth score:</strong> ${orMissing(data.truthScore)} |
            <strong>Gonka request:</strong> ${orMissing(data.gonkaRequestIds?.[0])}<br/>
            <em>${orMissing(data.reasoning)}</em>
          </div>
        `;
      } catch (e) {
        transferFeedback.textContent = `Risk check failed: ${e instanceof Error ? e.message : e} (is the circuit breaker running on :4000?)`;
      }
    };
  }

  if (sendBtn && transferFeedback && recipientInput && amountInput) {
    sendBtn.onclick = async () => {
      // The policy id used to be hardcoded to 0x…cc — the fixture address
      // from the Move unit tests, which is not a real object on testnet.
      // Attesting against it produces a valid signature for a policy that
      // does not exist, so the demo looks fine right up until anything is
      // submitted on chain. It now comes from demo-ids.json, written by
      // `seed-demo.ts`, and we refuse to proceed without it.
      if (!config.policyId) {
        transferFeedback.textContent =
          'No policy id. Run: node --experimental-strip-types packages/driver/src/seed-demo.ts (writes shou/demo-ids.json), then restart this server.';
        return;
      }
      const amount = Number(amountInput.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        transferFeedback.textContent = 'Enter an amount greater than zero.';
        return;
      }

      // Score first if this exact message has not been scored yet.
      // Otherwise clicking "send" before "check" silently attests LOW with
      // category `no-conversation-scored` — technically honest, but it
      // makes a button labelled "scammed transfer" report no risk, which
      // is the worst possible thing to have on screen in front of a judge.
      const message = messageInput?.value.trim();
      if (message && message !== scoredMessage) {
        transferFeedback.textContent = 'Scoring the message inside the enclave first…';
        try {
          await scoreCurrentMessage(message);
        } catch (e) {
          transferFeedback.textContent = `Could not score the message: ${e instanceof Error ? e.message : e}`;
          return;
        }
      }

      transferFeedback.textContent = 'Asking the enclave to sign a verdict bound to this transfer…';
      try {
        const resp = await fetch('http://localhost:4000/transfer/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            policyId: config.policyId,
            recipient: recipientInput.value.trim(),
            amount: String(Math.round(amount * 1_000_000)),
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'prepare failed');

        // `hadSessionRisk` distinguishes "the AI scored this LOW" from "the
        // AI never saw a conversation". Both arrive as LOW, and conflating
        // them would overstate what was actually checked.
        const vouched = data.hadSessionRisk
          ? `Verdict from the scored conversation: ${esc(data.tier)}`
          : 'No conversation was scored — the amount limits alone applied.';

        transferFeedback.innerHTML = `
          <div style="padding:.5rem;background:#fef3c7;border-radius:.25rem;color:#92400e;margin-top:.5rem;">
            <strong>🛡️ Attestation signed (${orMissing(data.tier)})</strong><br/>
            ${orMissing(data.explanation)}<br/>
            <div style="margin-top:.5rem;font-size:.8rem;font-family:monospace;">
              Signature: ${esc(String(data.signature ?? '').slice(0, 32))}…<br/>
              Category: ${orMissing(data.category)}
            </div>
            <div style="margin-top:.5rem;font-size:.85rem;">${vouched}</div>
            <div style="margin-top:.5rem;color:#6b7280;font-size:.8rem;">
              Signed only. Nothing is on chain until this is submitted to
              <code>policy::request_transfer_attested</code>.
            </div>
          </div>
        `;
      } catch (e) {
        transferFeedback.textContent = `Transfer preparation failed: ${e instanceof Error ? e.message : e} (is the circuit breaker running on :4000?)`;
      }
    };
  }

  els.signIn.onclick = async () => {
    show('Redirecting to Google…');
    window.location.href = await flow.createAuthorizationURL({
      provider: 'google',
      clientId: config.googleClientId,
      redirectUrl: config.redirectUrl,
      network: config.network,
    });
  };

  els.signOut.onclick = async () => {
    await flow.logout();
    await refresh();
  };

  await refresh();
}
