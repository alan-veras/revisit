/** The moments a review measures from: the session's start and end, and when the card was shown (ms). */
export interface Clock {
	startedAt: number;
	endsAt: number;
	shownAt: number;
}

/** The clock after a pause of `paused` ms: everything moves forward, so the pause counts nowhere. */
export function shiftClock(c: Clock, paused: number): Clock {
	return { startedAt: c.startedAt + paused, endsAt: c.endsAt + paused, shownAt: c.shownAt + paused };
}

/** Whole minutes left in the session, rounded up, never under one. */
export function minutesLeft(endsAt: number, now: number): number {
	return Math.max(1, Math.ceil((endsAt - now) / 60_000));
}
