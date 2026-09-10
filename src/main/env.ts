/**
 * Loads .env into process.env. Must be the FIRST import in main/index.ts —
 * ES module imports are evaluated in declaration order, so this guarantees the
 * env is populated before any other main-process module runs.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: join(app.getAppPath(), '.env') })
