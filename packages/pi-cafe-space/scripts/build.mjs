import { parseArgs } from 'node:util';
import { buildCandidate } from './refactor/build.mjs';
import { buildAdditionalPlatforms, parsePlatforms } from './refactor/matrix.mjs';
import { stageRelease } from './refactor/release.mjs';

const { values } = parseArgs({options:{platforms:{type:'string'}},strict:true});
const targets = parsePlatforms(values.platforms);
const primary = await buildCandidate();
await buildAdditionalPlatforms(targets);
const { target, metadata } = await stageRelease(false, [...new Set([primary.platform, ...targets])]);
console.log(JSON.stringify({built:true,packageDirectory:target,platforms:Object.keys(metadata.platforms),webDigest:metadata.webDigest}));
