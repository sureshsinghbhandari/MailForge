/** Usage: ADMIN_EMAIL=you@example.com NEW_PASSWORD='…' npm run admin:reset-password */
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import { AuthService } from '../services/authService.js';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('../.env');
  } catch {
    /* optional */
  }
  const newPassword = process.env['NEW_PASSWORD'];
  if (!newPassword) throw new Error('Set NEW_PASSWORD in the environment (not on the command line, to keep it out of shell history).');
  const config = loadConfig();
  const db = await createDb(config.DATABASE_URL);
  const auth = new AuthService(db, config, createLogger('warn'));
  await auth.setPassword(config.ADMIN_EMAIL, newPassword);
  console.log(`Password updated for ${config.ADMIN_EMAIL}; existing sessions were revoked.`);
  await db.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
