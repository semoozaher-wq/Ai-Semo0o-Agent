#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join('data', 'painMap.json');
let data;

try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`Cannot read valid JSON from ${file}: ${error.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];

if (data.muscles && typeof data.muscles === 'object') {
  const entries = Object.entries(data.muscles);
  const ids = entries.map(([key, value]) => value.id || key);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

  for (const [key, muscle] of entries) {
    if (!muscle || typeof muscle !== 'object') errors.push(`${key}: must be an object`);
    if (!muscle.id) errors.push(`${key}: missing id`);
    if (muscle.id && muscle.id !== key) warnings.push(`${key}: object id differs from object key (${muscle.id})`);
    if (!muscle.labelAr) errors.push(`${key}: missing labelAr`);
    if (!muscle.group) errors.push(`${key}: missing group`);
    if (!Array.isArray(muscle.views) || muscle.views.length === 0) errors.push(`${key}: views must be a non-empty array`);
    if (!Array.isArray(muscle.commonCauses)) errors.push(`${key}: commonCauses must be an array`);
  }

  for (const id of duplicateIds) errors.push(`duplicate muscle id: ${id}`);

  if (entries.length !== 317) {
    warnings.push(`found ${entries.length} muscles; the target is 317 after the licensed SVG IDs are added`);
  }
} else {
  const regions = Object.entries(data);
  if (regions.length === 0) errors.push('database is empty');
  for (const [key, region] of regions) {
    if (!region.label) errors.push(`${key}: missing label`);
    if (!Array.isArray(region.commonCauses)) errors.push(`${key}: commonCauses must be an array`);
    if (!region.recommendation) warnings.push(`${key}: missing recommendation`);
  }
  warnings.push('database is using the current general-region format; migrate to groups + muscles for the 317-part anatomy map');
}

if (errors.length) {
  console.error(`Validation failed for ${file}`);
  errors.forEach((message) => console.error(`ERROR: ${message}`));
  process.exit(1);
}

console.log(`Validation passed for ${file}`);
warnings.forEach((message) => console.warn(`WARNING: ${message}`));
