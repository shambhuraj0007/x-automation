/**
 * src/cleanImages.js
 * Deletes images in data/images/ that are older than RETENTION_DAYS (default 10).
 *
 * Images use filenames like: YYYY-MM-DD-<random>.png
 * The date is parsed from the filename — no filesystem metadata needed.
 *
 * Usage:
 *   node src/cleanImages.js
 *   RETENTION_DAYS=7 node src/cleanImages.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.join(process.cwd(), 'data', 'images');
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '10', 10);

function run() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.log('cleanImages: data/images/ does not exist — nothing to clean');
    process.exit(0);
  }

  const files = fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.png'));
  const now = Date.now();
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let deleted = 0;
  let kept = 0;

  for (const file of files) {
    // Parse date from filename: YYYY-MM-DD-<random>.png
    const match = file.match(/^(\d{4}-\d{2}-\d{2})-/);
    if (!match) {
      console.log(`cleanImages: skipping unrecognised file: ${file}`);
      continue;
    }

    const fileDate = new Date(match[1]).getTime();
    if (isNaN(fileDate)) {
      console.log(`cleanImages: could not parse date from: ${file}`);
      continue;
    }

    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(IMAGES_DIR, file));
      console.log(`cleanImages: 🗑️  deleted ${file} (age: ${Math.floor((now - fileDate) / 86400000)} days)`);
      deleted++;
    } else {
      kept++;
    }
  }

  console.log(`cleanImages: done — deleted ${deleted}, kept ${kept} images`);
}

run();
