// A phone whose clock is off: PHONE_SKEW_MS moves JavaScript's clock here
// and SQLite's datetime('now') in sqlite.mjs. The server keeps its own. A
// scenario can set the clock right later (setSkew), as a phone does when
// it fixes its time.
export const SKEW = Number(process.env.PHONE_SKEW_MS || 0);
let skew = SKEW;
export function setSkew(ms) { skew = ms; }
if (SKEW) {
  const RealDate = Date;
  class SkewDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); }
    static now() { return RealDate.now() + skew; }
  }
  globalThis.Date = SkewDate;
}
