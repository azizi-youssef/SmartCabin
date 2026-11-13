/**
 * Runs once when a server instance starts (Next.js instrumentation).
 * SC-AUD-24: reports a Node.js runtime whose time zone data predates Morocco's move to UTC+0,
 * since every clinic time the server formats or converts would then be one hour off. The app
 * keeps running (staff can still work); the error is in the server log from the first second.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { timeZoneDataProblem } = await import('./shared/lib/tzdata');
  const problem = timeZoneDataProblem();
  if (problem) console.error(`[SmartCabin] SC-AUD-24: ${problem}`);
}
