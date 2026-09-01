/**
 * Runs the real G6 migration against a real PostgreSQL server so the RPC's
 * behaviour can be executed rather than pattern-matched.
 *
 * Resolution order:
 *   1. G6_TEST_PG_SOCKET / G6_TEST_PG_PORT — an already-running server
 *   2. a temporary cluster this helper creates with initdb, when the
 *      environment allows it
 *   3. otherwise: unavailable, and the suite that uses it skips loudly
 *
 * The upstream objects the migration references (auth.users, clients, the
 * G1/G4/G5 tables) are created as a minimal faithful stub. The G6 migration
 * file itself is applied verbatim — it is never rewritten for the test.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PG_BIN_CANDIDATES = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/pgsql-16/bin']

function findPgBin() {
  if (process.env.G6_TEST_PG_BIN && fs.existsSync(process.env.G6_TEST_PG_BIN)) return process.env.G6_TEST_PG_BIN
  return PG_BIN_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'initdb'))) || null
}

function canRunAsPostgres() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false
  return spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).status === 0
}

export function startPostgres() {
  if (process.env.G6_TEST_PG_SOCKET) {
    return {
      socket: process.env.G6_TEST_PG_SOCKET,
      port: process.env.G6_TEST_PG_PORT || '5432',
      user: process.env.G6_TEST_PG_USER || 'postgres',
      stop() {},
    }
  }
  const pgBin = findPgBin()
  if (!pgBin || !canRunAsPostgres()) return null

  const root = fs.mkdtempSync(path.join('/var/tmp', 'g6pg-'))
  const dataDir = path.join(root, 'data')
  const socketDir = path.join(root, 'sock')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(socketDir)
  const port = String(50000 + (process.pid % 10000))
  const asPostgres = (command) => execFileSync('su', ['postgres', '-c', command], { encoding: 'utf8', stdio: 'pipe' })
  try {
    execFileSync('chown', ['-R', 'postgres:postgres', root])
    asPostgres(`${pgBin}/initdb -D ${dataDir} -U dw -A trust`)
    asPostgres(`${pgBin}/pg_ctl -D ${dataDir} -o "-k ${socketDir} -p ${port} -c listen_addresses=''" -l ${root}/server.log -w start`)
  } catch {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    return null
  }
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try { asPostgres(`${pgBin}/pg_ctl -D ${dataDir} -m immediate -w stop`) } catch { /* already gone */ }
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  // A crash before the suite's after-hook would otherwise leave a running
  // cluster and its data directory behind.
  process.once('exit', stop)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { stop(); process.exit(1) })
  }
  return { socket: socketDir, port, user: 'dw', stop }
}

/** Runs SQL and returns unaligned tuple output, or throws with the server error. */
export function sql(server, text, { database = 'postgres' } = {}) {
  const file = path.join('/var/tmp', `g6-${process.pid}-${Math.random().toString(16).slice(2)}.sql`)
  fs.writeFileSync(file, text)
  try { fs.chmodSync(file, 0o644) } catch { /* best effort */ }
  const pgBin = findPgBin()
  const args = ['-h', server.socket, '-p', server.port, '-U', server.user, '-d', database,
    '-v', 'ON_ERROR_STOP=1', '-tAq', '-f', file]
  const command = `${pgBin}/psql ${args.map((value) => `'${value}'`).join(' ')}`
  const result = canRunAsPostgres() && server.user === 'dw'
    ? spawnSync('su', ['postgres', '-c', command], { encoding: 'utf8' })
    : spawnSync(`${pgBin}/psql`, args, { encoding: 'utf8' })
  fs.rmSync(file, { force: true })
  if (result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || 'psql failed').trim())
    error.sqlFailed = true
    throw error
  }
  return result.stdout.trim()
}

/**
 * Minimal faithful stub of the upstream objects the G6 migration references.
 * It reproduces the tenant-composite unique keys G6's foreign keys need, and
 * an auth.uid() backed by a session setting so a tenant can be impersonated.
 */
export const UPSTREAM_STUB = `
-- Supabase provides these roles; a bare cluster does not.
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $roles$;

create schema if not exists auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $fn$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  unique (user_id, id)
);
create table public.company_brain_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  topic text not null,
  status text not null,
  revision integer not null default 0,
  unique (user_id, id)
);
create table public.company_brain_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  unique (user_id, id)
);
create table public.company_brain_source_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  status text not null default 'ACTIVE',
  unique (user_id, id)
);
create table public.company_brain_claim_roots (
  user_id uuid not null references auth.users(id),
  claim_id uuid not null,
  source_version_id uuid not null,
  primary key (user_id, claim_id, source_version_id),
  foreign key (user_id, claim_id) references public.company_brain_claims(user_id, id),
  foreign key (user_id, source_version_id) references public.company_brain_source_versions(user_id, id)
);
create table public.company_operating_model_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  model_fingerprint text not null,
  status text not null,
  unique (user_id, id)
);
create table public.company_brain_authority_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  status text not null default 'PROPOSED',
  unique (user_id, id)
);
create table public.company_brain_authority_grants_g5 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  status text not null default 'GRANTED',
  unique (user_id, id)
);
`
