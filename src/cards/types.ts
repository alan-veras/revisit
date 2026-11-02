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
