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

interface Config {
  googleClientId: string;
  enokiApiKey: string;
  network: 'testnet';
  redirectUrl: string;
}

const els = {
  status: document.getElementById('status')!,
  address: document.getElementById('address')!,
  signIn: document.getElementById('signin') as HTMLButtonElement,
  signOut: document.getElementById('signout') as HTMLButtonElement,
  detail: document.getElementById('detail')!,
  debug: document.getElementById('debug')!,
};

const log: string[] = [];
function trace(line: string) {
  log.push(line);
  els.debug.textContent = log.join('\n');
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
      els.signIn.hidden = true;
      els.signOut.hidden = false;
      // Handy for wiring into the multisig: this is the address that
      // becomes the elder's signer.
      console.log('zkLogin address:', state.address);
    } else {
      show('Signed out');
      els.address.textContent = '—';
      els.signIn.hidden = false;
      els.signOut.hidden = true;
    }
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
