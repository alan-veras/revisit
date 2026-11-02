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
Pois foi por meio dela que os antigos receberam bom testemunho.
`;

describe('initialType', () => {
	it('PDF selection is a question, Bible a reference, the rest a question-and-answer', () => {
		expect(initialType({ isPdf: true, path: 'p.pdf', selection: 'Enunciado' })).toBe('Questão');
		expect(initialType({ isPdf: false, path: '2_The Bible/NT/Hebrews/Heb 11.md', selection: 'Ora' })).toBe('Referência');
		expect(initialType({ isPdf: false, path: '4_Resources/x.md', selection: 'algo' })).toBe('Pergunta');
		expect(initialType({ isPdf: false, path: null, selection: '' })).toBe('Pergunta');
	});
});

describe('bibleReference', () => {
	it('reads chapter and verse from the note', () => {
		expect(bibleReference(HEB, 9)).toBe('Hebreus 11:1');
		expect(bibleReference(HEB, 12)).toBe('Hebreus 11:2');
	});
	it('is null outside a Bible note', () => {
		expect(bibleReference('# Uma nota\n\ntexto', 2)).toBeNull();
	});
});

describe('resolveOnSave', () => {
	it('keeps a written front', () => {
		expect(resolveOnSave({ tipo: 'Pergunta', frente: ' P? ', verso: ' R ', context: '' })).toEqual({ tipo: 'Pergunta', frente: 'P?', verso: 'R' });
	});
	it('turns an empty front on a short selection into a cloze', () => {
		const r = resolveOnSave({ tipo: 'Pergunta', frente: '', verso: 'Amazon Bedrock', context: 'Foundation Model as a Service: Amazon Bedrock.' });
		expect(r).toEqual({ tipo: 'Lacuna', frente: 'Foundation Model as a Service: [...].', verso: 'Amazon Bedrock' });
	});
	it('refuses an empty front on a long selection and an empty back', () => {
		const long = 'um dois três quatro cinco seis sete oito nove dez';
		expect('error' in resolveOnSave({ tipo: 'Pergunta', frente: '', verso: long, context: long })).toBe(true);
		expect('error' in resolveOnSave({ tipo: 'Pergunta', frente: 'P', verso: ' ', context: '' })).toBe(true);
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
