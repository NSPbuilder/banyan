/**
 * Loads .env.local and .env, and nothing else.
 *
 * Kept separate from ./env deliberately. ./env REPLACES DATABASE_URL with the
 * test database so no suite can reach the books — correct for a suite, wrong
 * for anything that is meant to act on the real database. `npm run db:migrate`
 * imported ./env and so migrated the test database while reporting success;
 * the books sat five migrations behind for as long as that guard existed.
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
config({ path: '.env', quiet: true })
