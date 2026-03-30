// File: qwen-scripts/apply-newsletter-migration.js
// Purpose: Apply newsletter_subscribers table migration to Supabase database
// Usage: node qwen-scripts/apply-newsletter-migration.js

import { Client } from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file manually - DO NOT use system env vars
const envPath = resolve(__dirname, '..', '.env');
const envContent = readFileSync(envPath, 'utf-8');

// Parse .env file - only from file, not system env
const envVars = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  // Skip comments and empty lines
  if (trimmed && !trimmed.startsWith('#')) {
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      envVars[key] = value;
    }
  }
});

// Get database URL ONLY from .env file
const databaseUrl = envVars.SUPABASE_DB_URL;

if (!databaseUrl) {
  console.error('Error: SUPABASE_DB_URL not found in .env file');
  process.exit(1);
}

// Mask password for logging
const maskedUrl = databaseUrl.replace(/:[^:@]+@/, ':****@');
console.log(`Using database URL from .env: ${maskedUrl}`);

// Read migration SQL file
const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '20260329_create_newsletter_subscribers.sql');
const migrationSql = readFileSync(migrationPath, 'utf-8');

async function applyMigration() {
  const client = new Client({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false // Required for Supabase
    }
  });

  try {
    console.log('Connecting to Supabase database...');
    await client.connect();
    console.log('Connected successfully');

    console.log('Applying migration: 20260329_create_newsletter_subscribers');
    await client.query(migrationSql);
    console.log('Migration applied successfully!');

    // Verify table was created
    const result = await client.query(`
      SELECT table_name, table_schema 
      FROM information_schema.tables 
      WHERE table_name = 'newsletter_subscribers'
    `);

    if (result.rows.length > 0) {
      console.log('✓ Table "newsletter_subscribers" verified in database');
    } else {
      console.error('✗ Table "newsletter_subscribers" was not created');
      process.exit(1);
    }

    // Verify RLS is enabled
    const rlsResult = await client.query(`
      SELECT relname, relrowsecurity 
      FROM pg_class 
      WHERE relname = 'newsletter_subscribers'
    `);

    if (rlsResult.rows[0]?.relrowsecurity) {
      console.log('✓ Row Level Security (RLS) is enabled');
    } else {
      console.error('✗ Row Level Security (RLS) is not enabled');
      process.exit(1);
    }

    // Verify policies
    const policyResult = await client.query(`
      SELECT policyname, cmd 
      FROM pg_policies 
      WHERE tablename = 'newsletter_subscribers'
    `);

    console.log(`✓ Created ${policyResult.rows.length} RLS policy/policies`);
    policyResult.rows.forEach(row => {
      console.log(`  - ${row.policyname} (${row.cmd})`);
    });

    // Verify unique index
    const indexResult = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'newsletter_subscribers' AND indexname LIKE '%unique%'
    `);

    if (indexResult.rows.length > 0) {
      console.log('✓ Unique index on email_normalized verified');
    }

  } catch (error) {
    console.error('Error applying migration:', error.message);
    process.exit(1);
  } finally {
    await client.end();
    console.log('Database connection closed');
  }
}

applyMigration();
