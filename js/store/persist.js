// Persistent-storage request and the decision logic around it. Pure functions plus one best-effort async helper;
// nothing here throws or blocks.

/**
 * Ask the browser not to evict our storage. Resolves 'granted', 'denied' or 'unavailable'. Never throws.
 * @param {{persisted?:()=>Promise<boolean>, persist?:()=>Promise<boolean>}|undefined} storage  navigator.storage
 */
export async function requestPersistence(storage = globalThis.navigator?.storage) {
  try {
    if (!storage || typeof storage.persist !== 'function') return 'unavailable';
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'granted';
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Show the eviction notice only once we know persistence was not granted, and only until it is dismissed. */
export function shouldShowStorageNotice({ status, dismissed }) {
  return (status === 'denied' || status === 'unavailable') && !dismissed;
}

/** "120 MB of 2.0 GB used", or null when the browser gave no usable numbers. */
export function formatEstimate(est) {
  if (!est || !(est.usage >= 0) || !(est.quota > 0)) return null;
  const fmt = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
  return `${fmt(est.usage)} of ${fmt(est.quota)} used`;
}

export async function readEstimate(storage = globalThis.navigator?.storage) {
  try {
    if (!storage || typeof storage.estimate !== 'function') return null;
    return formatEstimate(await storage.estimate());
  } catch {
    return null;
  }
}
