export const TIPOS = ['Pergunta', 'Lacuna', 'Referência', 'Questão'] as const;
export type Tipo = (typeof TIPOS)[number];

export const AREAS = ['Carreira', 'Academia', 'Desenvolvimento Pessoal', 'Espiritual', 'Lazer'] as const;

/** One flashcard as written in a card file. */
export interface Card {
	id: string | null;
	tipo: Tipo;
	frente: string;
	verso: string;
	/** written only when it cannot be read from the source path, or differs */
	area?: string;
	assuntos: string[];
	/** `#importante` and the like: written only when the card has some */
	tags?: string[];
	/** also reviewed back to front */
	reverso?: boolean;
	fonte: string;
	/** card file this card lives in (vault path); set by the store */
	file?: string;
	/** first and last line of the block inside its file (0-based, inclusive) */
	start: number;
	end: number;
}

export function isTipo(value: string): value is Tipo {
	return (TIPOS as readonly string[]).includes(value);
}

export const IMPORTANT_TAG = 'importante';

/** Tags as written (`#importante #fe`) into a clean list without the `#`. */
export function parseTags(value: string): string[] {
	return value
		.split(/[\s,;]+/)
		.map((t) => t.replace(/^#/, '').trim().toLowerCase())
		.filter(Boolean);
}

export function isImportant(card: Pick<Card, 'tags'> | undefined): boolean {
	return !!card?.tags?.includes(IMPORTANT_TAG);
}
