import { Card as FsrsCard, fsrs, State } from 'ts-fsrs';

/** Minimal card shape the forecast needs; independent of the card/queue modules. */
export interface ForecastCard {
	key: string;
	type: string;
	tags?: readonly string[];
	fsrs?: FsrsCard;
	suspended?: boolean;
	pending?: boolean;
}

/** Median seconds per card type, as produced by `secsPerType`. */
export type SecsByType = Record<string, number>;

const DAY_MS = 86400000;
const FALLBACK_SECS = 10;

function startOfDay(now: Date): Date {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d;
}

function isScheduled(c: ForecastCard): c is ForecastCard & { fsrs: FsrsCard } {
	return !c.suspended && !c.pending && !!c.fsrs && c.fsrs.state !== State.New;
}

function secsOf(c: ForecastCard, secs: SecsByType): number {
	return secs[c.type] ?? FALLBACK_SECS;
}

function isImportantCard(c: ForecastCard): boolean {
	return !!c.tags?.some((t) => t.replace(/^#/, '').toLowerCase() === 'important');
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface Forecast {
	/** minutes per day, index 0 = today (overdue cards count today) */
	perDay: number[];
	/** minutes due tomorrow */
	tomorrow: number;
	/** minutes over today and the next 6 days */
	next7: number;
	/** the heaviest day */
	peak: { day: number; minutes: number };
}

/** Minutes of review per day over the next `days` days: cards due that day x median seconds of their type. */
export function forecastMinutes(cards: readonly ForecastCard[], secs: SecsByType, now: Date, days = 30): Forecast {
	const start = startOfDay(now).getTime();
	const seconds = new Array<number>(days).fill(0);
	for (const c of cards) {
		if (!isScheduled(c)) continue;
		const d = Math.max(0, Math.floor((c.fsrs.due.getTime() - start) / DAY_MS));
		if (d < days) seconds[d] = (seconds[d] ?? 0) + secsOf(c, secs);
	}
	const perDay = seconds.map((s) => round1(s / 60));
	let peak = { day: 0, minutes: 0 };
	perDay.forEach((m, day) => {
		if (m > peak.minutes) peak = { day, minutes: m };
	});
	return {
		perDay,
		tomorrow: perDay[1] ?? 0,
		next7: round1(perDay.slice(0, 7).reduce((a, b) => a + b, 0)),
		peak,
	};
}

/** Cards due per day over the next `days` days (index 0 = today, overdue counts today). */
export function dueCounts(cards: readonly ForecastCard[], now: Date, days = 30): number[] {
	const start = startOfDay(now).getTime();
	const out = new Array<number>(days).fill(0);
	for (const c of cards) {
		if (!isScheduled(c)) continue;
		const d = Math.max(0, Math.floor((c.fsrs.due.getTime() - start) / DAY_MS));
		if (d < days) out[d] = (out[d] ?? 0) + 1;
	}
	return out;
}

/** Average minutes per day over the 7 days after today (tomorrow to day 7). */
export function averageAhead(f: Forecast): number {
	return round1(f.perDay.slice(1, 8).reduce((a, b) => a + b, 0) / 7);
}

export type LoadLabel = 'Light' | 'Sustainable' | 'Heavy';

export interface Sustainability {
	/** steady-state minutes per day with no new cards (existing cards only) */
	baseMinutes: number;
	/** steady-state minutes per day at the current new-card rate */
	currentMinutes: number;
	/** same, with `extraNew` more new cards per day */
	whatIfMinutes: number;
	label: LoadLabel;
	whatIfLabel: LoadLabel;
}

/** Reviews a card is expected to need in its first year; drives the cost of each daily new card. */
export const REVIEWS_FIRST_YEAR = 8;

/** Light under 60% of the daily budget, Sustainable up to 100%, Heavy above. */
export function loadLabel(minutes: number, budgetMinutes: number): LoadLabel {
	if (budgetMinutes <= 0) return 'Heavy';
	const r = minutes / budgetMinutes;
	if (r < 0.6) return 'Light';
	return r <= 1 ? 'Sustainable' : 'Heavy';
}

/**
 * Steady-state workload. Each existing review card comes back about every
 * `stability` days, so it costs secs/stability per day. Each new card per day
 * adds about REVIEWS_FIRST_YEAR reviews per day once a year of them has piled up.
 */
export function sustainability(
	cards: readonly ForecastCard[],
	secs: SecsByType,
	o: { newPerDay: number; extraNew: number; budgetMinutes: number },
): Sustainability {
	let baseSecs = 0;
	let secSum = 0;
	let n = 0;
	for (const c of cards) {
		if (c.suspended || c.pending) continue;
		const s = secsOf(c, secs);
		secSum += s;
		n++;
		if (isScheduled(c)) baseSecs += s / Math.max(1, c.fsrs.stability);
	}
	const avgSecs = n > 0 ? secSum / n : FALLBACK_SECS;
	const perNew = (avgSecs * REVIEWS_FIRST_YEAR) / 60;
	const baseMinutes = baseSecs / 60;
	const currentMinutes = baseMinutes + Math.max(0, o.newPerDay) * perNew;
	const whatIfMinutes = baseMinutes + Math.max(0, o.newPerDay + o.extraNew) * perNew;
	return {
		baseMinutes: round1(baseMinutes),
		currentMinutes: round1(currentMinutes),
		whatIfMinutes: round1(whatIfMinutes),
		label: loadLabel(currentMinutes, o.budgetMinutes),
		whatIfLabel: loadLabel(whatIfMinutes, o.budgetMinutes),
	};
}

export interface CatchUpDay {
	/** 0 = today */
	day: number;
	keys: string[];
	/** minutes of backlog placed on this day, on top of what is naturally due */
	minutes: number;
}

export interface CatchUpPlan {
	days: CatchUpDay[];
	overdue: number;
	/** minutes the whole backlog would take */
	overdueMinutes: number;
	/** backlog cards that did not fit in the horizon */
	unplaced: string[];
}

const defaultFsrs = fsrs({ enable_fuzz: false });

/**
 * Spreads the overdue backlog over the coming days without passing the daily
 * budget (cards already due that day count against it). Order: #important
 * first, then lowest retrievability. A day always takes at least one card so
 * an oversized card cannot block the plan.
 */
export function catchUpPlan(
	cards: readonly ForecastCard[],
	secs: SecsByType,
	o: {
		now: Date;
		budgetMinutes: number;
		horizonDays?: number;
		retrievability?: (c: FsrsCard, now: Date) => number;
	},
): CatchUpPlan {
	const horizon = o.horizonDays ?? 30;
	const retr = o.retrievability ?? ((c, now) => defaultFsrs.get_retrievability(c, now, false));
	const start = startOfDay(o.now).getTime();
	const budget = o.budgetMinutes * 60;

	const natural = new Array<number>(horizon).fill(0);
	const backlog: { c: ForecastCard & { fsrs: FsrsCard }; r: number; important: boolean }[] = [];
	for (const c of cards) {
		if (!isScheduled(c)) continue;
		if (c.fsrs.due.getTime() < start) {
			backlog.push({ c, r: retr(c.fsrs, o.now), important: isImportantCard(c) });
		} else {
			const d = Math.floor((c.fsrs.due.getTime() - start) / DAY_MS);
			if (d < horizon) natural[d] = (natural[d] ?? 0) + secsOf(c, secs);
		}
	}
	backlog.sort((a, b) => Number(b.important) - Number(a.important) || a.r - b.r);

	const days: CatchUpDay[] = Array.from({ length: horizon }, (_, day) => ({ day, keys: [], minutes: 0 }));
	const used = [...natural];
	const unplaced: string[] = [];
	let day = 0;
	for (const { c } of backlog) {
		const s = secsOf(c, secs);
		while (day < horizon && (used[day] ?? 0) + s > budget && (days[day] as CatchUpDay).keys.length > 0) day++;
		if (day >= horizon) {
			unplaced.push(c.key);
			continue;
		}
		const d = days[day] as CatchUpDay;
		d.keys.push(c.key);
		used[day] = (used[day] ?? 0) + s;
		d.minutes += s / 60;
	}
	for (const d of days) d.minutes = round1(d.minutes);
	const overdueMinutes = round1(backlog.reduce((a, b) => a + secsOf(b.c, secs), 0) / 60);
	return { days: days.filter((d) => d.keys.length > 0), overdue: backlog.length, overdueMinutes, unplaced };
}

/** The backlog is "large" once clearing it would take more than this many daily budgets. */
export const CATCH_UP_FACTOR = 2;

export interface CatchUpOffer {
	overdue: number;
	overdueMinutes: number;
	/** keys of today's slice, in review order */
	todayKeys: string[];
	todayMinutes: number;
	/** days the plan takes, counting today */
	planDays: number;
	/** part of the backlog did not fit in the horizon, so the plan runs longer than `planDays` */
	open: boolean;
}

/** Null while the overdue backlog is under CATCH_UP_FACTOR x the daily budget. */
export function catchUpOffer(plan: CatchUpPlan, budgetMinutes: number): CatchUpOffer | null {
	if (plan.overdue === 0 || plan.overdueMinutes <= CATCH_UP_FACTOR * budgetMinutes) return null;
	const today = plan.days[0]?.day === 0 ? plan.days[0] : undefined;
	const last = plan.days[plan.days.length - 1];
	return {
		overdue: plan.overdue,
		overdueMinutes: plan.overdueMinutes,
		todayKeys: today?.keys ?? [],
		todayMinutes: today?.minutes ?? 0,
		planDays: last ? last.day + 1 : 0,
		open: plan.unplaced.length > 0,
	};
}

/** "about 6 days" / "more than 30 days" */
export function planDaysText(o: Pick<CatchUpOffer, 'planDays' | 'open'>): string {
	return o.open ? `more than ${o.planDays} days` : `${o.planDays} ${o.planDays === 1 ? 'day' : 'days'}`;
}
