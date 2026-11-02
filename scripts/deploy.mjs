// Copies the built plugin into a vault. Override the target with LEMBRO_VAULT.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const vault = process.env.LEMBRO_VAULT ?? '/home/alanv/Trabalhos/Obsidian/second-brain';
const target = join(vault, '.obsidian', 'plugins', 'lembro');

mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(file, join(target, file));
process.stdout.write(`Lembro copied to ${target}\n`);
