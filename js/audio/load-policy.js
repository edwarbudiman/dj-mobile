// What to do when a library track fails to load. Pure.
//
// A track is NEVER removed automatically: the error can be a transient read failure, an out-of-memory decode that
// the browser reports as a decode error, a context closed mid-load... Deleting stays a deliberate user action.

export const FAILED_MESSAGE = "Can't play this file. It may be corrupt, in an unsupported format, or too big for this device.";

/**
 * @param {{ok?:boolean, oom?:boolean}} res  result of a deck load (superseded / cancelled loads are filtered out by the caller)
 * @param {{id?:string}} item  the library record
 * @returns {{message:string|null, markFailed:boolean}}
 * message: the toast to show (null: nothing, either a success or the deck already reported an out-of-memory failure).
 * markFailed: flag the library item "Couldn't play" (never for a demo, which has no stored record).
 */
export function decideLoadFailure(res, item) {
  if (!res || res.ok) return { message: null, markFailed: false };
  const isDemo = typeof item?.id === 'string' && item.id.startsWith('demo:');
  return { message: res.oom ? null : FAILED_MESSAGE, markFailed: !isDemo && !!item?.id };
}
