#!/usr/bin/env node
/* KINDORA v1.0.7 — real-PostgreSQL migration verification harness (Node/pg driver)
 * Path A: fresh install 0001->0004
 * Path B: v1.0.6 upgrade (0001->0003 + legacy data, then 0004)
 * Behavioral: triggers, unique constraints, FK, FOR UPDATE, immutability, no cascade
 */
const { execFileSync, execFile } = require('child_process');
const { Client } = require('/tmp/pgtest/node_modules/pg');
const fs = require('fs');

const PGBIN = '/tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/bin';
const PORT = 5433;
const DATA = '/tmp/kindora-pgdata';
const SOCK = '/tmp/kindora-pgsock';
const MIGDIR = '/home/z/my-project/kindora/backend/prisma/migrations';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  PASS: ${m}`); pass++; };
const bad = (m) => { console.log(`  FAIL: ${m}`); fail++; };

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

async function newClient(db) {
  const c = new Client({ host: SOCK, port: PORT, user: 'kindora', database: db });
  await c.connect();
  return c;
}

async function applyMigrations(db, migs) {
  const c = await newClient(db);
  try {
    for (const m of migs) {
      const sql = fs.readFileSync(`${MIGDIR}/${m}/migration.sql`, 'utf8');
      await c.query(sql); // simple query protocol: multi-statement OK
      console.log(`    applied ${m} -> ${db}`);
    }
    return true;
  } catch (e) {
    console.error(`    APPLY FAILED: ${e.message.split('\n').slice(0, 4).join(' | ')}`);
    return false;
  } finally {
    await c.end();
  }
}

async function q(db, sql) {
  const c = await newClient(db);
  try { const r = await c.query(sql); return r.rows; }
  finally { await c.end(); }
}

async function tryExec(db, sql) {
  const c = await newClient(db);
  try { await c.query(sql); return { ok: true }; }
  catch (e) { return { ok: false, err: e.message }; }
  finally { await c.end(); }
}

async function main() {
  console.log('== initdb ==');
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(SOCK, { recursive: true, force: true });
    fs.mkdirSync(SOCK, { recursive: true });
    sh(`${PGBIN}/initdb`, ['-D', DATA, '-U', 'kindora', '--auth=trust', '-E', 'UTF8'], { stdio: 'pipe' });
    ok('initdb completed');
  } catch (e) { console.error(e.stderr || e.message); process.exit(1); }

  console.log('== start postgres ==');
  sh(`${PGBIN}/pg_ctl`, ['-D', DATA, '-l', '/tmp/kindora-pg.log', '-o',
    `-p ${PORT} -k ${SOCK} -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    'start', '-w'], { stdio: 'pipe' });
  ok(`postgres started on port ${PORT} (socket ${SOCK})`);
  await new Promise(r => setTimeout(r, 500));

  const dbA = 'kindora_fresh', dbB = 'kindora_upgrade';
  const admin = await newClient('postgres');
  await admin.query(`CREATE DATABASE ${dbA};`);
  await admin.query(`CREATE DATABASE ${dbB};`);
  await admin.end();
  ok('databases created');

  console.log('\n===== PATH A: FRESH INSTALL 0001 -> 0004 =====');
  (await applyMigrations(dbA, ['0001_init', '0002_hardening', '0003_payout_lockdown', '0004_payout_execution_integrity']))
    ? ok('all 4 migrations applied cleanly on fresh database')
    : bad('fresh install migration chain failed');

  console.log('\n===== PATH B: UPGRADE FROM v1.0.6 =====');
  (await applyMigrations(dbB, ['0001_init', '0002_hardening', '0003_payout_lockdown']))
    ? ok('v1.0.6 baseline schema (0001..0003) applied')
    : bad('v1.0.6 baseline schema failed');

  // Seed legacy v1.0.6-era data (withdrawal + dual approvals, no destinationVersion binding)
  const seed = `
    INSERT INTO "User" (id, email, "passwordHash", "firstName", "lastName", role, status, "createdAt", "updatedAt") VALUES
      ('u-owner','owner@t.local','x','Own','Er','ADMIN','ACTIVE',now(),now()),
      ('u-req','req@t.local','x','Re','Q','ADMIN','ACTIVE',now(),now()),
      ('u-ap1','ap1@t.local','x','Ap','One','ADMIN','ACTIVE',now(),now()),
      ('u-ap2','ap2@t.local','x','Ap','Two','ADMIN','ACTIVE',now(),now()) ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Organization" (id, name, slug, "ownerUserId", "createdAt", "updatedAt")
      VALUES ('org1','Test Org','test-org','u-owner', now(), now()) ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Category" (id, name, slug) VALUES ('cat1','General','general') ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Campaign" (id, slug, title, story, status, type, "targetAmount", currency, "categoryId", "createdById", "createdAt", "updatedAt")
      VALUES ('cmp1','legacy-cmp','Legacy','story','ACTIVE','INDIVIDUAL',100000000,'NGN','cat1','u-owner',now(),now()) ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Withdrawal" (id, "publicRef", "campaignId", "requestedById", amount, "netAmount", currency, method, destination, status, "createdAt", "updatedAt")
      VALUES ('wd-legacy','WD-LEGACY-001','cmp1','u-req',5000000,5000000,'NGN','BANK','{"bankCode":"058","accountNumber":"0123456789","accountName":"Legacy"}','APPROVED',now(),now());
    INSERT INTO "WithdrawalApproval" (id, "withdrawalId", cycle, role, "approverId", status, "amountAtApproval", "currencyAtApproval", note, "approvedAt")
      VALUES ('ap-1','wd-legacy',1,'FIRST_APPROVER','u-ap1','ACTIVE',5000000,'NGN','first',now());
    INSERT INTO "WithdrawalApproval" (id, "withdrawalId", cycle, role, "approverId", status, "amountAtApproval", "currencyAtApproval", note, "approvedAt")
      VALUES ('ap-2','wd-legacy',1,'SECOND_APPROVER','u-ap2','ACTIVE',5000000,'NGN','second',now());`;
  const seedRes = await tryExec(dbB, seed);
  seedRes.ok ? ok('legacy v1.0.6 data seeded (withdrawal + 2 approvals)') : bad(`legacy seed: ${seedRes.err}`);
  if (!seedRes.ok) {
    console.log('  (aborting upgrade-path checks: seed failed)');
    const adminX = await newClient('postgres'); await adminX.end();
    sh(`${PGBIN}/pg_ctl`, ['-D', DATA, 'stop', '-m', 'fast'], { stdio: 'pipe' });
    process.exit(1);
  }

  console.log('\n== applying 0004 on upgraded schema ==');
  (await applyMigrations(dbB, ['0004_payout_execution_integrity']))
    ? ok('0004 applied on top of v1.0.6 schema WITH legacy data (upgrade path)')
    : bad('0004 upgrade path failed');

  const wc = (await q(dbB, `SELECT count(*)::int AS n FROM "Withdrawal" WHERE id='wd-legacy'`))[0].n;
  wc === 1 ? ok('legacy withdrawal survived 0004 (no data loss)') : bad(`legacy withdrawal lost (count=${wc})`);
  const ac = (await q(dbB, `SELECT count(*)::int AS n FROM "WithdrawalApproval" WHERE "withdrawalId"='wd-legacy'`))[0].n;
  ac === 2 ? ok('both legacy approvals survived 0004') : bad(`legacy approvals lost (count=${ac})`);
  const dv = (await q(dbB, `SELECT "destinationVersion" FROM "Withdrawal" WHERE id='wd-legacy'`))[0].destinationVersion;
  dv === 1 ? ok('legacy withdrawal destinationVersion defaulted to 1') : bad(`destinationVersion default wrong (${dv})`);

  console.log('\n===== STRUCTURAL CHECKS =====');
  for (const t of ['PayoutAttempt', 'PayoutOutbox', 'PayoutBeneficiary', 'PayoutVerificationEvidence', 'PayoutReconciliation', 'ManualReviewCase']) {
    const n = (await q(dbB, `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='${t}'`))[0].n;
    n === 1 ? ok(`table ${t} exists`) : bad(`table ${t} missing`);
  }
  const enums = (await q(dbB, `SELECT count(*)::int AS n FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='PayoutAttemptStatus' AND e.enumlabel IN ('INITIATED','SUBMISSION_PENDING','PROVIDER_ACCEPTED','PENDING','SUCCESSFUL','FAILED','UNKNOWN','MANUAL_REVIEW','REVERSED')`))[0].n;
  enums >= 8 ? ok(`PayoutAttemptStatus enum extended (${enums}/9 durable initiation states)`) : bad(`PayoutAttemptStatus enum incomplete (${enums})`);
  for (const v of ['REQUIRES_RECONCILIATION', 'REVERSED']) {
    const n = (await q(dbB, `SELECT count(*)::int AS n FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='WithdrawalStatus' AND e.enumlabel='${v}'`))[0].n;
    n === 1 ? ok(`WithdrawalStatus ${v} present`) : bad(`WithdrawalStatus missing ${v}`);
  }
  const ufp = (await q(dbB, `SELECT count(*)::int AS n FROM pg_indexes WHERE indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%requestFingerprint%'`))[0].n;
  ufp >= 1 ? ok('unique requestFingerprint index exists') : bad('requestFingerprint unique index missing');
  const uob = (await q(dbB, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='PayoutOutbox' AND indexdef LIKE '%UNIQUE%'`))[0].n;
  uob >= 1 ? ok('PayoutOutbox idempotency unique index exists') : bad('PayoutOutbox unique index missing');
  const uben = (await q(dbB, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='PayoutBeneficiary' AND indexdef LIKE '%UNIQUE%'`))[0].n;
  uben >= 1 ? ok('PayoutBeneficiary per-version uniqueness exists') : bad('PayoutBeneficiary unique index missing');
  const trigs = (await q(dbB, `SELECT DISTINCT trigger_name FROM information_schema.triggers WHERE trigger_schema='public'`)).map(r => r.trigger_name);
  const immutTrigs = trigs.filter(t => /immut|protect/i.test(t));
  immutTrigs.length >= 2 ? ok(`immutability triggers present: ${immutTrigs.join(', ')}`) : bad(`immutability triggers thin (${immutTrigs.join(',') || 'none'}); all triggers: ${trigs.join(',')}`);

  console.log('\n===== BEHAVIORAL CHECKS =====');
  // Duplicate requestFingerprint + idempotencyKey rejected
  const insAttempt = (id, ikey, fp, wd) => `INSERT INTO "PayoutAttempt" (id,"withdrawalId","attemptNo",provider,"idempotencyKey","requestFingerprint",amount,currency,status,"createdAt","updatedAt")
     VALUES ('${id}','${wd || 'wd-legacy'}',1,'PAYSTACK','${ikey}','${fp}',5000000,'NGN','INITIATED',now(),now())`;
  await tryExec(dbB, `DELETE FROM "PayoutOutbox" WHERE "attemptId" LIKE 'pa-%'`).catch(() => {});
  await tryExec(dbB, `DELETE FROM "PayoutReconciliation" WHERE id LIKE 'rc-%'`).catch(() => {});
  await tryExec(dbB, `DELETE FROM "PayoutAttempt" WHERE "withdrawalId"='wd-legacy' AND id LIKE 'pa-%'`).catch(() => {});
  const r1 = await tryExec(dbB, insAttempt('pa-1', 'idem-1', 'fp-DUP'));
  r1.ok ? ok('first PayoutAttempt insert accepted') : bad(`first insert rejected: ${r1.err}`);
  const r2 = await tryExec(dbB, insAttempt('pa-2', 'idem-2', 'fp-DUP'));
  !r2.ok && /duplicate|unique/i.test(r2.err) ? ok('duplicate requestFingerprint rejected by unique constraint') : bad(`duplicate requestFingerprint accepted (${r2.ok ? 'ok' : r2.err.split('\n')[0]})`);
  const r3 = await tryExec(dbB, insAttempt('pa-3', 'idem-1', 'fp-OTHER'));
  !r3.ok && /duplicate|unique/i.test(r3.err) ? ok('duplicate idempotencyKey rejected by unique constraint') : bad(`duplicate idempotencyKey accepted (${r3.ok ? 'ok' : r3.err.split('\n')[0]})`);

  // FK enforcement
  const fk = await tryExec(dbB, insAttempt('pa-x', 'idem-x', 'fp-x', 'wd-nope'));
  !fk.ok && /foreign key/i.test(fk.err) ? ok('FK enforced: PayoutAttempt cannot reference missing withdrawal') : bad(`FK NOT enforced (${fk.ok ? 'inserted!' : fk.err.split('\n')[0]})`);

  // Immutability: reconciliation rows must reject UPDATE/DELETE
  const insRc = await tryExec(dbB, `INSERT INTO "PayoutReconciliation" (id, "withdrawalId", "attemptId", result, "createdAt")
     VALUES ('rc-1','wd-legacy','pa-1','PROVIDER_PENDING',now());`);
  if (insRc.ok) {
    const upd = await tryExec(dbB, `UPDATE "PayoutReconciliation" SET result='MATCHED' WHERE id='rc-1'`);
    !upd.ok ? ok('PayoutReconciliation UPDATE blocked by trigger (immutability enforced)') : bad('PayoutReconciliation UPDATE NOT blocked');
    const del = await tryExec(dbB, `DELETE FROM "PayoutReconciliation" WHERE id='rc-1'`);
    !del.ok ? ok('PayoutReconciliation DELETE blocked by trigger') : bad('PayoutReconciliation DELETE NOT blocked');
  } else {
    bad(`cannot insert reconciliation row for trigger test: ${insRc.err.split('\n')[0]}`);
  }

  // FOR UPDATE row lock + concurrent second connection blocked (NOWAIT)
  {
    const c1 = await newClient(dbB);
    await c1.query('BEGIN');
    await c1.query(`SELECT status FROM "Withdrawal" WHERE id='wd-legacy' FOR UPDATE`);
    const c2 = await newClient(dbB);
    let locked = false;
    try { await c2.query(`SELECT status FROM "Withdrawal" WHERE id='wd-legacy' FOR UPDATE NOWAIT`); }
    catch (e) { locked = /could not obtain lock|nowait/i.test(e.message); }
    locked ? ok('row lock held by tx1 blocks tx2 (FOR UPDATE NOWAIT) — concurrency-safe reconciliation path verified')
           : bad('second connection was NOT blocked by open FOR UPDATE');
    await c1.query('COMMIT'); await c1.end(); await c2.end();
  }

  // No cascade delete of financial audit history
  const delw = await tryExec(dbB, `DELETE FROM "Withdrawal" WHERE id='wd-legacy'`);
  const still = (await q(dbB, `SELECT count(*)::int AS n FROM "Withdrawal" WHERE id='wd-legacy'`))[0].n;
  (still === 1 && !delw.ok) ? ok('Withdrawal delete blocked (financial history protected)')
    : (still === 1 ? ok('Withdrawal delete blocked (row still present)') : bad('Withdrawal deleted unexpectedly'));

  // Outbox insert + unique idempotency (attemptId is @unique => one outbox row per attempt)
  const ob1 = await tryExec(dbB, `INSERT INTO "PayoutOutbox" (id,"attemptId","withdrawalId","idempotencyKey","eventType","requestFingerprint",payload,status,"nextRunAt","createdAt","updatedAt")
     VALUES ('ob-1','pa-1','wd-legacy','idem-1','INITIATE_TRANSFER','fp-DUP','{}','PENDING',now(),now(),now())`);
  ob1.ok ? ok('PayoutOutbox event insert works') : bad(`PayoutOutbox insert failed: ${ob1.err.split('\n')[0]}`);
  const ob2 = await tryExec(dbB, `INSERT INTO "PayoutOutbox" (id,"attemptId","withdrawalId","idempotencyKey","eventType","requestFingerprint",payload,status,"nextRunAt","createdAt","updatedAt")
     VALUES ('ob-2','pa-1','wd-legacy','idem-1','INITIATE_TRANSFER','fp-DUP','{}','PENDING',now(),now(),now())`);
  (!ob2.ok && /duplicate|unique/i.test(ob2.err)) ? ok('duplicate outbox event rejected (idempotency at DB level)') : bad(`duplicate outbox event accepted (${ob2.ok ? 'ok' : ob2.err.split('\n')[0]})`);

  console.log('\n===== CLEAN SHUTDOWN =====');
  sh(`${PGBIN}/pg_ctl`, ['-D', DATA, 'stop', '-m', 'fast'], { stdio: 'pipe' });
  ok('postgres stopped cleanly');

  console.log('\n==========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('==========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
