#!/usr/bin/env node
/**
 * Internal lead & unknown-app research script (not deployed to the site).
 * Reads store domains from a text file (one per line; blank lines & # comments ignored)
 * and prints CSV: store,status,will_break,unknown_domains
 *
 * Usage:
 *   node scripts/check-many.mjs stores.txt
 *   node scripts/check-many.mjs stores.txt > leads.csv
 *   node scripts/check-many.mjs stores.txt --out leads.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectStore } from '../netlify/functions/lib/checker.mjs';

const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCsvRow(fields) {
  return fields.map(csvCell).join(',');
}

export function parseStoreLines(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

export async function checkManyStores(domains, opts = {}) {
  const checkFn = opts.inspectStore || inspectStore;
  const delayMs = opts.delayMs ?? DELAY_MS;
  const onRow = opts.onRow;
  const rows = [];

  for (let i = 0; i < domains.length; i++) {
    const rawDomain = domains[i];
    const result = await checkFn(rawDomain, {
      ...(opts.checkerOpts || {}),
      includeUnknownDomains: true
    });
    const store = result.store || rawDomain;
    const status = result.status || 'unreachable';
    const willBreak = result.summary?.will_break || 0;
    const unknownDomains = Array.isArray(result.unknownDomains)
      ? result.unknownDomains.join('; ')
      : '';

    const row = {
      store,
      status,
      will_break: willBreak,
      unknown_domains: unknownDomains
    };
    rows.push(row);
    if (onRow) onRow(row);

    if (i < domains.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  let inputFile = '';
  let outFile = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' || args[i] === '-o') {
      outFile = args[++i] || '';
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/check-many.mjs <stores.txt> [--out results.csv]');
      process.exit(0);
    } else if (!inputFile) {
      inputFile = args[i];
    }
  }

  if (!inputFile) {
    console.error('Error: missing input file. Usage: node scripts/check-many.mjs <stores.txt>');
    process.exit(1);
  }

  const resolvedInput = path.resolve(process.cwd(), inputFile);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`Error: file not found: ${resolvedInput}`);
    process.exit(1);
  }

  const domains = parseStoreLines(fs.readFileSync(resolvedInput, 'utf8'));
  const header = formatCsvRow(['store', 'status', 'will_break', 'unknown_domains']);
  const csvLines = [header];

  if (!outFile) {
    process.stdout.write(`${header}\n`);
  }

  await checkManyStores(domains, {
    onRow: (row) => {
      const line = formatCsvRow([row.store, row.status, row.will_break, row.unknown_domains]);
      csvLines.push(line);
      if (!outFile) {
        process.stdout.write(`${line}\n`);
      }
      process.stderr.write(`[checked] ${row.store} -> ${row.status} (${row.will_break} will break)\n`);
    }
  });

  if (outFile) {
    const resolvedOut = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(resolvedOut, `${csvLines.join('\n')}\n`, 'utf8');
    process.stderr.write(`Wrote ${domains.length} rows to ${resolvedOut}\n`);
  }
}

const isCliEntry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCliEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

