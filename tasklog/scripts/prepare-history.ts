import { openDb } from '../src/db/open.ts';
import { createEvaluationView } from '../src/eval/privacy.ts';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
if (!flag('db') || !flag('output') || !flag('until')) throw new Error('Usage: prepare-history --db SOURCE --output NEW_DB --until EPOCH_MS');
const source = openDb({ path: resolve(flag('db')!), readonly: true });
try { console.log(JSON.stringify(createEvaluationView(source, resolve(flag('output')!), Number(flag('until'))), null, 2)); }
finally { source.close(); }
