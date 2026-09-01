import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';

test('reports the runner-provided isolated temporary root', async () => {
  const reportPath = process.env.KIOKUKO_TEST_TEMP_REPORT;
  if (reportPath === undefined) throw new Error('KIOKUKO_TEST_TEMP_REPORT is required');
  await writeFile(reportPath, os.tmpdir(), 'utf8');
});
