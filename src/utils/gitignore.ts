import { createRequire } from 'node:module';
import { Ignore } from 'ignore';

const require = createRequire(import.meta.url);
const ignore = require('ignore') as typeof import('ignore').default;

export type IgnoreMatcher = Ignore;

export function createIgnoreMatcher(contents: string[]): IgnoreMatcher {
  return ignore().add(contents.flatMap((content) => content.split(/\r?\n/)));
}
