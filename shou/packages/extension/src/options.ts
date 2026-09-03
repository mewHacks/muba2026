// Settings. Three URLs and a policy id.
//
// The "fetch from dashboard" button exists for a specific demo failure:
// the policy id changes on every republish, so a hand-copied one is
// wrong by the next morning. The dashboard already serves the live id at
// /api/config, so read it from there rather than trusting a paste.

import { DEFAULT_SETTINGS, loadSettings, type Settings } from './shared.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function show(kind: 'ok' | 'bad', message: string): void {
  const status = $('status');
  status.className = `status ${kind}`;
  status.textContent = message;
}

function read(): Settings {
  return {
    policyId: $<HTMLInputElement>('policyId').value.trim(),
    circuitBreakerUrl: $<HTMLInputElement>('circuitBreakerUrl').value.trim() || DEFAULT_SETTINGS.circuitBreakerUrl,
    dashboardUrl: $<HTMLInputElement>('dashboardUrl').value.trim() || DEFAULT_SETTINGS.dashboardUrl,
    enabled: $<HTMLInputElement>('enabled').checked,
  };
}

function write(settings: Settings): void {
  $<HTMLInputElement>('policyId').value = settings.policyId;
  $<HTMLInputElement>('circuitBreakerUrl').value = settings.circuitBreakerUrl;
  $<HTMLInputElement>('dashboardUrl').value = settings.dashboardUrl;
  $<HTMLInputElement>('enabled').checked = settings.enabled;
}

async function main(): Promise<void> {
  write(await loadSettings());

  $('save').addEventListener('click', () => {
    void chrome.storage.local.set(read()).then(() => show('ok', 'Saved.'));
  });

  $('fetch').addEventListener('click', () => {
    void (async () => {
      const base = read().dashboardUrl.replace(/\/$/, '');
      try {
        const response = await fetch(`${base}/api/config`);
        const body = (await response.json()) as { policyId?: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? `dashboard returned ${response.status}`);
        if (!body.policyId) throw new Error('the dashboard has no policy id either — run seed-demo.ts');
        $<HTMLInputElement>('policyId').value = body.policyId;
        // Saved immediately: a fetched-but-unsaved value is the same
        // demo-day failure this button exists to prevent.
        await chrome.storage.local.set(read());
        show('ok', `Policy id read from the dashboard and saved: ${body.policyId}`);
      } catch (error) {
        show('bad', `Could not read from ${base}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  $('test').addEventListener('click', () => {
    void (async () => {
      const base = read().circuitBreakerUrl.replace(/\/$/, '');
      try {
        const response = await fetch(`${base}/health`);
        const body = (await response.json()) as { status?: string };
        if (!response.ok) {
          // /health returns 503 with a body when the enclave is down,
          // which is a different fix from the breaker being down — so
          // report which one it is.
          throw new Error(body.status ?? `returned ${response.status}`);
        }
        show('ok', `Circuit breaker reachable, enclave ${body.status}.`);
      } catch (error) {
        show('bad', `${base} — ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });
}

void main();
