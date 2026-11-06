import { describe, expect, it } from 'vitest';
import { bibleReference, clozeFront, initialType, resolveOnSave, splitAlternatives } from '../src/capture/autoType';

const HEB = `---
tags: []
---
# Hebrews 11

# Hebreus 11 (Nova Versão Internacional)

###### 1
Ora, a fé é a certeza daquilo que esperamos e a prova das coisas que não vemos.

###### 2
Pois foi por meio dela que os antigos receberam good testemunho.
`;

describe('initialType', () => {
	it('PDF selection is a problem, a verse note a reference, the rest a question', () => {
		expect(initialType({ isPdf: true, hasReference: false, selection: 'Enunciado' })).toBe('Problem');
		expect(initialType({ isPdf: false, hasReference: true, selection: 'Ora' })).toBe('Reference');
		expect(initialType({ isPdf: false, hasReference: false, selection: 'algo' })).toBe('Question');
		expect(initialType({ isPdf: false, hasReference: false, selection: '' })).toBe('Question');
	});
});

describe('bibleReference', () => {
	it('reads chapter and verse from the note', () => {
		expect(bibleReference(HEB, 9)).toBe('Hebreus 11:1');
		expect(bibleReference(HEB, 12)).toBe('Hebreus 11:2');
	});
	it('is null outside a Bible note', () => {
		expect(bibleReference('# Uma grade\n\ntexto', 2)).toBeNull();
	});
});

describe('resolveOnSave', () => {
	it('keeps a written front', () => {
		expect(resolveOnSave({ type: 'Question', front: ' P? ', back: ' R ', context: '' })).toEqual({ type: 'Question', front: 'P?', back: 'R' });
	});
	it('turns an empty front on a short selection into a cloze', () => {
		const r = resolveOnSave({ type: 'Question', front: '', back: 'Amazon Bedrock', context: 'Foundation Model as a Service: Amazon Bedrock.' });
		expect(r).toEqual({ type: 'Cloze', front: 'Foundation Model as a Service: [...].', back: 'Amazon Bedrock' });
	});
	it('refuses an empty front on a long selection and an empty back', () => {
		const long = 'um dois três quatro cinco seis sete oito nove dez';
		expect('error' in resolveOnSave({ type: 'Question', front: '', back: long, context: long })).toBe(true);
		expect('error' in resolveOnSave({ type: 'Question', front: 'P', back: ' ', context: '' })).toBe(true);
	});
	it('clozeFront without context still hides', () => {
		expect(clozeFront('', 'x')).toBe('[...]');
	});
});

describe('splitAlternatives', () => {
	it('puts each alternative on its own paragraph', () => {
		expect(splitAlternatives('A fila retira o elemento que (A) foi inserido por último (B) foi inserido primeiro')).toBe(
			'A fila retira o elemento que\n\n(A) foi inserido por último\n\n(B) foi inserido primeiro',
		);
	});
	it('accepts lowercase and normalizes it', () => {
		expect(splitAlternatives('Qual? (a) um (b) dois (c) três')).toBe('Qual?\n\n(A) um\n\n(B) dois\n\n(C) três');
	});
	it('leaves text with fewer than two alternatives alone', () => {
		expect(splitAlternatives('O valor (A) é positivo')).toBe('O valor (A) é positivo');
	});
});

describe('resolveOnSave focus', () => {
	it('an empty back points the cursor at the back, an empty front at the front', () => {
		const r1 = resolveOnSave({ type: 'Question', front: 'P', back: ' ', context: '' });
		expect(r1).toEqual({ error: 'The back is empty.', focus: 'back' });
		const long = 'um dois três quatro cinco seis sete oito nove dez';
		const r2 = resolveOnSave({ type: 'Question', front: '', back: long, context: long });
		expect(r2).toEqual({ error: 'Write the question: a cloze only covers a short excerpt (up to 8 words).', focus: 'front' });
	});
});
