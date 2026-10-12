import { writeFileSync } from 'node:fs';

import { networks } from './deploy.mjs';
import { collectReviewedInputs, reviewedInputsPath } from './reviewed-inputs.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--write') {
  throw new Error('Usage: node script/generate-reviewed-inputs.mjs --write');
}

writeFileSync(reviewedInputsPath, `${JSON.stringify(collectReviewedInputs(networks), null, 2)}\n`);
console.log(`Wrote ${reviewedInputsPath}. Review and commit its complete diff.`);
