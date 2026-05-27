import { readFileSync } from 'fs';
import { join } from 'path';
import { db, schema } from '../src/db';
import { eq } from 'drizzle-orm';

const ROOT = '/opt/automations/inbound/linkedin-jobs';
const updates = [
  { key: 'linkedin_jobs.lead.aj', file: 'lead-prompt-aj.md' },
  { key: 'linkedin_jobs.lead.pk', file: 'lead-prompt-pk.md' },
];

for (const { key, file } of updates) {
  const content = readFileSync(join(ROOT, 'config', file), 'utf-8');
  const result = await db.update(schema.contentPrompts)
    .set({ content, updatedAt: new Date() })
    .where(eq(schema.contentPrompts.promptName, key))
    .returning({ name: schema.contentPrompts.promptName });
  console.log('updated', key, '→', result.length, 'rows,', content.length, 'chars');
}
process.exit(0);
