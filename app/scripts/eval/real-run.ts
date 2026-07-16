#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRealRunCli } from './real-run-session.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = await runRealRunCli(process.argv.slice(2), {
	repoRoot: path.resolve(here, '../../..'),
	defaultManifest: path.join(here, 'corpus-manifest.json'),
});
if (result.signal) {
	process.kill(process.pid, result.signal);
} else {
	process.exit(result.exitCode);
}
