import { useState, useEffect, useCallback } from 'react';

/**
 * Offers the newer release published on GitHub, in the desktop build only.
 *
 * Applying it replaces the running executable and restarts, so the person
 * using the app never has to be sent a new file by hand.
 */

interface UpdateInfo {
  version: string;
  current: string;
  notes: string;
  url: string;
  size: number;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function invoker(): Invoke | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } };
  return w.__TAURI_INTERNALS__?.invoke ?? null;
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const invoke = invoker();
    if (!invoke) return; // browser build
    let cancelled = false;
    invoke<UpdateInfo | null>('update_check')
      .then(u => { if (!cancelled && u) setInfo(u); })
      // A missing network or rate limit must not disturb the app.
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const apply = useCallback(async () => {
    const invoke = invoker();
    if (!invoke || !info) return;
    setBusy(true);
    setError(null);
    try {
      // On success the app restarts, so nothing after this runs.
      await invoke('update_apply', { url: info.url, size: info.size });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [info]);

  if (!info || dismissed) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-thermal-accent/30 bg-thermal-accent/10 px-4 py-2.5">
      <div className="size-1.5 rounded-full bg-thermal-accent shadow-[0_0_6px] shadow-thermal-accent/40" />
      <span className="font-display text-[0.7rem] text-thermal-heading">
        Version {info.version} available
      </span>
      <span className="font-display text-[0.65rem] text-thermal-muted">
        you have {info.current} · {(info.size / 1e6).toFixed(1)} MB
      </span>

      {error && (
        <span className="font-display text-[0.65rem] text-thermal-hot" role="alert">
          {error}
        </span>
      )}

      <div className="flex-1" />
      <button
        onClick={apply}
        disabled={busy}
        className="px-3 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all bg-thermal-accent text-black shadow-[0_1px_6px] shadow-thermal-accent/30 disabled:opacity-60"
      >
        {busy ? 'Updating…' : 'Update and restart'}
      </button>
      <button
        onClick={() => setDismissed(true)}
        disabled={busy}
        className="px-2.5 py-1.5 rounded-md font-display text-[0.7rem] font-semibold transition-all text-thermal-muted hover:text-thermal-text hover:bg-white/5"
      >
        Later
      </button>
    </div>
  );
}
