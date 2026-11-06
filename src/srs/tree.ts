import { NO_SOURCE } from './queue';

export interface TreeNode {
	/** unique inside its tree */
	path: string;
	name: string;
	/** folder or note for the filter; null in a topic tree */
	scope: string | null;
	/** topic prefix for the filter; null in a source tree */
	topic: string | null;
	cards: number;
	children: TreeNode[];
}

function sortDeep(nodes: TreeNode[]): TreeNode[] {
	return nodes.sort((a, b) => a.name.localeCompare(b.name)).map((n) => ({ ...n, children: sortDeep(n.children) }));
}

/** Folder > subfolder > note, with the number of cards under each level. */
export function sourceTree(items: { source: string | null }[]): TreeNode[] {
	const roots: TreeNode[] = [];
	for (const it of items) {
		const parts = (it.source ?? NO_SOURCE).split('/');
		let list = roots;
		parts.forEach((part, i) => {
			const path = parts.slice(0, i + 1).join('/');
			let n = list.find((c) => c.path === path);
			if (!n) {
				n = { path, name: i === parts.length - 1 ? part.replace(/\.md$/, '') : part, scope: path, topic: null, cards: 0, children: [] };
				list.push(n);
			}
			n.cards++;
			list = n.children;
		});
	}
	return sortDeep(roots);
}

/** Topic > subtopic > …, with the number of cards under each level. Cards without a topic are left out. */
export function topicTree(items: { card: { topics: string[] } }[]): TreeNode[] {
	const roots: TreeNode[] = [];
	for (const it of items) {
		const seen = new Set<TreeNode>();
		for (const topic of it.card.topics) {
			const parts = topic.split(' > ');
			let list = roots;
			parts.forEach((part, i) => {
				const path = parts.slice(0, i + 1).join(' > ');
				let n = list.find((c) => c.path === path);
				if (!n) {
					n = { path, name: part, scope: null, topic: path, cards: 0, children: [] };
					list.push(n);
				}
				if (!seen.has(n)) {
					seen.add(n);
					n.cards++;
				}
				list = n.children;
			});
		}
	}
	return sortDeep(roots);
}
