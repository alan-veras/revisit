import { AREAS } from '../cards/types';
import { NO_AREA } from './queue';

export interface TreeNode {
	/** `Area` or `Area > topic > sub`, unique */
	path: string;
	name: string;
	area: string;
	/** topic prefix for the filter; null at the area level */
	topic: string | null;
	cards: number;
	children: TreeNode[];
}

/** Area > topic > … with the number of cards under each level; empty levels are left out. */
export function topicTree(items: { area: string | null; card: { topics: string[] } }[]): TreeNode[] {
	const roots = new Map<string, TreeNode>();
	const node = (parent: TreeNode | null, area: string, name: string, topic: string | null): TreeNode => {
		const list = parent ? parent.children : null;
		const path = topic ? `${area} > ${topic}` : area;
		let n = list ? list.find((c) => c.path === path) : roots.get(area);
		if (!n) {
			n = { path, name, area, topic, cards: 0, children: [] };
			if (list) list.push(n);
			else roots.set(area, n);
		}
		return n;
	};
	for (const it of items) {
		const area = it.area ?? NO_AREA;
		const root = node(null, area, area, null);
		root.cards++;
		const seen = new Set<TreeNode>();
		for (const a of it.card.topics) {
			let cur = root;
			const parts = a.split(' > ');
			parts.forEach((p, i) => {
				cur = node(cur, area, p, parts.slice(0, i + 1).join(' > '));
				if (!seen.has(cur)) {
					seen.add(cur);
					cur.cards++;
				}
			});
		}
	}
	const order = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'pt-BR');
	const sortDeep = (ns: TreeNode[]): TreeNode[] => ns.sort(order).map((n) => ({ ...n, children: sortDeep(n.children) }));
	const rank = (a: string) => {
		const i = (AREAS as readonly string[]).indexOf(a);
		return i < 0 ? 99 : i;
	};
	return [...roots.values()].sort((a, b) => rank(a.area) - rank(b.area)).map((n) => ({ ...n, children: sortDeep(n.children) }));
}
